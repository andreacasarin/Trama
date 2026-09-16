import {
  StructuredError,
  type EmbeddingModel,
  type IndexCapabilities,
  type IndexFreshness,
  type IndexProgress,
  type ProvenanceRecord,
} from "@/domain/contracts";
import type { VaultSearchPort } from "@/tools/ToolRegistry";
import {
  CHUNK_ALGORITHM_VERSION,
  CHUNK_OVERLAP,
  CHUNK_SIZE,
  EXTRACTION_VERSION,
  INDEX_SCHEMA_VERSION,
  chunkMarkdown,
} from "@/index/chunking";
import {
  compareCodeUnits,
  corpusIdentityInput,
  deriveNoteContentId,
  embeddingIdentityInput,
  indexIdentity,
  isPathExcluded,
  normalizeEmbeddingEndpoint,
  normalizeVaultPath,
  sha256Hex,
} from "@/index/Identity";
import { SQLITE_BUILD_IDENTITY } from "@/build/identity";
import { SqliteWorkerClient, type SqliteWorkerLike } from "@/index/sqlite/client";
import {
  SQLITE_SNAPSHOT_MAX_BYTES,
  sqliteError,
  type SqliteHit,
  type SqliteNoteInput,
  type SqliteState,
  type SqliteNoteSummary,
  type SqliteReconciliationPlan,
  type SqliteMutationResult,
  type MissingVector,
  type PublicationInspection,
  type PublicationPrepared,
} from "@/index/sqlite/protocol";
import {
  NOOP_TRAMA_DIAGNOSTICS,
  emitTramaDiagnostic,
  projectDiagnosticError,
  type TramaDiagnosticRecord,
  type TramaDiagnostics,
} from "@/diagnostics/TramaDiagnostics";
import type { RetrievalResult } from "@/index/retrieval/contracts";
import { QueryEmbeddingError } from "@/index/retrieval/QueryEmbeddingError";
import { lexicalIndex, semanticIndex } from "@/index/IndexChannel";

export interface IndexVaultDocument {
  readonly path: string;
  readonly content: string;
  readonly revision?: string;
}
export interface IndexVaultPort {
  listMarkdownPaths(signal: AbortSignal): Promise<readonly string[]>;
  readMarkdown(path: string, signal: AbortSignal): Promise<IndexVaultDocument>;
  isIndexEligible?(path: string): boolean;
  isMarkdownAvailable?(path: string, signal: AbortSignal): Promise<boolean>;
  estimateMarkdownTextCount?(
    paths: readonly string[],
    chunkSize: number,
    overlap: number,
    signal: AbortSignal
  ): Promise<number | undefined>;
}
export interface IndexFingerprint {
  readonly embeddingBaseUrl: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly excludedPaths: readonly string[];
  readonly effectiveExcludedPaths?: readonly string[];
  readonly chunking: {
    readonly algorithmVersion: number;
    readonly size: number;
    readonly overlap: number;
  };
  readonly extractionVersion: number;
  readonly schemaVersion: number;
  readonly corpusFingerprint?: string;
  readonly embeddingFingerprint?: string;
}
export interface RelatedIndexHit {
  readonly path: string;
  readonly score: number;
  readonly similarity?: number;
  readonly excerpt?: string;
  readonly startLine?: number;
  readonly endLine?: number;
}
export interface RelatedIndexState {
  readonly changeCounter?: number;
  readonly generationId?: string;
  readonly currentPath: string;
  readonly contentHash: string;
  readonly semantic?: IndexCapabilities["semantic"];
  readonly freshness?: IndexFreshness;
  readonly publicationId?: string;
}
interface FullIndexPlan {
  readonly paths: readonly string[];
  readonly estimatedTexts?: number;
}
export interface SnapshotDataAdapter {
  exists?(path: string): Promise<boolean>;
  read?(path: string): Promise<string>;
  mkdir?(path: string): Promise<void>;
  readBinary?(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, value: ArrayBuffer): Promise<void>;
  write?(path: string, value: string): Promise<void>;
}
export interface IndexSyncResult {
  readonly changed: boolean;
  readonly converged: boolean;
}
export type IndexOperationName = "build" | "update" | "rebuild" | "prepare";
export interface IndexOperationResult {
  readonly operation: IndexOperationName;
  readonly changed: boolean;
  readonly converged: boolean;
  readonly state: SqliteState;
}
export interface SemanticPrepareResult extends IndexOperationResult {
  readonly stored: number;
  readonly skipped: number;
}

export function createIndexFingerprint(
  embeddingBaseUrl: string,
  modelId: string,
  dimensions: number,
  options: {
    readonly size?: number;
    readonly overlap?: number;
    readonly excludedPaths?: readonly string[];
    readonly publicationDirectory?: string;
  } = {}
): IndexFingerprint {
  const excludedPaths = options.excludedPaths ?? [];
  const effectiveExcludedPaths = [
    ...excludedPaths,
    ...(options.publicationDirectory ? [options.publicationDirectory] : []),
  ];
  return {
    embeddingBaseUrl: normalizeEmbeddingEndpoint(embeddingBaseUrl),
    modelId,
    dimensions,
    excludedPaths: Object.freeze(
      [...new Set(excludedPaths.map(normalizePath))].sort(compareCodeUnits)
    ),
    effectiveExcludedPaths: Object.freeze(
      [...new Set(effectiveExcludedPaths.map(normalizePath))].sort(compareCodeUnits)
    ),
    chunking: {
      algorithmVersion: CHUNK_ALGORITHM_VERSION,
      size: options.size ?? CHUNK_SIZE,
      overlap: options.overlap ?? CHUNK_OVERLAP,
    },
    extractionVersion: EXTRACTION_VERSION,
    schemaVersion: INDEX_SCHEMA_VERSION,
  };
}
function normalizePath(path: string): string {
  return normalizeVaultPath(path);
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw new StructuredError("cancelled", "Index operation cancelled.", true);
}
function sameSummaries(a: readonly SqliteNoteSummary[], b: readonly SqliteNoteSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++)
    if (a[index].path !== b[index].path || a[index].contentId !== b[index].contentId) return false;
  return true;
}
function isPersistedSnapshotLoaded(state: SqliteState): boolean {
  const persisted = state as SqliteState & {
    readonly snapshotLoaded?: boolean;
    readonly snapshot_loaded?: boolean;
  };
  return persisted.snapshotLoaded === true || persisted.snapshot_loaded === true;
}
export class IndexManager implements VaultSearchPort {
  private client?: SqliteWorkerClient;
  private state?: SqliteState;
  private loaded = false;
  private unavailable = false;
  private building = false;
  private maintenance = false;
  private preparing = false;
  private freshness: IndexFreshness = "unknown";
  private loadPromise?: Promise<boolean>;
  private buildPromise?: Promise<void>;
  private revision = 0;
  private reconciledRevision = 0;
  private readonly onProgress?: (progress: IndexProgress) => void;
  private readonly workerFactory?: () => SqliteWorkerLike;
  private readonly worker?: SqliteWorkerLike;

  constructor(
    private readonly vault: IndexVaultPort,
    private readonly embedding: EmbeddingModel,
    storage: object,
    private readonly embeddingBaseUrl: string,
    private readonly modelId: string,
    private readonly options: {
      readonly size?: number;
      readonly overlap?: number;
      readonly excludedPaths?: readonly string[];
      readonly publicationDirectory?: string;
      readonly prepareBatchSize?: number;
      readonly isIndexEligible?: (path: string) => boolean;
      readonly onProgress?: (progress: IndexProgress) => void;
      readonly worker?: SqliteWorkerLike;
      readonly workerFactory?: () => SqliteWorkerLike;
      readonly sqliteIdentity?: string | Promise<string>;
      readonly sqliteClient?: SqliteWorkerClient;
      readonly onSuccessfulOperation?: (result: IndexOperationResult) => void | Promise<void>;
      readonly onOperationSuccess?: (result: IndexOperationResult) => void | Promise<void>;
    } = {},
    private readonly diagnostics: TramaDiagnostics = NOOP_TRAMA_DIAGNOSTICS
  ) {
    this.worker = options.worker;
    this.workerFactory = options.workerFactory;
    this.onProgress = options.onProgress;
  }

  fingerprint(): IndexFingerprint {
    return createIndexFingerprint(
      this.embeddingBaseUrl,
      this.modelId,
      this.embedding.dimensions,
      this.options
    );
  }
  private async corpusFingerprintId(): Promise<string> {
    const fp = this.fingerprint();
    return sha256Hex(
      corpusIdentityInput({
        schemaVersion: fp.schemaVersion,
        extractionVersion: fp.extractionVersion,
        chunking: fp.chunking,
        excludedPaths: fp.effectiveExcludedPaths ?? fp.excludedPaths,
      })
    );
  }
  private async embeddingFingerprintId(): Promise<string> {
    const fp = this.fingerprint();
    return sha256Hex(
      embeddingIdentityInput({
        embeddingBaseUrl: fp.embeddingBaseUrl,
        modelId: fp.modelId,
        dimensions: fp.dimensions,
        preprocessingVersion: "normalized-float32-v1",
      })
    );
  }
  private ensureClient(): SqliteWorkerClient {
    if (!this.client) {
      if (this.options.sqliteClient) {
        this.client = this.options.sqliteClient;
        return this.client;
      }
      let worker = this.worker;
      if (!worker && this.workerFactory) {
        try {
          worker = this.workerFactory();
        } catch {
          throw sqliteError(
            "storage_unavailable",
            "SQLite Worker could not be started. Ensure the bundled SQLite assets are installed.",
            true
          );
        }
      }
      this.client = new SqliteWorkerClient(worker);
    }
    return this.client;
  }
  private changeCounter(): number {
    return this.state?.changeCounter ?? 0;
  }
  private generationId(): string {
    return indexIdentity(this.changeCounter());
  }
  private setState(state: SqliteState): void {
    this.state = state;
    if (state.incomplete) this.freshness = "unknown";
  }
  isBuilding(): boolean {
    return this.building;
  }
  isInMaintenance(): boolean {
    return this.maintenance;
  }
  isComplete(): boolean {
    return this.state?.incomplete === false;
  }
  getCapabilities(): IndexCapabilities {
    const state = this.state;
    const available = this.loaded && !this.unavailable;
    return {
      availability: available ? "available" : "unavailable",
      lexical: lexicalIndex.status(state, available, this.building),
      semantic: semanticIndex.status(state, available, this.preparing),
      freshness: this.freshness,
      ...(state?.publicationId ? { publicationId: state.publicationId } : {}),
    };
  }
  capabilities(): IndexCapabilities {
    return this.getCapabilities();
  }
  isSemanticReady(): boolean {
    return this.getCapabilities().semantic.searchable;
  }
  freshnessState(): IndexFreshness {
    return this.freshness;
  }
  hasUsableIndex(): boolean {
    return (
      !this.unavailable && !this.maintenance && this.loaded && (this.state?.noteCount ?? 0) > 0
    );
  }
  async getState(): Promise<SqliteState | undefined> {
    if (!this.loaded) await this.load();
    return this.state;
  }

  async load(options: { readonly emitDiagnostics?: boolean } = {}): Promise<boolean> {
    if (!this.loadPromise) this.loadPromise = this.loadPersisted(options.emitDiagnostics === true);
    return this.loadPromise;
  }
  private async loadPersisted(emit: boolean): Promise<boolean> {
    const started = Date.now();
    const observable = emit || this.diagnostics !== NOOP_TRAMA_DIAGNOSTICS;
    if (observable)
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "load",
        stage: "started",
        phase: "boot",
      });
    try {
      const sqliteIdentity = await (this.options.sqliteIdentity ?? "default-vault");
      const state = await this.ensureClient().call("boot", {
        corpusFingerprint: await this.corpusFingerprintId(),
        embeddingFingerprint: await this.embeddingFingerprintId(),
        buildIdentity: SQLITE_BUILD_IDENTITY,
        dimensions: this.embedding.dimensions,
        identity: await sha256Hex(sqliteIdentity),
      });
      this.setState(state as SqliteState);
      this.freshness = isPersistedSnapshotLoaded(state as SqliteState)
        ? "snapshot-loaded"
        : state.incomplete
          ? "unknown"
          : "locally-reconciled";
      this.unavailable = false;
      if (observable)
        this.emit({
          area: "index",
          event: "index_operation",
          operation: "load",
          stage: "completed",
          phase: "boot",
          durationMs: Date.now() - started,
          generation: this.generationId(),
          counts: { notes: this.state!.noteCount, chunks: this.state!.chunkCount },
        });
      return true;
    } catch (error) {
      this.unavailable = true;
      if (observable)
        this.emit({
          area: "index",
          event: "index_operation",
          operation: "load",
          stage: "failed",
          durationMs: Date.now() - started,
          error: projectDiagnosticError(error),
        });
      return false;
    } finally {
      this.loaded = true;
    }
  }

  async build(signal: AbortSignal): Promise<void> {
    if (this.maintenance)
      throw new StructuredError("busy", "Index maintenance is in progress.", true);
    if (this.building) throw new StructuredError("busy", "Index rebuild is already running.", true);
    const run = this.buildInternal(signal);
    this.buildPromise = run;
    try {
      await run;
    } finally {
      if (this.buildPromise === run) this.buildPromise = undefined;
    }
  }
  async waitForBuild(): Promise<void> {
    await this.buildPromise;
  }
  private async buildInternal(signal: AbortSignal): Promise<void> {
    check(signal);
    this.building = true;
    const started = Date.now();
    try {
      if (!this.loaded) await this.load();
      const plan = await this.planFullIndex(signal);
      this.setState((await this.ensureClient().call("beginRebuild", {}, signal)) as SqliteState);
      this.reportProgress({
        operation: "full",
        phase: "discover",
        completed: plan.paths.length,
        total: plan.paths.length,
        unit: "paths",
        determinate: true,
      });
      this.reportProgress({
        operation: "full",
        phase: "read",
        completed: plan.paths.length,
        total: plan.paths.length,
        unit: "notes",
        determinate: true,
        estimated: true,
      });
      this.reportProgress({
        operation: "full",
        phase: "chunk",
        completed: 0,
        ...(plan.estimatedTexts === undefined ? {} : { total: plan.estimatedTexts }),
        unit: "texts",
        determinate: plan.estimatedTexts !== undefined,
        estimated: plan.estimatedTexts !== undefined,
      });
      let encoded = 0;
      for await (const note of this.noteInputs(plan, signal)) {
        check(signal);
        const result = (await this.ensureClient().call("upsertNote", { note }, signal)) as {
          state: SqliteState;
        };
        this.setState(result.state);
        encoded++;
        this.reportProgress({
          operation: "full",
          phase: "encode-write",
          completed: encoded,
          total: plan.paths.length,
          unit: "artifacts",
          determinate: true,
          generationId: this.generationId(),
        });
      }
      const finalWatermark = this.revision;
      const exact = await this.discoverEligible(signal);
      await this.finishIfStable(exact, signal, finalWatermark);
      this.reportProgress({
        operation: "full",
        phase: "validate",
        completed: 1,
        total: 1,
        unit: "artifacts",
        determinate: true,
        generationId: this.generationId(),
      });
      const finalState = this.state;
      if (finalState && !finalState.incomplete)
        this.notifySuccessfulOperation({
          operation: "rebuild",
          changed: true,
          converged: true,
          state: finalState,
        });
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "build",
        stage: "completed",
        durationMs: Date.now() - started,
        generation: this.generationId(),
        counts: {
          notes: finalState?.noteCount ?? 0,
          chunks: finalState?.chunkCount ?? 0,
          incomplete: finalState?.incomplete ? 1 : 0,
        },
      });
    } catch (error) {
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "build",
        stage: signal.aborted ? "cancelled" : "failed",
        durationMs: Date.now() - started,
        error: projectDiagnosticError(error),
      });
      throw error;
    } finally {
      this.building = false;
    }
  }
  private async planFullIndex(signal: AbortSignal): Promise<FullIndexPlan> {
    const paths = [...(await this.vault.listMarkdownPaths(signal))]
      .map(normalizePath)
      .filter((path) => this.isIndexEligible(path))
      .sort(compareCodeUnits);
    const estimatedTexts = await this.vault.estimateMarkdownTextCount?.(
      paths,
      this.options.size ?? CHUNK_SIZE,
      this.options.overlap ?? CHUNK_OVERLAP,
      signal
    );
    return { paths, ...(estimatedTexts === undefined ? {} : { estimatedTexts }) };
  }
  private async *noteInputs(
    plan: FullIndexPlan,
    signal: AbortSignal
  ): AsyncIterable<SqliteNoteInput> {
    const fingerprint = await this.corpusFingerprintId();
    let chunked = 0;
    const estimate = (completed: number) =>
      plan.estimatedTexts !== undefined && completed <= plan.estimatedTexts
        ? { total: plan.estimatedTexts, determinate: true as const, estimated: true }
        : { determinate: false as const };
    this.reportProgress({
      operation: "full",
      phase: "chunk",
      completed: 0,
      ...estimate(0),
      unit: "texts",
    });
    for (const path of plan.paths) {
      check(signal);
      const doc = await this.readMarkdownIfAvailable(path, signal, "full");
      if (!doc) continue;
      const chunks = chunkMarkdown(
        doc.content,
        this.options.size ?? CHUNK_SIZE,
        this.options.overlap ?? CHUNK_OVERLAP,
        signal
      );
      chunked += chunks.length;
      this.reportProgress({
        operation: "full",
        phase: "chunk",
        completed: chunked,
        ...estimate(chunked),
        unit: "texts",
      });
      const contentId = await deriveNoteContentId(fingerprint, doc.content);
      const current = await this.readMarkdownIfAvailable(path, signal, "full");
      if (!current || (await deriveNoteContentId(fingerprint, current.content)) !== contentId) {
        this.queueChange();
        continue;
      }
      yield {
        path,
        contentId,
        chunks: chunks.map((chunk, index) => ({
          id: `${contentId}:${index}`,
          ordinal: index,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text,
        })),
      };
    }
    this.reportProgress({
      operation: "full",
      phase: "chunk",
      completed: chunked,
      total: chunked,
      unit: "texts",
      determinate: true,
    });
  }

  async synchronize(signal: AbortSignal): Promise<IndexSyncResult> {
    return this.runSynchronization(signal);
  }

  /** Explicit aliases keep the lifecycle vocabulary clear for callers. */
  async update(signal: AbortSignal): Promise<IndexSyncResult> {
    return this.synchronize(signal);
  }

  async rebuild(signal: AbortSignal): Promise<void> {
    return this.build(signal);
  }

  private async runSynchronization(
    signal: AbortSignal,
    phase?: "queued"
  ): Promise<IndexSyncResult> {
    if (this.maintenance)
      throw new StructuredError("busy", "Index maintenance is in progress.", true);
    if (this.building) throw new StructuredError("busy", "Index update is already running.", true);
    check(signal);
    this.building = true;
    const started = Date.now();
    this.emit({
      area: "index",
      event: "index_operation",
      operation: "incremental",
      stage: "started",
      ...(phase ? { phase } : {}),
    });
    const complete = (changed: boolean): IndexSyncResult => {
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "incremental",
        stage: "completed",
        ...(phase ? { phase } : {}),
        durationMs: Date.now() - started,
        generation: this.generationId(),
        counts: {
          changed: changed ? 1 : 0,
          notes: this.state?.noteCount ?? 0,
          chunks: this.state?.chunkCount ?? 0,
          incomplete: this.state?.incomplete ? 1 : 0,
        },
      });
      return { changed, converged: this.state?.incomplete === false };
    };
    try {
      if (!this.loaded) await this.load();
      let changed = false;
      // A vault can change while this pass is hashing or embedding. Repeat after
      // the final discovery until both the event watermark and exact summaries
      // agree. The bounded guard is only defensive; an actively edited vault
      // remains incomplete and is retried by the plugin.
      for (let pass = 0; pass < 8; pass++) {
        const watermark = this.revision;
        const discovered = await this.discoverEligible(signal);
        changed ||= await this.reconcileDiscovered(discovered, signal);
        const final = await this.discoverEligible(signal);
        if (watermark !== this.revision || !sameSummaries(discovered, final)) continue;
        const finished = await this.finishIfStable(final, signal, watermark);
        if (finished && watermark === this.revision) {
          this.reconciledRevision = Math.max(this.reconciledRevision, watermark);
          const result = complete(changed);
          if (result.converged)
            this.notifySuccessfulOperation({
              operation: "update",
              changed: result.changed,
              converged: result.converged,
              state: this.state!,
            });
          return result;
        }
      }
      return complete(changed);
    } catch (error) {
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "incremental",
        stage: signal.aborted ? "cancelled" : "failed",
        ...(phase ? { phase } : {}),
        durationMs: Date.now() - started,
        error: projectDiagnosticError(error),
      });
      throw error;
    } finally {
      this.building = false;
    }
  }

  private async discoverEligible(signal: AbortSignal): Promise<readonly SqliteNoteSummary[]> {
    const paths = [...(await this.vault.listMarkdownPaths(signal))]
      .map(normalizePath)
      .filter((path) => this.isIndexEligible(path))
      .sort(compareCodeUnits);
    const fingerprint = await this.corpusFingerprintId();
    const summaries: SqliteNoteSummary[] = [];
    for (const path of paths) {
      const doc = await this.readMarkdownIfAvailable(path, signal, "incremental");
      if (doc)
        summaries.push({ path, contentId: await deriveNoteContentId(fingerprint, doc.content) });
    }
    return summaries;
  }

  private async reconcileDiscovered(
    discovered: readonly SqliteNoteSummary[],
    signal: AbortSignal
  ): Promise<boolean> {
    const plan = (await this.ensureClient().call(
      "planReconciliation",
      { summaries: discovered },
      signal
    )) as SqliteReconciliationPlan;
    this.setState(plan.state);
    let changed = false;
    for (const rename of plan.renames) {
      const result = (await this.ensureClient().call(
        "renameNote",
        rename,
        signal
      )) as SqliteMutationResult;
      this.setState(result.state);
      changed ||= result.changed;
    }

    for (const summary of plan.upserts) {
      check(signal);
      const doc = await this.readMarkdownIfAvailable(summary.path, signal, "incremental");
      if (!doc) continue;
      const note = await this.prepareNote(summary.path, doc, signal);
      if (!note) continue;
      const latest = await this.readMarkdownIfAvailable(summary.path, signal, "incremental");
      if (
        !latest ||
        (await deriveNoteContentId(await this.corpusFingerprintId(), latest.content)) !==
          note.contentId
      ) {
        this.queueChange();
        continue;
      }
      const result = (await this.ensureClient().call(
        "upsertNote",
        { note },
        signal
      )) as SqliteMutationResult;
      this.setState(result.state);
      changed ||= result.changed;
    }

    for (const note of plan.deletes) {
      const result = (await this.ensureClient().call(
        "deleteNote",
        note,
        signal
      )) as SqliteMutationResult;
      this.setState(result.state);
      changed ||= result.changed;
    }
    return changed;
  }
  private async prepareNote(
    path: string,
    doc: IndexVaultDocument,
    signal: AbortSignal
  ): Promise<SqliteNoteInput | undefined> {
    check(signal);
    const fingerprint = await this.corpusFingerprintId();
    const contentId = await deriveNoteContentId(fingerprint, doc.content);
    const chunks = chunkMarkdown(
      doc.content,
      this.options.size ?? CHUNK_SIZE,
      this.options.overlap ?? CHUNK_OVERLAP,
      signal
    );
    const current = await this.readMarkdownIfAvailable(path, signal, "incremental");
    if (!current || (await deriveNoteContentId(fingerprint, current.content)) !== contentId) {
      this.queueChange();
      return undefined;
    }
    return {
      path,
      contentId,
      chunks: chunks.map((chunk, index) => ({
        id: `${contentId}:${index}`,
        ordinal: index,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text: chunk.text,
      })),
    };
  }
  private async finishIfStable(
    summaries: readonly SqliteNoteSummary[],
    signal: AbortSignal,
    expectedRevision = this.revision
  ): Promise<boolean> {
    const expected = [...summaries].sort((a, b) => compareCodeUnits(a.path, b.path));
    if (expectedRevision !== this.revision) {
      await this.markIncomplete(signal);
      return false;
    }
    const before = this.state?.changeCounter ?? 0;
    const state = (await this.ensureClient().call(
      "finishReconciliation",
      { summaries: expected, observedChangeCounter: before },
      signal
    )) as SqliteState;
    if (expectedRevision !== this.revision) {
      await this.markIncomplete(signal);
      return false;
    }
    this.setState(state);
    if (!state.incomplete)
      this.freshness = isPersistedSnapshotLoaded(state) ? "snapshot-loaded" : "locally-reconciled";
    return !state.incomplete;
  }

  private async markIncomplete(signal: AbortSignal): Promise<SqliteState> {
    const state = (await this.ensureClient().call("markIncomplete", {}, signal)) as SqliteState;
    this.setState(state);
    return state;
  }

  queueChange(): void {
    this.revision++;
  }

  private notifySuccessfulOperation(result: IndexOperationResult): void {
    try {
      const pending = (this.options.onSuccessfulOperation ?? this.options.onOperationSuccess)?.(
        result
      );
      if (pending) void pending.catch(() => undefined);
    } catch {
      /* Publication is a follow-up concern and cannot invalidate a local commit. */
    }
  }
  async reconcileQueuedChanges(signal: AbortSignal): Promise<IndexSyncResult> {
    if (this.revision === this.reconciledRevision) {
      if (this.loaded && this.state?.incomplete) return this.runSynchronization(signal, "queued");
      return { changed: false, converged: this.state?.incomplete === false };
    }
    if (this.building) {
      await this.buildPromise;
      if (this.building)
        throw new StructuredError("busy", "Index update is already running.", true);
    }
    return this.runSynchronization(signal, "queued");
  }

  /** Enriches the lexical corpus in bounded, resumable batches. */
  async prepareSemantic(signal: AbortSignal): Promise<SemanticPrepareResult> {
    if (this.building || this.maintenance || this.preparing)
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    check(signal);
    if (!this.loaded) await this.load();
    if (this.unavailable || !this.state)
      throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
    this.preparing = true;
    let stored = 0;
    let skipped = 0;
    const embeddingFingerprint = await this.embeddingFingerprintId();
    const batchSize = Math.min(512, Math.max(1, Math.floor(this.options.prepareBatchSize ?? 128)));
    const started = Date.now();
    try {
      let afterChunkPk = 0;
      for (;;) {
        check(signal);
        const observedChangeCounter = this.changeCounter();
        const observedRevision = this.revision;
        const missing = (await this.ensureClient().call(
          "listMissingVectors",
          { embeddingFingerprint, limit: batchSize, afterChunkPk },
          signal
        )) as readonly MissingVector[];
        if (!missing.length) break;
        const vectors = await this.embedding.embed(
          missing.map((item) => item.text),
          signal,
          (progress) =>
            this.reportProgress({
              operation: "incremental",
              phase: "build-vector",
              completed: stored + progress.completed,
              total: stored + missing.length,
              unit: "chunks",
              determinate: true,
            })
        );
        if (
          vectors.length !== missing.length ||
          vectors.some((vector) => vector.length !== this.embedding.dimensions)
        )
          throw new StructuredError(
            "internal",
            "Embedding dimensions changed during preparation.",
            false
          );
        // Vault events are an independent stale fence until reconciliation
        // commits them to SQLite. Never attach a delayed batch after one.
        if (this.revision !== observedRevision) {
          skipped += missing.length;
          // Leave the batch uncommitted. The caller must reconcile the vault
          // change before preparation can safely resume.
          break;
        }
        const result = (await this.ensureClient().call(
          "storeVectors",
          {
            embeddingFingerprint,
            observedChangeCounter,
            vectors: missing.map((item, index) => ({
              chunkPk: item.chunkPk,
              chunkId: item.chunkId,
              contentId: item.contentId,
              vector: new Float32Array(vectors[index]),
            })),
          },
          signal
        )) as { stored: number; skipped: number; state: SqliteState };
        this.setState(result.state);
        stored += result.stored;
        skipped += result.skipped;
        // A changed corpus invalidates the pagination fence. Restarting from
        // zero makes preparation resumable without ever attaching stale rows.
        if (result.skipped && result.state.changeCounter !== observedChangeCounter)
          afterChunkPk = 0;
        else afterChunkPk = missing.at(-1)!.chunkPk;
        this.reportProgress({
          operation: "incremental",
          phase: "build-vector",
          completed: stored,
          unit: "chunks",
          determinate: false,
        });
      }
      const finalState = this.state!;
      const result: SemanticPrepareResult = {
        operation: "prepare",
        changed: stored > 0,
        converged: finalState.semanticReady,
        state: finalState,
        stored,
        skipped,
      };
      if (result.converged) this.notifySuccessfulOperation(result);
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "incremental",
        stage: "completed",
        phase: "build-vector",
        durationMs: Date.now() - started,
        counts: { stored, skipped },
      });
      return result;
    } finally {
      this.preparing = false;
    }
  }

  async prepare(signal: AbortSignal): Promise<SemanticPrepareResult> {
    return this.prepareSemantic(signal);
  }

  async preparePublication(publicationId: string): Promise<PublicationPrepared> {
    if (this.building || this.preparing || this.maintenance)
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    if (!publicationId)
      throw new StructuredError("invalid_request", "Publication ID is required.", false);
    if (!this.loaded) await this.load();
    if (this.unavailable || !this.state)
      throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
    if (this.state.incomplete)
      throw new StructuredError("busy", "Index must be converged before publication.", true);
    this.maintenance = true;
    try {
      return (await this.ensureClient().call("preparePublication", {
        publicationId,
      })) as PublicationPrepared;
    } finally {
      this.maintenance = false;
    }
  }

  async finalizePublication(
    publicationId: string,
    expectedChangeCounter: number
  ): Promise<SqliteState | undefined> {
    if (!this.loaded) await this.load();
    if (this.unavailable || !this.state)
      throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
    const state = (await this.ensureClient().call("finalizePublication", {
      publicationId,
      expectedChangeCounter,
    })) as SqliteState | undefined;
    if (state) this.setState(state);
    return state;
  }

  /** Keep local mutations and adoption out until the vault copy and live ID agree. */
  async publishPublication<T>(
    publicationId: string,
    install: (prepared: PublicationPrepared) => Promise<T>,
    settle: (committed: boolean) => Promise<void> = async () => undefined
  ): Promise<{ prepared: PublicationPrepared; installed: T }> {
    if (this.building || this.preparing || this.maintenance)
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    if (!publicationId)
      throw new StructuredError("invalid_request", "Publication ID is required.", false);
    this.maintenance = true;
    try {
      if (!this.loaded) await this.load();
      if (this.unavailable || !this.state)
        throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
      if (this.state.incomplete)
        throw new StructuredError("busy", "Index must be converged before publication.", true);
      const prepared = (await this.ensureClient().call("preparePublication", {
        publicationId,
      })) as PublicationPrepared;
      const installed = await install(prepared);
      let state: SqliteState | undefined;
      try {
        state = (await this.ensureClient().call("finalizePublication", {
          publicationId,
          expectedChangeCounter: prepared.state.changeCounter,
        })) as SqliteState | undefined;
        if (!state) throw new StructuredError("busy", "Local changes prevented publication.", true);
      } catch (error) {
        await settle(false);
        throw error;
      }
      this.setState(state);
      await settle(true);
      return { prepared, installed };
    } finally {
      this.maintenance = false;
    }
  }

  async inspectPublication(bytes: ArrayBuffer): Promise<PublicationInspection> {
    if (
      !(bytes instanceof ArrayBuffer) ||
      !bytes.byteLength ||
      bytes.byteLength > SQLITE_SNAPSHOT_MAX_BYTES
    )
      throw new StructuredError("invalid_request", "Publication bytes are invalid.", false);
    if (!this.loaded) await this.load();
    if (this.unavailable || !this.state)
      throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
    return (await this.ensureClient().call("inspectPublication", {
      bytes,
      corpusFingerprint: await this.corpusFingerprintId(),
      embeddingFingerprint: await this.embeddingFingerprintId(),
      buildIdentity: SQLITE_BUILD_IDENTITY,
      dimensions: this.embedding.dimensions,
    })) as PublicationInspection;
  }

  /** Adopt a validated publication directly; no Markdown reconciliation or republish follows. */
  async adoptPublication(bytes: ArrayBuffer, expectedPublicationId?: string): Promise<SqliteState> {
    if (this.building || this.preparing || this.maintenance)
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    if (
      !(bytes instanceof ArrayBuffer) ||
      !bytes.byteLength ||
      bytes.byteLength > SQLITE_SNAPSHOT_MAX_BYTES
    )
      throw new StructuredError("invalid_request", "Publication bytes are invalid.", false);
    if (!this.loaded) await this.load();
    if (this.unavailable || !this.state)
      throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
    this.maintenance = true;
    try {
      const state = (await this.ensureClient().call("adoptPublication", {
        bytes,
        expectedPublicationId,
        corpusFingerprint: await this.corpusFingerprintId(),
        embeddingFingerprint: await this.embeddingFingerprintId(),
        buildIdentity: SQLITE_BUILD_IDENTITY,
        dimensions: this.embedding.dimensions,
      })) as SqliteState;
      this.setState(state);
      this.unavailable = false;
      this.freshness = state.incomplete
        ? "unknown"
        : isPersistedSnapshotLoaded(state)
          ? "snapshot-loaded"
          : "locally-reconciled";
      return state;
    } finally {
      this.maintenance = false;
    }
  }

  async search(
    query: string,
    signal: AbortSignal,
    limit: number,
    mode: "lexical" | "hybrid" = "lexical"
  ): Promise<readonly ProvenanceRecord[]> {
    return (await this.retrieve(query, mode, signal, Math.min(20, Math.max(0, limit)))).map(
      (result) => ({
        path: result.path,
        startLine: result.startLine,
        endLine: result.endLine,
        excerpt: result.excerpt,
        score: result.fusedScore,
      })
    );
  }
  lenteState(): {
    readonly changeCounter: number;
    readonly generationId: string;
    readonly semantic: IndexCapabilities["semantic"];
    readonly freshness: IndexFreshness;
    readonly publicationId?: string;
  } | null {
    if (!this.hasUsableIndex()) return null;
    const changeCounter = this.changeCounter();
    const state = this.state!;
    const capabilities = this.getCapabilities();
    return {
      changeCounter,
      generationId: indexIdentity(changeCounter),
      semantic: capabilities.semantic,
      freshness: this.freshness,
      ...(state.publicationId ? { publicationId: state.publicationId } : {}),
    };
  }
  searchLente(
    query: string,
    mode: "hybrid" | "lexical",
    signal?: AbortSignal
  ): Promise<readonly RetrievalResult[]> {
    return this.retrieve(query, mode, signal, 160, undefined, undefined, "lente");
  }
  private async retrieve(
    query: string,
    mode: "hybrid" | "lexical" | "semantic" | "related",
    signal: AbortSignal | undefined,
    limit: number,
    currentPath?: string,
    vector?: readonly number[],
    lexicalProfile: "voce" | "lente" = "voce"
  ): Promise<readonly RetrievalResult[]> {
    const started = Date.now();
    const requestSignal = signal ?? new AbortController().signal;
    try {
      check(requestSignal);
      if (this.maintenance)
        throw new StructuredError("busy", "Index maintenance is in progress.", true);
      if (!this.hasUsableIndex())
        throw new StructuredError("unavailable", "Lexical index is unavailable.", true);
      let effectiveMode = mode;
      const semanticReady = this.getCapabilities().semantic.searchable;
      if (mode === "hybrid" && !semanticReady) effectiveMode = "lexical";
      if ((mode === "semantic" || mode === "related") && !semanticReady)
        throw new StructuredError(
          "unavailable",
          "Semantic vectors are not ready. Prepare the semantic index first.",
          true
        );
      let queryVector = vector ? new Float32Array(vector) : undefined;
      if (effectiveMode !== "lexical" && !queryVector) {
        try {
          const values = await this.embedding.embed([query], requestSignal);
          queryVector = new Float32Array(values[0] ?? []);
        } catch {
          if (requestSignal.aborted)
            throw new StructuredError("cancelled", "Search cancelled.", true);
          throw new QueryEmbeddingError();
        }
        if (
          queryVector &&
          (queryVector.length !== this.embedding.dimensions ||
            !queryVector.some((value) => value !== 0))
        ) {
          throw new QueryEmbeddingError();
        }
      }
      const candidateLimit = lexicalProfile === "lente" ? 160 : mode === "related" ? 128 : 80;
      const resultLimit = Math.max(0, Math.min(256, Math.floor(limit)));
      const hits = (await this.ensureClient().call(
        "retrieve",
        {
          ...(effectiveMode === "semantic" ? {} : { query }),
          ...(queryVector ? { vector: queryVector } : {}),
          limit: resultLimit,
          semanticCandidateLimit: candidateLimit,
          lexicalCandidateLimit: candidateLimit,
          lexicalProfile,
          ...(lexicalProfile === "lente" ? { resultShape: "notes" as const } : {}),
          ...(currentPath ? { currentPath } : {}),
        },
        requestSignal
      )) as readonly SqliteHit[];
      const changeCounter = this.changeCounter();
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "search",
        stage: "completed",
        phase: mode,
        durationMs: Date.now() - started,
        generation: indexIdentity(changeCounter),
        counts: { results: hits.length },
      });
      return hits.map((hit) => ({
        path: hit.path,
        startLine: hit.startLine,
        endLine: hit.endLine,
        excerpt: hit.text,
        generationId: indexIdentity(changeCounter),
        changeCounter,
        chunkId: hit.id,
        ordinal: hit.ordinal,
        ...(hit.semanticScore === undefined ? {} : { semanticScore: hit.semanticScore }),
        ...(hit.lexicalScore === undefined ? {} : { lexicalScore: hit.lexicalScore }),
        fusedScore: hit.fusedScore ?? hit.score,
      }));
    } catch (error) {
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "search",
        stage: requestSignal.aborted ? "cancelled" : "failed",
        phase: mode,
        durationMs: Date.now() - started,
        error: projectDiagnosticError(error),
      });
      throw error;
    }
  }
  relatedState(path: string): RelatedIndexState | null {
    const currentPath = normalizePath(path);
    if (!this.hasUsableIndex() || !this.isSemanticReady() || !this.isIndexEligible(currentPath))
      return null;
    const counter = this.changeCounter();
    const identity = indexIdentity(counter);
    return {
      changeCounter: counter,
      generationId: identity,
      currentPath,
      contentHash: identity,
      semantic: this.getCapabilities().semantic,
      freshness: this.freshness,
      ...(this.state?.publicationId ? { publicationId: this.state.publicationId } : {}),
    };
  }
  async findRelated(
    path: string,
    signal: AbortSignal,
    limit: number
  ): Promise<readonly RelatedIndexHit[]> {
    check(signal);
    if (!this.hasUsableIndex() || !this.isSemanticReady())
      throw new StructuredError(
        "unavailable",
        "Semantic vectors are not ready. Prepare the semantic index first.",
        true
      );
    const hits = (await this.ensureClient().call(
      "findRelated",
      { path: normalizePath(path), limit: Math.min(128, limit) },
      signal
    )) as readonly SqliteHit[];
    return hits.map((hit) => ({
      path: hit.path,
      score: hit.score,
      similarity: hit.score,
      excerpt: hit.text,
      startLine: hit.startLine,
      endLine: hit.endLine,
    }));
  }
  invalidate(): void {
    this.unavailable = true;
    this.state = undefined;
  }
  async dispose(): Promise<void> {
    this.unavailable = true;
    await this.client?.shutdown().catch(() => undefined);
    this.client = undefined;
  }

  disposeImmediately(): void {
    this.unavailable = true;
    this.client?.terminateNow();
    this.client = undefined;
  }

  private isIndexEligible(path: string): boolean {
    try {
      const normalized = normalizePath(path);
      const excluded = [
        ...(this.options.excludedPaths ?? []),
        ...(this.options.publicationDirectory ? [this.options.publicationDirectory] : []),
      ];
      if (excluded.some((entry) => isPathExcluded(normalized, entry))) return false;
      return (
        this.options.isIndexEligible?.(normalized) ??
        this.vault.isIndexEligible?.(normalized) ??
        true
      );
    } catch {
      return false;
    }
  }
  private async readMarkdownIfAvailable(
    path: string,
    signal: AbortSignal,
    operation: "full" | "incremental"
  ): Promise<IndexVaultDocument | undefined> {
    if (!this.isIndexEligible(path)) return undefined;
    try {
      return await this.vault.readMarkdown(path, signal);
    } catch (error) {
      check(signal);
      let available = true;
      try {
        available = (await this.vault.isMarkdownAvailable?.(path, signal)) ?? true;
      } catch {
        /* preserve read error */
      }
      if (available) throw error;
      this.emit({
        area: "index",
        event: "index_operation",
        operation,
        stage: "skipped-unavailable-note",
        path,
        error: projectDiagnosticError(error),
      });
      return undefined;
    }
  }
  private emit(record: TramaDiagnosticRecord): void {
    emitTramaDiagnostic(this.diagnostics, record);
  }
  private reportProgress(progress: IndexProgress, emitDiagnostic = true): void {
    const next = Object.freeze({ ...progress });
    if (emitDiagnostic)
      this.emit({
        area: "index",
        event: "index_operation",
        operation: progress.operation === "startup" ? "startup" : progress.operation,
        stage: "started",
        phase: progress.phase,
        completed: progress.completed,
        ...(progress.total === undefined ? {} : { total: progress.total }),
        unit: progress.unit,
        determinate: progress.determinate,
        ...(progress.generationId ? { generation: progress.generationId } : {}),
      });
    try {
      this.onProgress?.(next);
    } catch {
      /* observational */
    }
  }
}
