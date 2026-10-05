import { StructuredError, type EmbeddingModel } from "@/domain/contracts";
import { EMBEDDING_PREPROCESSING_VERSION } from "@/index/Identity";
import { diagnosticsEnabled } from "@/diagnostics/TramaDiagnostics";
import {
  SQLITE_MAX_SEMANTIC_BATCH_ITEMS,
  SQLITE_MAX_SEMANTIC_INPUT_BYTES,
  SQLITE_MAX_SEMANTIC_VECTOR_BYTES,
  type SqliteSemanticCommitResult,
  type SqliteSemanticWorkBatch,
  type SqliteState,
} from "@/index/sqlite/protocol";
import { SemanticProviderError, type SemanticPrepareResult } from "./contracts";
import { IndexJournal } from "./journal";
import { check, IndexRuntime } from "./runtime";

export class SemanticCoordinator {
  private semanticRebuildInProgress = false;

  constructor(
    private readonly runtime: IndexRuntime,
    private readonly journal: IndexJournal,
    private readonly embedding: EmbeddingModel
  ) {}
  /** Enriches the lexical corpus in bounded, resumable batches. */
  async prepareSemantic(
    signal: AbortSignal,
    shouldYield?: () => boolean
  ): Promise<SemanticPrepareResult> {
    const result = await this.runSemanticPreparation(
      signal,
      Number.POSITIVE_INFINITY,
      undefined,
      shouldYield
    );
    if (result.converged) this.semanticRebuildInProgress = false;
    return result;
  }

  /** True only while this manager has usable stored vectors for its current embedding identity. */
  hasCompatibleSemanticVectors(): boolean {
    const state = this.runtime.state;
    return Boolean(this.runtime.loaded && state && state.semanticHeadCount > 0);
  }

  /** True when the configured embedding provider has semantic work awaiting storage or promotion. */
  hasPendingSemanticWork(): boolean {
    const state = this.runtime.state;
    if (
      !this.runtime.loaded ||
      !state ||
      !state.embeddingFingerprint ||
      !this.runtime.fingerprint.modelId.trim()
    )
      return false;
    return state.semanticMissingCount > 0 || state.semanticLagCount > 0;
  }

  async rebuildSemantic(
    signal: AbortSignal,
    shouldYield?: () => boolean
  ): Promise<SemanticPrepareResult> {
    if (!this.semanticRebuildInProgress) {
      await this.runtime.waitForMaintenance(signal);
      if (!this.runtime.loaded) await this.runtime.load();
      this.runtime.setState(
        (await this.runtime.ensureClient().call("clearSemanticCache", {}, signal)) as SqliteState
      );
      this.semanticRebuildInProgress = true;
    }
    const result = await this.prepareSemantic(signal, shouldYield);
    return { ...result, operation: "rebuild" };
  }

  /** Fills the content-addressed semantic cache for active lexical heads. */
  async prepareSemanticCacheBatch(signal: AbortSignal): Promise<SemanticPrepareResult> {
    return this.runSemanticPreparation(
      signal,
      1,
      Math.min(16, this.runtime.options.prepareBatchSize ?? 16)
    );
  }

  async promoteCachedSemantic(signal: AbortSignal): Promise<SemanticPrepareResult> {
    if (!this.runtime.loaded) await this.runtime.load();
    const state = this.runtime.state;
    if (!state) throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
    if (!state.embeddingFingerprint)
      return {
        operation: "prepare",
        changed: false,
        converged: true,
        state,
        stored: 0,
        skipped: 0,
      };
    return this.runSemanticPreparation(signal, 1, 0, undefined, true);
  }

  private async runSemanticPreparation(
    signal: AbortSignal,
    maxBatches = Number.POSITIVE_INFINITY,
    batchSizeOverride?: number,
    shouldYield?: () => boolean,
    cacheOnly = false
  ): Promise<SemanticPrepareResult> {
    await this.runtime.waitForMaintenance(signal);
    if (this.runtime.building || this.runtime.preparing)
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    check(signal);
    this.runtime.preparing = true;
    let stored = 0;
    let skipped = 0;
    let promoted = 0;
    let hasMore = true;
    const operation = "incremental";
    const started = diagnosticsEnabled(this.runtime.diagnostics, "detailed")
      ? Date.now()
      : undefined;
    const overallTimer = this.runtime.performanceTimer();
    const initialRevision = this.journal.revision;
    try {
      if (!this.runtime.loaded) await this.runtime.load();
      if (this.runtime.unavailable || !this.runtime.state)
        throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
      const overallOperationId = overallTimer
        ? this.runtime.ensureClient().diagnosticOperationId()
        : undefined;
      const embeddingFingerprint = this.runtime.state.embeddingFingerprint;
      const providerLimits = this.embedding.batchLimits ?? {};
      const maxInputBytes = Math.min(
        SQLITE_MAX_SEMANTIC_INPUT_BYTES,
        Math.max(1, Math.floor(providerLimits.maxInputBytes ?? SQLITE_MAX_SEMANTIC_INPUT_BYTES))
      );
      const maxVectorBytes = Math.min(
        SQLITE_MAX_SEMANTIC_VECTOR_BYTES,
        Math.max(
          this.embedding.dimensions * Float32Array.BYTES_PER_ELEMENT,
          Math.floor(providerLimits.maxVectorBytes ?? SQLITE_MAX_SEMANTIC_VECTOR_BYTES)
        )
      );
      const requestedItems = Math.min(
        SQLITE_MAX_SEMANTIC_BATCH_ITEMS,
        cacheOnly
          ? 0
          : Math.max(
              1,
              Math.floor(batchSizeOverride ?? this.runtime.options.prepareBatchSize ?? 128)
            ),
        Math.max(1, Math.floor(providerLimits.maxItems ?? SQLITE_MAX_SEMANTIC_BATCH_ITEMS)),
        Math.max(1, Math.floor(maxVectorBytes / (this.embedding.dimensions * 4)))
      );
      const totalMissing = Math.max(
        this.runtime.state.semanticMissingCount,
        this.runtime.state.semanticEligibleCount,
        this.runtime.state.chunkCount - this.runtime.state.compatibleVectorCount
      );
      this.runtime.reportProgress({
        operation,
        phase: "build-vector",
        completed: 0,
        total: totalMissing,
        unit: "chunks",
        determinate: true,
      });
      let batches = 0;
      // The unrestricted promotion pass is a run-level operation. Repeat it
      // only after a lexical generation change can make another lagging head
      // eligible; each result commit already promotes its affected notes.
      let promotedLexicalGeneration: number | undefined;
      for (;;) {
        if (batches >= maxBatches) break;
        check(signal);
        const prepareTimer = this.runtime.performanceTimer();
        const prepareClient = this.runtime.ensureClient();
        const prepareOperationId = prepareTimer ? prepareClient.diagnosticOperationId() : undefined;
        const work = (await prepareClient.call(
          "prepareSemanticWork",
          {
            embeddingFingerprint,
            preprocessing: EMBEDDING_PREPROCESSING_VERSION,
            limit: requestedItems,
            maxInputBytes,
            promoteUnrestricted: promotedLexicalGeneration === undefined,
          },
          signal,
          {
            diagnosticOperationId: prepareOperationId,
            diagnosticParentOperationId: overallOperationId,
            diagnosticBatchId: prepareOperationId,
          }
        )) as SqliteSemanticWorkBatch;
        this.runtime.emitPhase(
          "semantic",
          "prepareRpc",
          prepareTimer,
          work.requests.length,
          undefined,
          prepareOperationId,
          overallOperationId,
          prepareOperationId
        );
        promoted += work.promoted;
        hasMore = work.hasMore;
        promotedLexicalGeneration = work.generation.lexicalGeneration;
        if (!work.requests.length) break;
        const missing = work.requests;
        const providerTimer = this.runtime.performanceTimer();
        let vectors: readonly number[][];
        try {
          vectors = await this.embedding.embed(
            missing.map((item) => item.serialization),
            signal,
            (progress) =>
              this.runtime.reportProgress(
                {
                  operation,
                  phase: "build-vector",
                  completed: stored + progress.completed,
                  total: Math.max(totalMissing, stored + missing.length),
                  unit: "chunks",
                  determinate: true,
                },
                false
              )
          );
        } catch (error) {
          if (signal.aborted) throw error;
          throw new SemanticProviderError(error);
        }
        this.runtime.emitPhase(
          "semantic",
          "provider",
          providerTimer,
          missing.length,
          undefined,
          prepareOperationId,
          overallOperationId,
          prepareOperationId
        );
        check(signal);
        if (
          vectors.length !== missing.length ||
          vectors.some((vector) => vector.length !== this.embedding.dimensions)
        )
          throw new StructuredError(
            "internal",
            "Embedding dimensions changed during preparation.",
            false
          );
        const conversionTimer = this.runtime.performanceTimer();
        const converted = missing.map((item, index) => ({
          actionKey: item.actionKey,
          inputId: item.inputId,
          serialization: item.serialization,
          vector: new Float32Array(vectors[index]),
        }));
        if (conversionTimer)
          this.runtime.emitPhase(
            "semantic",
            "vectorConversion",
            conversionTimer,
            converted.length,
            converted.reduce((bytes, item) => bytes + item.vector.byteLength, 0),
            prepareOperationId,
            overallOperationId,
            prepareOperationId
          );
        const commitTimer = this.runtime.performanceTimer();
        const commitClient = this.runtime.ensureClient();
        const commitOperationId = commitTimer ? commitClient.diagnosticOperationId() : undefined;
        const result = (await commitClient.call(
          "commitSemanticResults",
          {
            embeddingFingerprint,
            preprocessing: EMBEDDING_PREPROCESSING_VERSION,
            dimensions: this.embedding.dimensions,
            expectedCount: missing.length,
            results: converted,
          },
          signal,
          {
            diagnosticOperationId: commitOperationId,
            diagnosticParentOperationId: overallOperationId,
            diagnosticBatchId: prepareOperationId,
          }
        )) as SqliteSemanticCommitResult;
        this.runtime.emitPhase(
          "semantic",
          "commitRpc",
          commitTimer,
          result.stored,
          undefined,
          commitOperationId,
          overallOperationId,
          prepareOperationId
        );
        stored += result.stored;
        skipped += result.skipped;
        promoted += result.promoted;
        hasMore = result.hasMore;
        if (result.generation.lexicalGeneration !== promotedLexicalGeneration)
          promotedLexicalGeneration = undefined;
        batches++;
        // A changed corpus invalidates the pagination fence. Restarting from
        // zero makes preparation resumable without ever attaching stale rows.
        this.runtime.reportProgress(
          {
            operation,
            phase: "build-vector",
            completed: hasMore ? stored : Math.max(1, result.stored),
            total: hasMore ? Math.max(totalMissing, stored) : Math.max(1, result.stored),
            unit: "chunks",
            determinate: true,
          },
          false
        );
        if (shouldYield?.()) break;
        if (!hasMore) break;
      }
      // Full state is intentionally refreshed only when this executor converges
      // or yields its bounded slice. Cache-only commits therefore do not publish.
      this.runtime.setState(
        (await this.runtime.ensureClient().call("getState", {}, signal)) as SqliteState
      );
      const finalState = this.runtime.state!;
      const result: SemanticPrepareResult = {
        operation: "prepare",
        changed: promoted > 0,
        converged: !hasMore && this.journal.revision === initialRevision,
        state: finalState,
        stored,
        skipped,
      };
      if (result.converged) this.runtime.notifySuccessfulOperation(result);
      this.runtime.emitPhase(
        "semantic",
        "overall",
        overallTimer,
        stored,
        undefined,
        overallOperationId
      );
      if (diagnosticsEnabled(this.runtime.diagnostics, "detailed"))
        this.runtime.emit({
          area: "index",
          event: "index_operation",
          operation,
          stage: "completed",
          phase: "build-vector",
          durationMs: started === undefined ? 0 : Date.now() - started,
          counts: { stored, skipped, promoted },
        });
      return result;
    } catch (error) {
      // State is refreshed after failure/cancellation so callers retain the
      // committed portion of a bounded operation.
      try {
        this.runtime.setState(
          (await this.runtime.ensureClient().call("getState", {})) as SqliteState
        );
      } catch {
        /* Preserve the original operation error. */
      }
      throw error;
    } finally {
      this.runtime.preparing = false;
    }
  }
}
