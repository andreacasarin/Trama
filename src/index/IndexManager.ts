import {
  StructuredError,
  type EmbeddingModel,
  type IndexCapabilities,
  type IndexFreshness,
  type IndexProgress,
  type ProvenanceRecord,
} from "@/domain/contracts";
import { searchVault, type VaultRetrievalPort } from "@/index/VaultSearch";
import {
  CHUNK_ALGORITHM_VERSION,
  CHUNK_OVERLAP,
  CHUNK_SIZE,
  EXTRACTION_VERSION,
  INDEX_SCHEMA_VERSION,
} from "@/index/chunking";
import {
  compareCodeUnits,
  corpusIdentityInput,
  embeddingIdentityInput,
  EMBEDDING_PREPROCESSING_VERSION,
  deriveNoteContentId,
  indexIdentity,
  isPathExcluded,
  normalizeEmbeddingEndpoint,
  normalizeVaultPath,
  sha256Hex,
} from "@/index/Identity";
import { SQLITE_BUILD_IDENTITY, TRAMA_RUNTIME_BUILD_ID } from "@/build/identity";
import { SqliteWorkerClient, type SqliteWorkerLike } from "@/index/sqlite/client";
import {
  SQLITE_SNAPSHOT_MAX_BYTES,
  SQLITE_PROTOCOL_VERSION,
  SQLITE_MAX_SEMANTIC_BATCH_ITEMS,
  SQLITE_MAX_SEMANTIC_INPUT_BYTES,
  SQLITE_MAX_SEMANTIC_VECTOR_BYTES,
  sqliteError,
  type SqliteHit,
  type SqliteState,
  type SqliteNoteSummary,
  type SqliteLexicalBatchNoteInput,
  type SqliteLexicalRunResult,
  type SqliteSemanticWorkBatch,
  type SqliteSemanticCommitResult,
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
interface IndexJournalSnapshot {
  readonly changes: readonly IndexPathMutation[];
  readonly fullRecovery: boolean;
  readonly revision: number;
}

interface LexicalSnapshot {
  readonly paths: readonly string[];
  readonly summaries: readonly SqliteNoteSummary[];
  readonly documents: ReadonlyMap<string, IndexVaultDocument>;
  readonly revision: number;
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
export type IndexPathMutation =
  | { readonly type: "upsert"; readonly path: string }
  | { readonly type: "delete"; readonly path: string }
  | { readonly type: "rename"; readonly from: string; readonly to: string };
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
export type PublicationInspector = (
  bytes: ArrayBuffer,
  transferOwnership?: boolean
) => Promise<PublicationInspection>;

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
function coalescePathMutation(changes: IndexPathMutation[], mutation: IndexPathMutation): void {
  const previous = changes[changes.length - 1];
  if (mutation.type === "rename") {
    if (previous?.type === "rename" && previous.to === mutation.from) {
      changes[changes.length - 1] = { type: "rename", from: previous.from, to: mutation.to };
      return;
    }
    if (previous?.type === "upsert" && previous.path === mutation.from) {
      changes[changes.length - 1] = { type: "delete", path: mutation.from };
      changes.push({ type: "upsert", path: mutation.to });
      return;
    }
    if (previous?.type === "delete" && previous.path === mutation.from) {
      changes.push({ type: "upsert", path: mutation.to });
      return;
    }
    changes.push(mutation);
    return;
  }
  const path = mutation.path;
  if (mutation.type === "upsert") {
    if (previous?.type === "upsert" && previous.path === path) return;
    if (previous?.type === "delete" && previous.path === path) {
      changes[changes.length - 1] = mutation;
      return;
    }
    changes.push(mutation);
    return;
  }
  if (previous?.type === "delete" && previous.path === path) return;
  if (previous?.type === "rename" && previous.to === path) {
    changes[changes.length - 1] = { type: "delete", path: previous.from };
    return;
  }
  if (previous?.type === "upsert" && previous.path === path) {
    changes[changes.length - 1] = mutation;
    return;
  }
  changes.push(mutation);
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw new StructuredError("cancelled", "Index operation cancelled.", true);
}
export class IndexManager implements VaultRetrievalPort {
  private client?: SqliteWorkerClient;
  private state?: SqliteState;
  private loaded = false;
  private unavailable = false;
  private loadError?: unknown;
  private building = false;
  private maintenance = false;
  private maintenanceFinished?: Promise<void>;
  private releaseMaintenance?: () => void;
  private preparing = false;
  private freshness: IndexFreshness = "unknown";
  private loadPromise?: Promise<boolean>;
  private buildPromise?: Promise<void>;
  private revision = 0;
  private reconciledRevision = 0;
  private readonly changeJournal: IndexPathMutation[] = [];
  private fullRecoveryRequested = false;
  private readonly onProgress?: (progress: IndexProgress) => void;
  private readonly workerFactory?: () => SqliteWorkerLike;
  private readonly worker?: SqliteWorkerLike;

  constructor(
    private readonly vault: IndexVaultPort,
    private readonly embedding: EmbeddingModel,
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
  private async waitForMaintenance(signal: AbortSignal): Promise<void> {
    while (this.maintenance) {
      await this.maintenanceFinished;
      check(signal);
    }
  }
  private beginMaintenance(): void {
    this.maintenance = true;
    this.maintenanceFinished = new Promise<void>((resolve) => {
      this.releaseMaintenance = resolve;
    });
  }
  private endMaintenance(): void {
    this.maintenance = false;
    this.releaseMaintenance?.();
    this.releaseMaintenance = undefined;
    this.maintenanceFinished = undefined;
  }
  isComplete(): boolean {
    return this.state?.incomplete === false;
  }
  capabilities(): IndexCapabilities {
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
      const actualBuildId = await this.ensureClient().handshake(TRAMA_RUNTIME_BUILD_ID);
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "startup",
        stage: "completed",
        phase: "handshake",
        runtime: {
          expectedBuildId: TRAMA_RUNTIME_BUILD_ID,
          actualBuildId,
          protocolVersion: SQLITE_PROTOCOL_VERSION,
          schemaVersion: INDEX_SCHEMA_VERSION,
        },
      });
      const sqliteIdentity = await (this.options.sqliteIdentity ?? "default-vault");
      const state = (await this.ensureClient().call("boot", {
        corpusFingerprint: await this.corpusFingerprintId(),
        embeddingFingerprint: await this.embeddingFingerprintId(),
        buildIdentity: SQLITE_BUILD_IDENTITY,
        dimensions: this.embedding.dimensions,
        identity: await sha256Hex(sqliteIdentity),
      })) as SqliteState;
      this.setState(state);
      this.freshness = state.snapshotLoaded
        ? "snapshot-loaded"
        : state.incomplete
          ? "unknown"
          : "locally-reconciled";
      this.unavailable = false;
      this.loadError = undefined;
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
      this.loadError = error;
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
    await this.waitForMaintenance(signal);
    if (this.building) throw new StructuredError("busy", "Index rebuild is already running.", true);
    if (this.preparing)
      throw new StructuredError("busy", "Semantic index preparation is already running.", true);
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
      if (!this.loaded && !(await this.load()))
        throw (
          this.loadError ?? sqliteError("storage_unavailable", "SQLite index is unavailable.", true)
        );
      if (this.unavailable)
        throw (
          this.loadError ?? sqliteError("storage_unavailable", "SQLite index is unavailable.", true)
        );
      const result = await this.runFullLexical(signal, "rebuild");
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
          changed: result.changed,
          converged: result.converged,
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

  private async runFullLexical(
    signal: AbortSignal,
    operation: "rebuild" | "update" = "update"
  ): Promise<IndexSyncResult> {
    let snapshot = await this.readLexicalSnapshot(signal, operation);
    let changed = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      check(signal);
      if (this.fullRecoveryRequested && snapshot.revision !== this.revision) {
        snapshot = await this.readLexicalSnapshot(signal, operation);
      }
      let runId: string | undefined;
      try {
        if (
          operation !== "rebuild" &&
          !this.fullRecoveryRequested &&
          !this.state?.incomplete &&
          !this.state?.snapshotLoaded &&
          (await this.lexicalSnapshotMatchesState(snapshot, signal))
        ) {
          this.reconciledRevision = snapshot.revision;
          this.changeJournal.length = 0;
          this.fullRecoveryRequested = false;
          this.freshness = this.state?.snapshotLoaded ? "snapshot-loaded" : "locally-reconciled";
          return { changed, converged: true };
        }
        const before = this.state?.changeCounter ?? 0;
        const started = (await this.ensureClient().call(
          "beginLexicalRun",
          { summaries: snapshot.summaries, expectedChangeCounter: before },
          signal
        )) as { runId: string; state: SqliteState };
        runId = started.runId;
        this.setState(started.state);
        const applied = await this.applyLexicalSnapshot(runId, snapshot, signal, operation);
        changed ||= applied;
        if (snapshot.revision !== this.revision) {
          await this.cleanupLexicalRun(runId, "full");
          runId = undefined;
          if (this.fullRecoveryRequested)
            snapshot = await this.readLexicalSnapshot(signal, operation);
          else snapshot = await this.refreshSnapshotForJournal(snapshot, signal);
          continue;
        }
        let finished: SqliteLexicalRunResult;
        do {
          finished = (await this.ensureClient().call(
            "finishLexicalRun",
            { runId },
            signal
          )) as SqliteLexicalRunResult;
          this.setState(finished.state);
          changed ||= finished.receipt.changed;
        } while (!finished.complete);
        runId = undefined;
        if (snapshot.revision !== this.revision) {
          if (this.fullRecoveryRequested)
            snapshot = await this.readLexicalSnapshot(signal, operation);
          else snapshot = await this.refreshSnapshotForJournal(snapshot, signal);
          continue;
        }
        this.reconciledRevision = snapshot.revision;
        this.changeJournal.length = 0;
        this.fullRecoveryRequested = false;
        this.freshness = this.state?.snapshotLoaded ? "snapshot-loaded" : "locally-reconciled";
        return { changed, converged: this.state?.incomplete === false };
      } catch (error) {
        if (runId) {
          await this.cleanupLexicalRun(runId, "full");
          runId = undefined;
        }
        if (signal.aborted) throw error;
        if (attempt >= 7) {
          await this.markIncomplete(new AbortController().signal).catch(() => undefined);
          return { changed, converged: false };
        }
        throw error;
      }
    }
    await this.markIncomplete(new AbortController().signal).catch(() => undefined);
    return { changed, converged: false };
  }

  private async lexicalSnapshotMatchesState(
    snapshot: LexicalSnapshot,
    signal: AbortSignal
  ): Promise<boolean> {
    const current = (await this.ensureClient().call(
      "listLexicalSummaries",
      {},
      signal
    )) as readonly { readonly path: string; readonly revisionDigest?: string }[];
    if (current.length !== snapshot.summaries.length) return false;
    const expected = [...snapshot.summaries].sort((a, b) => compareCodeUnits(a.path, b.path));
    for (const [index, summary] of current.entries()) {
      if (
        summary.path !== expected[index].path ||
        summary.revisionDigest !== expected[index].contentId
      )
        return false;
    }
    return true;
  }

  private async readLexicalSnapshot(
    signal: AbortSignal,
    operation: "full" | "incremental" | "rebuild" | "update" = "full"
  ): Promise<LexicalSnapshot> {
    const paths = [...(await this.vault.listMarkdownPaths(signal))]
      .map(normalizePath)
      .filter((path) => this.isIndexEligible(path))
      .sort(compareCodeUnits);
    const fingerprint = await this.corpusFingerprintId();
    const documents = new Map<string, IndexVaultDocument>();
    const summaries: SqliteNoteSummary[] = [];
    this.reportProgress({
      operation: operation === "full" || operation === "rebuild" ? "full" : "incremental",
      phase: "discover",
      completed: paths.length,
      total: paths.length,
      unit: "paths",
      determinate: true,
    });
    this.reportProgress({
      operation: operation === "full" || operation === "rebuild" ? "full" : "incremental",
      phase: "read",
      completed: 0,
      total: paths.length,
      unit: "notes",
      determinate: true,
    });
    for (const [index, path] of paths.entries()) {
      check(signal);
      const doc = await this.readMarkdownIfAvailable(path, signal, "full");
      if (doc) {
        documents.set(path, doc);
        summaries.push({
          path,
          contentId: await deriveNoteContentId(fingerprint, doc.content),
        });
      }
      this.reportProgress(
        {
          operation: operation === "full" || operation === "rebuild" ? "full" : "incremental",
          phase: "read",
          completed: index + 1,
          total: paths.length,
          unit: "notes",
          determinate: true,
        },
        false
      );
    }
    return { paths, summaries, documents, revision: this.revision };
  }

  private async refreshSnapshotForJournal(
    snapshot: LexicalSnapshot,
    signal: AbortSignal
  ): Promise<LexicalSnapshot> {
    const fingerprint = await this.corpusFingerprintId();
    const documents = new Map(snapshot.documents);
    const summaries = new Map(snapshot.summaries.map((summary) => [summary.path, summary]));
    for (const change of this.changeJournal) {
      check(signal);
      if (change.type === "delete") {
        const path = normalizePath(change.path);
        documents.delete(path);
        summaries.delete(path);
        continue;
      }
      if (change.type === "rename") {
        const from = normalizePath(change.from);
        const to = normalizePath(change.to);
        const old = summaries.get(from);
        const doc = documents.get(from);
        summaries.delete(from);
        documents.delete(from);
        if (old && this.isIndexEligible(to)) {
          summaries.set(to, { ...old, path: to });
          if (doc) documents.set(to, { ...doc, path: to });
          continue;
        }
        if (!this.isIndexEligible(to)) continue;
        const current = await this.readMarkdownIfAvailable(to, signal, "incremental");
        if (!current) continue;
        documents.set(to, current);
        summaries.set(to, {
          path: to,
          contentId: await deriveNoteContentId(fingerprint, current.content),
        });
        continue;
      }
      const path = normalizePath(change.path);
      if (!this.isIndexEligible(path)) {
        documents.delete(path);
        summaries.delete(path);
        continue;
      }
      const doc = await this.readMarkdownIfAvailable(path, signal, "incremental");
      if (!doc) {
        documents.delete(path);
        summaries.delete(path);
      } else {
        documents.set(path, doc);
        summaries.set(path, {
          path,
          contentId: await deriveNoteContentId(fingerprint, doc.content),
        });
      }
    }
    return {
      paths: [...summaries.keys()].sort(compareCodeUnits),
      summaries: [...summaries.values()].sort((a, b) => compareCodeUnits(a.path, b.path)),
      documents,
      revision: this.revision,
    };
  }

  private async applyLexicalSnapshot(
    runId: string,
    snapshot: LexicalSnapshot,
    signal: AbortSignal,
    operation: "full" | "incremental" | "rebuild" | "update"
  ): Promise<boolean> {
    const notes = [...snapshot.documents.values()].sort((a, b) => compareCodeUnits(a.path, b.path));
    const batches: IndexVaultDocument[][] = [];
    let batch: IndexVaultDocument[] = [];
    let bytes = 0;
    for (const note of notes) {
      const noteBytes = new TextEncoder().encode(note.content).byteLength;
      if (batch.length && (batch.length >= 16 || bytes + noteBytes > 8 * 1024 * 1024)) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(note);
      bytes += noteBytes;
    }
    if (batch.length) batches.push(batch);
    const fingerprint = await this.corpusFingerprintId();
    let changed = false;
    this.reportProgress({
      operation: operation === "full" || operation === "rebuild" ? "full" : "incremental",
      phase: "encode-write",
      completed: 0,
      total: notes.length,
      unit: "notes",
      determinate: true,
    });
    let completed = 0;
    for (const group of batches) {
      check(signal);
      const result = (await this.ensureClient().call(
        "applyLexicalBatch",
        {
          runId,
          notes: await Promise.all(
            group.map(async (note): Promise<SqliteLexicalBatchNoteInput> => ({
              path: normalizePath(note.path),
              markdown: note.content,
              expectedRevisionDigest: await deriveNoteContentId(fingerprint, note.content),
              size: this.options.size ?? CHUNK_SIZE,
            }))
          ),
        },
        signal
      )) as {
        changed: boolean;
        applied: number;
        skipped: number;
        occurrences: number;
        receipt: { generation?: unknown };
      };
      changed ||= result.changed;
      completed += group.length;
      const generation = result.receipt.generation as
        { readonly changeCounter?: unknown } | undefined;
      this.reportProgress(
        {
          operation: operation === "full" || operation === "rebuild" ? "full" : "incremental",
          phase: "encode-write",
          completed,
          total: notes.length,
          unit: "notes",
          determinate: true,
          ...(typeof generation?.changeCounter === "number"
            ? { generationId: indexIdentity(generation.changeCounter) }
            : {}),
        },
        false
      );
      if (result.occurrences > 0)
        this.reportProgress(
          {
            operation: operation === "full" || operation === "rebuild" ? "full" : "incremental",
            phase: "chunk",
            completed: result.occurrences,
            total: result.occurrences,
            unit: "texts",
            determinate: true,
          },
          false
        );
    }
    return changed;
  }

  private async abortLexicalRun(runId: string, signal: AbortSignal): Promise<void> {
    const result = (await this.ensureClient().call(
      "abortLexicalRun",
      { runId },
      signal
    )) as SqliteLexicalRunResult;
    this.setState(result.state);
  }

  private async cleanupLexicalRun(runId: string, operation: "full" | "incremental"): Promise<void> {
    try {
      await this.abortLexicalRun(runId, new AbortController().signal);
    } catch (error) {
      this.emit({
        area: "index",
        event: "index_operation",
        operation,
        stage: "cleanup-failed",
        phase: "cleanup",
        error: projectDiagnosticError(error),
      });
    }
  }

  async synchronize(signal: AbortSignal): Promise<IndexSyncResult> {
    return this.runSynchronization(signal);
  }

  async reconcileChanges(
    changes: readonly IndexPathMutation[],
    signal: AbortSignal
  ): Promise<IndexSyncResult> {
    await this.waitForMaintenance(signal);
    if (this.building || this.preparing)
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    check(signal);
    if (!this.loaded && !(await this.load()))
      throw (
        this.loadError ?? sqliteError("storage_unavailable", "SQLite index is unavailable.", true)
      );
    if (this.unavailable)
      throw (
        this.loadError ?? sqliteError("storage_unavailable", "SQLite index is unavailable.", true)
      );
    this.building = true;
    const revision = this.revision;
    let runId: string | undefined;
    try {
      // The loaded state is the compact generation fence for a scoped run.
      // Do not refresh global status or round-trip the complete lexical
      // summary: only the journaled paths belong to this operation.
      const before = this.state;
      if (!before)
        throw new StructuredError("unavailable", "SQLite index state is unavailable.", true);
      const documents = new Map<string, IndexVaultDocument>();
      const renames: { from: string; to: string }[] = [];
      const deletes = new Set<string>();
      for (const change of changes) {
        check(signal);
        if (change.type === "delete") {
          deletes.add(normalizePath(change.path));
          continue;
        }
        if (change.type === "rename") {
          const from = normalizePath(change.from);
          const to = normalizePath(change.to);
          const fromEligible = this.isIndexEligible(from);
          const toEligible = this.isIndexEligible(to);
          if (fromEligible && toEligible) {
            renames.push({ from, to });
          } else if (fromEligible) {
            deletes.add(from);
          } else if (toEligible) {
            const doc = await this.readMarkdownIfAvailable(to, signal, "incremental");
            if (doc) documents.set(to, doc);
          }
          continue;
        }
        const path = normalizePath(change.path);
        if (!this.isIndexEligible(path)) {
          deletes.add(path);
          continue;
        }
        const doc = await this.readMarkdownIfAvailable(path, signal, "incremental");
        if (!doc) deletes.add(path);
        else documents.set(path, doc);
      }
      if (revision !== this.revision) return { changed: false, converged: false };
      const snapshot: LexicalSnapshot = {
        paths: [...documents.keys()].sort(compareCodeUnits),
        summaries: [],
        documents,
        revision,
      };
      const run = (await this.ensureClient().call(
        "beginLexicalRun",
        {
          expectedChangeCounter: before.changeCounter,
          scope: {
            renames,
            deletes: [...deletes].sort(compareCodeUnits),
            mayClearIncomplete:
              !before.incomplete &&
              !before.snapshotLoaded &&
              !this.fullRecoveryRequested &&
              revision === this.revision,
          },
        },
        signal
      )) as { runId: string; state: SqliteState };
      runId = run.runId;
      this.setState(run.state);
      let changed = await this.applyLexicalSnapshot(run.runId, snapshot, signal, "incremental");
      if (revision !== this.revision) {
        await this.cleanupLexicalRun(run.runId, "incremental");
        runId = undefined;
        return { changed, converged: false };
      }
      let finished: SqliteLexicalRunResult;
      do {
        finished = (await this.ensureClient().call(
          "finishLexicalRun",
          { runId: run.runId },
          signal
        )) as SqliteLexicalRunResult;
        this.setState(finished.state);
        changed ||= finished.receipt.changed;
      } while (!finished.complete);
      runId = undefined;
      if (revision !== this.revision) {
        await this.markIncomplete(new AbortController().signal);
        return { changed, converged: false };
      }
      this.reconciledRevision = revision;
      this.freshness = this.state?.snapshotLoaded ? "snapshot-loaded" : "locally-reconciled";
      const result = { changed, converged: this.state?.incomplete === false };
      if (result.converged)
        this.notifySuccessfulOperation({ operation: "update", ...result, state: this.state! });
      return result;
    } catch (error) {
      if (runId) {
        await this.cleanupLexicalRun(runId, "incremental");
        runId = undefined;
      }
      try {
        await this.markIncomplete(new AbortController().signal);
      } catch {
        // The Worker may already be unavailable; retain the original operation error.
      }
      throw error;
    } finally {
      this.building = false;
    }
  }

  private async runSynchronization(
    signal: AbortSignal,
    phase?: "queued"
  ): Promise<IndexSyncResult> {
    await this.waitForMaintenance(signal);
    if (this.building) throw new StructuredError("busy", "Index update is already running.", true);
    if (this.preparing)
      throw new StructuredError("busy", "Semantic index preparation is already running.", true);
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
      if (!this.loaded && !(await this.load()))
        throw (
          this.loadError ?? sqliteError("storage_unavailable", "SQLite index is unavailable.", true)
        );
      if (this.unavailable)
        throw (
          this.loadError ?? sqliteError("storage_unavailable", "SQLite index is unavailable.", true)
        );
      const result = await this.runFullLexical(signal, "update");
      if (result.converged)
        this.notifySuccessfulOperation({ operation: "update", ...result, state: this.state! });
      return complete(result.changed);
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

  private async markIncomplete(signal: AbortSignal): Promise<SqliteState> {
    const state = (await this.ensureClient().call("markIncomplete", {}, signal)) as SqliteState;
    this.setState(state);
    return state;
  }

  private markJournalDirty(): void {
    this.revision++;
    this.freshness = "unknown";
    this.fullRecoveryRequested = true;
  }

  /** Record one vault mutation in the manager-owned coalescing journal. */
  recordPathMutation(mutation: IndexPathMutation): void {
    const wasFullRecoveryRequested = this.fullRecoveryRequested;
    this.markJournalDirty();
    this.fullRecoveryRequested = wasFullRecoveryRequested;
    if (mutation.type === "rename")
      coalescePathMutation(this.changeJournal, {
        type: "rename",
        from: normalizePath(mutation.from),
        to: normalizePath(mutation.to),
      });
    else
      coalescePathMutation(this.changeJournal, {
        type: mutation.type,
        path: normalizePath(mutation.path),
      });
  }

  /** Mark the journal ambiguous; the next queued run must rediscover the vault. */
  requestFullRecovery(): void {
    this.markJournalDirty();
    this.fullRecoveryRequested = true;
  }

  hasPendingWork(): boolean {
    return Boolean(
      this.fullRecoveryRequested ||
      this.changeJournal.length ||
      this.revision !== this.reconciledRevision ||
      this.state?.incomplete
    );
  }

  journalSnapshot(): IndexJournalSnapshot {
    return {
      changes: this.changeJournal.map((change) => ({ ...change })),
      fullRecovery: this.fullRecoveryRequested,
      revision: this.revision,
    };
  }

  pendingChangeCount(): number {
    return this.changeJournal.length;
  }

  clearJournalIfCurrent(revision: number): void {
    if (revision !== this.revision) return;
    this.changeJournal.length = 0;
    this.fullRecoveryRequested = false;
    this.reconciledRevision = revision;
  }

  private notifySuccessfulOperation(result: IndexOperationResult): void {
    try {
      const pending = this.options.onSuccessfulOperation?.(result);
      if (pending) void pending.catch(() => undefined);
    } catch {
      /* Publication is a follow-up concern and cannot invalidate a local commit. */
    }
  }
  async reconcileQueuedChanges(signal: AbortSignal): Promise<IndexSyncResult> {
    const journal = this.journalSnapshot();
    if (!journal.fullRecovery && journal.changes.length && this.isComplete()) {
      const result = await this.reconcileChanges(journal.changes, signal);
      if (result.converged) this.clearJournalIfCurrent(journal.revision);
      return result;
    }
    if (!this.hasPendingWork())
      return { changed: false, converged: this.state?.incomplete === false };
    if (this.building) {
      await this.buildPromise;
      if (this.building)
        throw new StructuredError("busy", "Index update is already running.", true);
    }
    const result = await this.runSynchronization(signal, "queued");
    if (result.converged) this.clearJournalIfCurrent(journal.revision);
    return result;
  }

  /** Enriches the lexical corpus in bounded, resumable batches. */
  async prepareSemantic(signal: AbortSignal): Promise<SemanticPrepareResult> {
    return this.runSemanticPreparation(signal);
  }

  /** True only while this manager has usable stored vectors for its current embedding identity. */
  hasCompatibleSemanticVectors(): boolean {
    const state = this.state;
    return Boolean(
      this.loaded &&
      state &&
      (state.semanticHeadCount ?? state.compatibleVectorCount ?? 0) > 0 &&
      (state.semanticMissingCount === undefined ||
        state.semanticEligibleCount === undefined ||
        state.semanticMissingCount < state.semanticEligibleCount)
    );
  }

  /** True when the configured embedding provider has semantic work awaiting storage or promotion. */
  hasPendingSemanticWork(): boolean {
    const state = this.state;
    if (!this.loaded || !state || !state.embeddingFingerprint || !this.modelId.trim()) return false;
    if (state.semanticEligibleCount !== undefined) {
      const missing = state.semanticMissingCount ?? 0;
      const lagging =
        state.semanticLagCount ??
        Math.max(0, state.semanticEligibleCount - (state.semanticHeadCount ?? 0));
      return missing > 0 || lagging > 0;
    }
    return false;
  }

  async rebuildSemantic(signal: AbortSignal): Promise<SemanticPrepareResult> {
    await this.waitForMaintenance(signal);
    if (!this.loaded) await this.load();
    this.setState(
      (await this.ensureClient().call("clearSemanticCache", {}, signal)) as SqliteState
    );
    const result = await this.prepareSemantic(signal);
    return { ...result, operation: "rebuild" };
  }

  /** Fills the content-addressed semantic cache for active lexical heads. */
  async prepareSemanticCacheBatch(signal: AbortSignal): Promise<SemanticPrepareResult> {
    return this.runSemanticPreparation(
      signal,
      1,
      Math.min(16, this.options.prepareBatchSize ?? 16)
    );
  }

  private async runSemanticPreparation(
    signal: AbortSignal,
    maxBatches = Number.POSITIVE_INFINITY,
    batchSizeOverride?: number
  ): Promise<SemanticPrepareResult> {
    await this.waitForMaintenance(signal);
    if (this.building || this.preparing)
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    check(signal);
    this.preparing = true;
    let stored = 0;
    let skipped = 0;
    let promoted = 0;
    let hasMore = true;
    const operation = "incremental";
    const started = Date.now();
    const initialRevision = this.revision;
    try {
      if (!this.loaded) await this.load();
      if (this.unavailable || !this.state)
        throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
      const embeddingFingerprint = await this.embeddingFingerprintId();
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
        Math.max(1, Math.floor(batchSizeOverride ?? this.options.prepareBatchSize ?? 128)),
        Math.max(1, Math.floor(providerLimits.maxItems ?? SQLITE_MAX_SEMANTIC_BATCH_ITEMS)),
        Math.max(1, Math.floor(maxVectorBytes / (this.embedding.dimensions * 4)))
      );
      const totalMissing = Math.max(
        this.state.semanticMissingCount ?? 0,
        this.state.semanticEligibleCount ?? 0,
        this.state.chunkCount - this.state.compatibleVectorCount
      );
      this.reportProgress({
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
        const work = (await this.ensureClient().call(
          "prepareSemanticWork",
          {
            embeddingFingerprint,
            preprocessing: EMBEDDING_PREPROCESSING_VERSION,
            limit: requestedItems,
            maxInputBytes,
            promoteUnrestricted: promotedLexicalGeneration === undefined,
          },
          signal
        )) as SqliteSemanticWorkBatch;
        promoted += work.promoted;
        hasMore = work.hasMore;
        promotedLexicalGeneration = work.generation.lexicalGeneration;
        if (!work.requests.length) break;
        const missing = work.requests;
        const vectors = await this.embedding.embed(
          missing.map((item) => item.serialization),
          signal,
          (progress) =>
            this.reportProgress(
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
        const result = (await this.ensureClient().call(
          "commitSemanticResults",
          {
            embeddingFingerprint,
            preprocessing: EMBEDDING_PREPROCESSING_VERSION,
            dimensions: this.embedding.dimensions,
            expectedCount: missing.length,
            results: missing.map((item, index) => ({
              actionKey: item.actionKey,
              inputId: item.inputId,
              serialization: item.serialization,
              vector: new Float32Array(vectors[index]),
            })),
          },
          signal
        )) as SqliteSemanticCommitResult;
        stored += result.stored;
        skipped += result.skipped;
        promoted += result.promoted;
        hasMore = result.hasMore;
        if (result.generation.lexicalGeneration !== promotedLexicalGeneration)
          promotedLexicalGeneration = undefined;
        batches++;
        // A changed corpus invalidates the pagination fence. Restarting from
        // zero makes preparation resumable without ever attaching stale rows.
        this.reportProgress(
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
        if (!hasMore) break;
      }
      // Full state is intentionally refreshed only when this executor converges
      // or yields its bounded slice. Cache-only commits therefore do not publish.
      this.setState((await this.ensureClient().call("getState", {}, signal)) as SqliteState);
      const finalState = this.state!;
      const result: SemanticPrepareResult = {
        operation: "prepare",
        changed: promoted > 0,
        converged: !hasMore && this.revision === initialRevision,
        state: finalState,
        stored,
        skipped,
      };
      if (result.converged) this.notifySuccessfulOperation(result);
      this.emit({
        area: "index",
        event: "index_operation",
        operation,
        stage: "completed",
        phase: "build-vector",
        durationMs: Date.now() - started,
        counts: { stored, skipped, promoted },
      });
      return result;
    } catch (error) {
      // State is refreshed after failure/cancellation so callers retain the
      // committed portion of a bounded operation.
      try {
        this.setState((await this.ensureClient().call("getState", {})) as SqliteState);
      } catch {
        /* Preserve the original operation error. */
      }
      throw error;
    } finally {
      this.preparing = false;
    }
  }

  /** Keep local mutations and adoption out until the vault copy and live ID agree. */
  async publishPublication<T>(
    publicationId: string,
    install: (prepared: PublicationPrepared, inspect?: PublicationInspector) => Promise<T>,
    settle: (committed: boolean) => Promise<void> = async () => undefined
  ): Promise<{ prepared: PublicationPrepared; installed: T }> {
    if (this.building || this.preparing || this.maintenance)
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    if (!publicationId)
      throw new StructuredError("invalid_request", "Publication ID is required.", false);
    this.beginMaintenance();
    try {
      if (!this.loaded) await this.load();
      if (this.unavailable || !this.state)
        throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
      if (this.state.incomplete)
        throw new StructuredError("busy", "Index must be converged before publication.", true);
      const prepared = (await this.ensureClient().call("preparePublication", {
        publicationId,
      })) as PublicationPrepared;
      const installed = await install(prepared, (bytes, transferOwnership) =>
        this.inspectPublicationReserved(bytes, transferOwnership)
      );
      let state: SqliteState | undefined;
      try {
        state = (await this.ensureClient().call("finalizePublication", {
          publicationId,
          expectedChangeCounter: prepared.state.changeCounter,
          expectedLexicalGeneration: prepared.state.lexicalGeneration,
          expectedSemanticGeneration: prepared.state.semanticGeneration,
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
      this.endMaintenance();
    }
  }

  async inspectPublication(
    bytes: ArrayBuffer,
    transferOwnership = false
  ): Promise<PublicationInspection> {
    if (
      !(bytes instanceof ArrayBuffer) ||
      !bytes.byteLength ||
      bytes.byteLength > SQLITE_SNAPSHOT_MAX_BYTES
    )
      throw new StructuredError("invalid_request", "Publication bytes are invalid.", false);
    if (this.building || this.preparing || this.maintenance)
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    this.beginMaintenance();
    try {
      return await this.inspectPublicationReserved(bytes, transferOwnership);
    } finally {
      this.endMaintenance();
    }
  }

  private async inspectPublicationReserved(
    bytes: ArrayBuffer,
    transferOwnership = false
  ): Promise<PublicationInspection> {
    if (!this.loaded) await this.load();
    if (this.unavailable || !this.state)
      throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
    return (await this.ensureClient().call(
      "inspectPublication",
      {
        bytes,
        corpusFingerprint: await this.corpusFingerprintId(),
        embeddingFingerprint: await this.embeddingFingerprintId(),
        buildIdentity: SQLITE_BUILD_IDENTITY,
        dimensions: this.embedding.dimensions,
      },
      undefined,
      { transferOwnedBytes: transferOwnership }
    )) as PublicationInspection;
  }

  /** Adopt a validated publication directly; no Markdown reconciliation or republish follows. */
  async adoptPublication(
    bytes: ArrayBuffer,
    expectedPublicationId?: string,
    inspection?: PublicationInspection
  ): Promise<SqliteState> {
    if (this.building || this.preparing || this.maintenance)
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    if (
      !(bytes instanceof ArrayBuffer) ||
      !bytes.byteLength ||
      bytes.byteLength > SQLITE_SNAPSHOT_MAX_BYTES
    )
      throw new StructuredError("invalid_request", "Publication bytes are invalid.", false);
    this.beginMaintenance();
    try {
      if (!this.loaded) await this.load();
      if (this.unavailable || !this.state)
        throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
      const state = (await this.ensureClient().call("adoptPublication", {
        bytes,
        expectedPublicationId,
        inspection,
        corpusFingerprint: await this.corpusFingerprintId(),
        embeddingFingerprint: await this.embeddingFingerprintId(),
        buildIdentity: SQLITE_BUILD_IDENTITY,
        dimensions: this.embedding.dimensions,
      })) as SqliteState;
      this.setState(state);
      this.unavailable = false;
      this.freshness = state.incomplete
        ? "unknown"
        : state.snapshotLoaded
          ? "snapshot-loaded"
          : "locally-reconciled";
      return state;
    } finally {
      this.endMaintenance();
    }
  }

  async search(
    query: string,
    signal: AbortSignal,
    limit: number,
    mode: "lexical" | "hybrid" = "hybrid"
  ): Promise<readonly ProvenanceRecord[]> {
    const batch = await searchVault(this, query, {
      signal,
      searchMethod: mode === "lexical" ? "keyword" : "hybrid",
    });
    return batch.hits.slice(0, Math.min(20, Math.max(0, limit))).map((hit) => ({
      path: hit.path,
      startLine: hit.startLine,
      endLine: hit.endLine,
      excerpt: hit.excerpt,
      score: hit.fusedScore,
    }));
  }
  vaultSearchState(): {
    readonly changeCounter: number;
    readonly generationId: string;
    readonly semantic: IndexCapabilities["semantic"];
    readonly freshness: IndexFreshness;
    readonly publicationId?: string;
  } | null {
    if (!this.hasUsableIndex()) return null;
    const changeCounter = this.changeCounter();
    const state = this.state!;
    const capabilities = this.capabilities();
    return {
      changeCounter,
      generationId: indexIdentity(changeCounter),
      semantic: capabilities.semantic,
      freshness: this.freshness,
      ...(state.publicationId ? { publicationId: state.publicationId } : {}),
    };
  }
  retrieveVaultCandidates(
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
      const semanticReady = this.capabilities().semantic.searchable;
      if (mode === "hybrid" && !semanticReady) effectiveMode = "lexical";
      if ((mode === "semantic" || mode === "related") && !semanticReady)
        throw new StructuredError(
          "unavailable",
          "Semantic vectors are not ready. Update the semantic index first.",
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
    if (
      !this.hasUsableIndex() ||
      !this.capabilities().semantic.searchable ||
      !this.isIndexEligible(currentPath)
    )
      return null;
    const counter = this.changeCounter();
    const identity = indexIdentity(counter);
    const visibleHead = this.state?.semanticHeadKey || identity;
    return {
      changeCounter: counter,
      generationId: identity,
      currentPath,
      contentHash: visibleHead,
      semantic: this.capabilities().semantic,
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
    if (!this.hasUsableIndex() || !this.capabilities().semantic.searchable)
      throw new StructuredError(
        "unavailable",
        "Semantic vectors are not ready. Update the semantic index first.",
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
