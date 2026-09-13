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
export interface RelatedIndexSnapshot {
  readonly changeCounter?: number;
  readonly generationId?: string;
  readonly currentPath: string;
  readonly contentHash: string;
  prepareQuery(
    signal: AbortSignal
  ): Promise<{ readonly text: string; readonly vector: readonly number[] } | null>;
  search(
    query: string,
    vector: readonly number[],
    signal: AbortSignal,
    limit: number
  ): Promise<readonly RelatedIndexHit[]>;
}
interface FullIndexPlan {
  readonly paths: readonly string[];
  readonly estimatedTexts?: number;
}
export interface LenteBundleLease {
  readonly changeCounter?: number;
  readonly generationId?: string;
  search(
    query: string,
    mode: "hybrid" | "lexical",
    signal?: AbortSignal
  ): Promise<readonly RetrievalResult[]>;
  release(): Promise<void>;
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
function sameKnownSummaries(
  summaries: readonly SqliteNoteSummary[],
  known: ReadonlyMap<string, { contentId: string }>
): boolean {
  if (summaries.length !== known.size) return false;
  return summaries.every((summary) => known.get(summary.path)?.contentId === summary.contentId);
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
  private readonly knownNotes = new Map<string, { contentId: string; chunkCount: number }>();

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
  private syncKnown(
    notes: readonly { path: string; contentId: string; chunkCount: number }[]
  ): void {
    this.knownNotes.clear();
    for (const note of notes)
      this.knownNotes.set(note.path, { contentId: note.contentId, chunkCount: note.chunkCount });
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
      this.syncKnown(await this.ensureClient().call("listNotes", {}));
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
      this.syncKnown(await this.ensureClient().call("listNotes", {}, signal));
      let encoded = 0;
      for await (const note of this.noteInputs(plan, signal)) {
        check(signal);
        const result = (await this.ensureClient().call("upsertNote", { note }, signal)) as {
          state: SqliteState;
        };
        this.setState(result.state);
        this.knownNotes.set(note.path, {
          contentId: note.contentId,
          chunkCount: note.chunks.length,
        });
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
    if (this.maintenance)
      throw new StructuredError("busy", "Index maintenance is in progress.", true);
    if (this.building) throw new StructuredError("busy", "Index update is already running.", true);
    check(signal);
    const started = Date.now();
    this.emit({
      area: "index",
      event: "index_operation",
      operation: "incremental",
      stage: "started",
    });
    const complete = (changed: boolean): IndexSyncResult => {
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "incremental",
        stage: "completed",
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
      const initialWatermark = this.revision;
      const initial = await this.discoverEligible(signal);
      if (
        this.revision === this.reconciledRevision &&
        this.state?.incomplete === false &&
        initialWatermark === this.revision &&
        sameKnownSummaries(initial, this.knownNotes)
      ) {
        const verify = await this.discoverEligible(signal);
        if (
          initialWatermark === this.revision &&
          sameSummaries(initial, verify) &&
          sameKnownSummaries(verify, this.knownNotes)
        )
          return complete(false);
      }
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
        durationMs: Date.now() - started,
        error: projectDiagnosticError(error),
      });
      throw error;
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
    const current = new Map(discovered.map((summary) => [summary.path, summary]));
    const missing = [...this.knownNotes.entries()]
      .filter(([path]) => !current.has(path))
      .sort(([a], [b]) => compareCodeUnits(a, b));
    const additions = [...current.values()]
      .filter((summary) => !this.knownNotes.has(summary.path))
      .sort((a, b) => compareCodeUnits(a.path, b.path));
    let changed = false;

    // Pair offline renames before considering any deletion. Content IDs are
    // path-independent, so duplicate notes are paired deterministically by
    // code-unit path order and retain their existing vectors.
    const byId = new Map<string, string[]>();
    for (const [path, note] of missing)
      (byId.get(note.contentId) ?? (byId.set(note.contentId, []), byId.get(note.contentId)!)).push(
        path
      );
    const newById = new Map<string, string[]>();
    for (const summary of additions)
      (
        newById.get(summary.contentId) ??
        (newById.set(summary.contentId, []), newById.get(summary.contentId)!)
      ).push(summary.path);
    for (const [contentId, oldPaths] of byId) {
      const newPaths = newById.get(contentId) ?? [];
      oldPaths.sort(compareCodeUnits);
      newPaths.sort(compareCodeUnits);
      for (let index = 0; index < Math.min(oldPaths.length, newPaths.length); index++) {
        const from = oldPaths[index],
          to = newPaths[index];
        const previous = this.knownNotes.get(from)!;
        const result = (await this.ensureClient().call(
          "renameNote",
          { from, to, contentId },
          signal
        )) as SqliteMutationResult;
        this.setState(result.state);
        if (result.status === "state_changed") continue;
        changed ||= result.changed;
        this.knownNotes.delete(from);
        this.knownNotes.set(to, previous);
        newById.get(contentId)!.splice(newById.get(contentId)!.indexOf(to), 1);
        byId.get(contentId)!.splice(byId.get(contentId)!.indexOf(from), 1);
      }
    }

    // Hash-only additions and changed notes are embedded only after the
    // content identity proves that an update is actually necessary.
    for (const summary of [...current.values()].sort((a, b) => compareCodeUnits(a.path, b.path))) {
      check(signal);
      const known = this.knownNotes.get(summary.path);
      if (known?.contentId === summary.contentId) continue;
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
      if (result.status !== "state_changed")
        this.knownNotes.set(summary.path, {
          contentId: note.contentId,
          chunkCount: note.chunks.length,
        });
    }

    // Remaining missing rows are genuine deletes. Idempotent deletes make
    // replay after a lost acknowledgement safe.
    for (const [path, note] of [...this.knownNotes.entries()]
      .filter(([path]) => !current.has(path))
      .sort(([a], [b]) => compareCodeUnits(a, b))) {
      const result = (await this.ensureClient().call(
        "deleteNote",
        { path, contentId: note.contentId },
        signal
      )) as SqliteMutationResult;
      this.setState(result.state);
      changed ||= result.changed;
      if (result.status !== "state_changed") this.knownNotes.delete(path);
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
    const expectedWithChunks = expected.map((note) => ({
      ...note,
      chunkCount: this.knownNotes.get(note.path)?.chunkCount ?? 0,
    }));
    const before = this.state?.changeCounter ?? 0;
    const state = (await this.ensureClient().call(
      "finishReconciliation",
      { summaries: expectedWithChunks, observedChangeCounter: before },
      signal
    )) as SqliteState;
    if (expectedRevision !== this.revision) {
      await this.markIncomplete(signal);
      return false;
    }
    this.setState(state);
    if (!state.incomplete) this.syncKnown(expectedWithChunks);
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
      if (this.loaded && this.state?.incomplete) return this.synchronize(signal);
      return { changed: false, converged: this.state?.incomplete === false };
    }
    if (this.building) {
      await this.buildPromise;
      return this.reconcileQueuedChanges(signal);
    }
    if (!this.loaded) await this.load();
    this.building = true;
    const started = Date.now();
    this.emit({
      area: "index",
      event: "index_operation",
      operation: "incremental",
      stage: "started",
      phase: "queued",
    });
    try {
      let changed = false;
      let converged = false;
      const embeddingProgress = { completed: 0 };
      for (let pass = 0; pass < 8; pass++) {
        const watermark = this.revision;
        // Events only establish the watermark. The vault scan is authoritative:
        // a stale/reordered delete event must not hide a note that still exists.
        const discovered = await this.discoverEligible(signal);
        changed ||= await this.reconcileDiscovered(discovered, signal, embeddingProgress);
        const stable = await this.discoverEligible(signal);
        converged =
          sameSummaries(discovered, stable) &&
          watermark === this.revision &&
          (await this.finishIfStable(stable, signal, watermark));
        if (converged) {
          // A later event is never discarded by an acknowledgement for the
          // earlier watermark. It is left queued for the next pass.
          this.reconciledRevision = Math.max(this.reconciledRevision, watermark);
          break;
        }
      }
      if (converged) this.unavailable = false;
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "incremental",
        stage: "completed",
        phase: "queued",
        durationMs: Date.now() - started,
        generation: this.generationId(),
        counts: {
          changed: changed ? 1 : 0,
          notes: this.state?.noteCount ?? 0,
          chunks: this.state?.chunkCount ?? 0,
          incomplete: this.state?.incomplete ? 1 : 0,
        },
      });
      return { changed, converged };
    } catch (error) {
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "incremental",
        stage: signal.aborted ? "cancelled" : "failed",
        phase: "queued",
        durationMs: Date.now() - started,
        error: projectDiagnosticError(error),
      });
      throw error;
    } finally {
      this.building = false;
    }
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
  acquireLenteLease(): LenteBundleLease | null {
    if (!this.hasUsableIndex()) return null;
    const changeCounter = this.changeCounter();
    const generationId = indexIdentity(changeCounter);
    return {
      changeCounter,
      generationId,
      search: (query, mode, signal) =>
        this.retrieve(query, mode, signal, 160, undefined, undefined, "lente"),
      release: async () => undefined,
    };
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
  relatedSnapshot(path: string): RelatedIndexSnapshot | null {
    const currentPath = normalizePath(path),
      note = this.knownNotes.get(currentPath);
    if (!note || !this.hasUsableIndex()) return null;
    const counter = this.changeCounter();
    const identity = indexIdentity(counter);
    return {
      changeCounter: counter,
      generationId: identity,
      currentPath,
      contentHash: note.contentId,
      prepareQuery: async (signal) => {
        check(signal);
        return note.chunkCount > 0 ? { text: currentPath, vector: [] } : null;
      },
      search: async (_query, _vector, signal, limit) => {
        const hits = (await this.ensureClient().call(
          "findRelated",
          { path: currentPath, limit: Math.min(128, limit) },
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
      },
    };
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
      this.syncKnown(await this.ensureClient().call("listNotes", {}));
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
