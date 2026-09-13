import {
  StructuredError,
  type EmbeddingModel,
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
import { compareCodeUnits, deriveNoteContentId, indexIdentity, sha256Hex } from "@/index/Identity";
import { SqliteWorkerClient, type SqliteWorkerLike } from "@/index/sqlite/client";
import {
  SQLITE_SNAPSHOT_MAX_BYTES,
  SQLITE_SNAPSHOT_NAMESPACE,
  sqliteError,
  type SqliteHit,
  type SqliteNoteInput,
  type SqliteState,
  type SqliteNoteSummary,
  type SqliteReconciliationPlan,
  type SqliteMutationResult,
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
  readonly chunking: {
    readonly algorithmVersion: number;
    readonly size: number;
    readonly overlap: number;
  };
  readonly extractionVersion: number;
  readonly schemaVersion: number;
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
export interface IndexSnapshotExport {
  readonly bytes: ArrayBuffer;
  readonly sha256: string;
  readonly size: number;
  readonly path: string;
  readonly incomplete: boolean;
}
export interface IndexSnapshotImport {
  readonly bytes: ArrayBuffer;
  readonly sha256: string;
}

export interface IndexSyncResult {
  readonly changed: boolean;
  readonly converged: boolean;
}

export function createIndexFingerprint(
  embeddingBaseUrl: string,
  modelId: string,
  dimensions: number,
  options: {
    readonly size?: number;
    readonly overlap?: number;
    readonly excludedPaths?: readonly string[];
  } = {}
): IndexFingerprint {
  return {
    embeddingBaseUrl: embeddingBaseUrl.trim().replace(/\/$/, "").toLowerCase(),
    modelId,
    dimensions,
    excludedPaths: Object.freeze(
      [...new Set((options.excludedPaths ?? []).map(normalizePath))].sort(compareCodeUnits)
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
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
function canonical(value: unknown): string {
  return JSON.stringify(value);
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
export class IndexManager implements VaultSearchPort {
  private client?: SqliteWorkerClient;
  private state?: SqliteState;
  private loaded = false;
  private unavailable = false;
  private building = false;
  private maintenance = false;
  private loadPromise?: Promise<boolean>;
  private buildPromise?: Promise<void>;
  private revision = 0;
  private reconciledRevision = 0;
  private readonly onProgress?: (progress: IndexProgress) => void;
  private readonly workerFactory?: () => SqliteWorkerLike;
  private readonly worker?: SqliteWorkerLike;
  private readonly snapshotAdapter?: SnapshotDataAdapter;

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
      readonly isIndexEligible?: (path: string) => boolean;
      readonly onProgress?: (progress: IndexProgress) => void;
      readonly worker?: SqliteWorkerLike;
      readonly workerFactory?: () => SqliteWorkerLike;
      readonly sqliteIdentity?: string | Promise<string>;
      readonly sqliteClient?: SqliteWorkerClient;
      readonly snapshotAdapter?: SnapshotDataAdapter;
    } = {},
    private readonly diagnostics: TramaDiagnostics = NOOP_TRAMA_DIAGNOSTICS
  ) {
    this.snapshotAdapter =
      options.snapshotAdapter ??
      (typeof (storage as SnapshotDataAdapter).writeBinary === "function"
        ? (storage as SnapshotDataAdapter)
        : undefined);
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
  private async fingerprintId(): Promise<string> {
    return sha256Hex(canonical(this.fingerprint()));
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
        fingerprint: await this.fingerprintId(),
        dimensions: this.embedding.dimensions,
        identity: await sha256Hex(sqliteIdentity),
      });
      this.setState(state as SqliteState);
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
    const fingerprint = await this.fingerprintId();
    let embedded = 0;
    const estimate = (completed: number) =>
      plan.estimatedTexts !== undefined && completed <= plan.estimatedTexts
        ? { total: plan.estimatedTexts, determinate: true as const, estimated: true }
        : { determinate: false as const };
    this.reportProgress({
      operation: "full",
      phase: "embed",
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
      const vectors = chunks.length
        ? await this.embedding.embed(
            chunks.map((chunk) => chunk.text),
            signal,
            (progress) =>
              this.reportProgress({
                operation: "full",
                phase: "embed",
                completed: embedded + progress.completed,
                ...estimate(embedded + progress.completed),
                unit: "texts",
              })
          )
        : [];
      embedded += chunks.length;
      this.reportProgress({
        operation: "full",
        phase: "embed",
        completed: embedded,
        ...estimate(embedded),
        unit: "texts",
      });
      if (
        vectors.length !== chunks.length ||
        vectors.some((vector) => vector.length !== this.embedding.dimensions)
      )
        throw new StructuredError(
          "internal",
          "Embedding dimensions changed during indexing.",
          false
        );
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
          vector: new Float32Array(vectors[index]),
        })),
      };
    }
    this.reportProgress({
      operation: "full",
      phase: "embed",
      completed: embedded,
      total: embedded,
      unit: "texts",
      determinate: true,
    });
  }

  async synchronize(signal: AbortSignal): Promise<IndexSyncResult> {
    return this.runSynchronization(signal);
  }

  private async runSynchronization(
    signal: AbortSignal,
    phase?: "queued"
  ): Promise<IndexSyncResult> {
    if (this.maintenance)
      throw new StructuredError("busy", "Index maintenance is in progress.", true);
    if (this.building) throw new StructuredError("busy", "Index update is already running.", true);
    check(signal);
    const tracksBuilding = phase === "queued";
    if (tracksBuilding) this.building = true;
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
      const embeddingProgress = { completed: 0 };
      // A vault can change while this pass is hashing or embedding. Repeat after
      // the final discovery until both the event watermark and exact summaries
      // agree. The bounded guard is only defensive; an actively edited vault
      // remains incomplete and is retried by the plugin.
      for (let pass = 0; pass < 8; pass++) {
        const watermark = this.revision;
        const discovered = await this.discoverEligible(signal);
        changed ||= await this.reconcileDiscovered(discovered, signal, embeddingProgress);
        const final = await this.discoverEligible(signal);
        if (watermark !== this.revision || !sameSummaries(discovered, final)) continue;
        const finished = await this.finishIfStable(final, signal, watermark);
        if (finished && watermark === this.revision) {
          this.reconciledRevision = Math.max(this.reconciledRevision, watermark);
          return complete(changed);
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
      if (tracksBuilding) this.building = false;
    }
  }

  private async discoverEligible(signal: AbortSignal): Promise<readonly SqliteNoteSummary[]> {
    const paths = [...(await this.vault.listMarkdownPaths(signal))]
      .map(normalizePath)
      .filter((path) => this.isIndexEligible(path))
      .sort(compareCodeUnits);
    const fingerprint = await this.fingerprintId();
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
    signal: AbortSignal,
    embeddingProgress: { completed: number }
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
      const note = await this.prepareNote(summary.path, doc, signal, embeddingProgress);
      if (!note) continue;
      const latest = await this.readMarkdownIfAvailable(summary.path, signal, "incremental");
      if (
        !latest ||
        (await deriveNoteContentId(await this.fingerprintId(), latest.content)) !== note.contentId
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
    signal: AbortSignal,
    embeddingProgress: { completed: number }
  ): Promise<SqliteNoteInput | undefined> {
    check(signal);
    const fingerprint = await this.fingerprintId();
    const contentId = await deriveNoteContentId(fingerprint, doc.content);
    const chunks = chunkMarkdown(
      doc.content,
      this.options.size ?? CHUNK_SIZE,
      this.options.overlap ?? CHUNK_OVERLAP,
      signal
    );
    const completedBefore = embeddingProgress.completed;
    const vectors = chunks.length
      ? await this.embedding.embed(
          chunks.map((chunk) => chunk.text),
          signal,
          (progress) => {
            embeddingProgress.completed = Math.max(
              embeddingProgress.completed,
              completedBefore + progress.completed
            );
            this.reportProgress({
              operation: "incremental",
              phase: "embed",
              completed: embeddingProgress.completed,
              unit: "texts",
              determinate: false,
            });
          }
        )
      : [];
    embeddingProgress.completed = Math.max(
      embeddingProgress.completed,
      completedBefore + chunks.length
    );
    this.reportProgress({
      operation: "incremental",
      phase: "embed",
      completed: embeddingProgress.completed,
      unit: "texts",
      determinate: false,
    });
    if (
      vectors.length !== chunks.length ||
      vectors.some((vector) => vector.length !== this.embedding.dimensions)
    )
      throw new StructuredError("internal", "Embedding dimensions changed during indexing.", false);
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
        vector: new Float32Array(vectors[index]),
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

  async search(
    query: string,
    signal: AbortSignal,
    limit: number
  ): Promise<readonly ProvenanceRecord[]> {
    return (await this.retrieve(query, "hybrid", signal, Math.min(20, Math.max(0, limit)))).map(
      (result) => ({
        path: result.path,
        startLine: result.startLine,
        endLine: result.endLine,
        excerpt: result.excerpt,
        score: result.fusedScore,
      })
    );
  }
  lenteState(): { readonly changeCounter: number; readonly generationId: string } | null {
    if (!this.hasUsableIndex()) return null;
    const changeCounter = this.changeCounter();
    return { changeCounter, generationId: indexIdentity(changeCounter) };
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
        throw new StructuredError("unavailable", "Semantic index is unavailable.", true);
      let queryVector = vector ? new Float32Array(vector) : undefined;
      if (mode !== "lexical" && !queryVector) {
        try {
          const values = await this.embedding.embed([query], requestSignal);
          queryVector = new Float32Array(values[0] ?? []);
        } catch {
          if (requestSignal.aborted)
            throw new StructuredError("cancelled", "Search cancelled.", true);
          throw new QueryEmbeddingError();
        }
        if (
          queryVector.length !== this.embedding.dimensions ||
          !queryVector.some((value) => value !== 0)
        )
          throw new QueryEmbeddingError();
      }
      const candidateLimit = lexicalProfile === "lente" ? 160 : mode === "related" ? 128 : 80;
      const resultLimit = Math.max(0, Math.min(256, Math.floor(limit)));
      const hits = (await this.ensureClient().call(
        "retrieve",
        {
          ...(mode === "semantic" ? {} : { query }),
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
    if (!this.hasUsableIndex() || !this.isIndexEligible(currentPath)) return null;
    const counter = this.changeCounter();
    const identity = indexIdentity(counter);
    return {
      changeCounter: counter,
      generationId: identity,
      currentPath,
      contentHash: identity,
    };
  }
  async findRelated(
    path: string,
    signal: AbortSignal,
    limit: number
  ): Promise<readonly RelatedIndexHit[]> {
    check(signal);
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
  async exportSnapshot(): Promise<IndexSnapshotExport> {
    if (this.maintenance || this.building)
      throw new StructuredError(
        "busy",
        "Index maintenance is unavailable while indexing is active.",
        true
      );
    if (!this.loaded) await this.load();
    this.maintenance = true;
    try {
      const bytes = (await this.ensureClient().call("export", {})) as ArrayBuffer;
      if (
        !(bytes instanceof ArrayBuffer) ||
        bytes.byteLength === 0 ||
        bytes.byteLength > SQLITE_SNAPSHOT_MAX_BYTES
      )
        throw new StructuredError("invalid_request", "Snapshot bytes are invalid.", false);
      const copy = bytes.slice(0);
      const sha256 = await sha256Hex(copy);
      const path = `${SQLITE_SNAPSHOT_NAMESPACE}/${sha256}.sqlite3`;
      const adapter = this.snapshotAdapter;
      if (!adapter)
        throw new StructuredError("unavailable", "Snapshot storage is unavailable.", true);
      if (adapter.mkdir) await adapter.mkdir(".trama");
      if (adapter.mkdir) await adapter.mkdir(".trama/sqlite");
      if (adapter.mkdir) await adapter.mkdir(SQLITE_SNAPSHOT_NAMESPACE);
      const exists = adapter.exists ? await adapter.exists(path) : false;
      let existing: ArrayBuffer | undefined;
      if (exists || adapter.readBinary)
        existing = await adapter.readBinary?.(path).catch(() => undefined);
      if (!existing) await adapter.writeBinary(path, copy);
      else if ((await sha256Hex(existing)) !== sha256)
        throw new StructuredError(
          "internal",
          "Snapshot destination is immutable and occupied.",
          false
        );
      const metadataPath = `${SQLITE_SNAPSHOT_NAMESPACE}/${sha256}.json`;
      if (adapter.write && !(adapter.exists && (await adapter.exists(metadataPath))))
        await adapter.write(
          metadataPath,
          JSON.stringify({
            sha256,
            size: copy.byteLength,
            schemaVersion: this.state?.schemaVersion ?? 1,
            dimensions: this.state?.dimensions ?? this.embedding.dimensions,
            incomplete: this.state?.incomplete ?? true,
          })
        );
      const state = this.state ?? ((await this.ensureClient().call("getState", {})) as SqliteState);
      return { bytes: copy, sha256, size: copy.byteLength, path, incomplete: state.incomplete };
    } finally {
      this.maintenance = false;
    }
  }
  async importSnapshot(snapshot: IndexSnapshotImport): Promise<SqliteState> {
    if (this.maintenance || this.building)
      throw new StructuredError(
        "busy",
        "Index maintenance is unavailable while indexing is active.",
        true
      );
    if (
      !(snapshot.bytes instanceof ArrayBuffer) ||
      snapshot.bytes.byteLength === 0 ||
      snapshot.bytes.byteLength > SQLITE_SNAPSHOT_MAX_BYTES
    )
      throw new StructuredError("limit_exceeded", "Snapshot is too large or empty.", false);
    if (!/^[0-9a-f]{64}$/i.test(snapshot.sha256))
      throw new StructuredError("invalid_request", "Snapshot checksum verification failed.", false);
    const bytes = snapshot.bytes.slice(0);
    const sha256 = await sha256Hex(bytes);
    if (snapshot.sha256.toLowerCase() !== sha256)
      throw new StructuredError("invalid_request", "Snapshot checksum verification failed.", false);
    if (!this.loaded) await this.load();
    this.maintenance = true;
    try {
      const previous = this.state?.changeCounter ?? 0;
      const state = (await this.ensureClient().call("import", { bytes }, undefined)) as SqliteState;
      if (!state.incomplete || state.changeCounter <= previous)
        throw new StructuredError("internal", "Imported snapshot state is invalid.", false);
      this.setState(state);
      return state;
    } finally {
      this.maintenance = false;
    }
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
