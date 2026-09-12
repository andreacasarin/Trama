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
import type { IndexFingerprint, IndexVaultDocument, IndexVaultPort } from "@/index/contracts";
export type { IndexFingerprint, IndexVaultDocument, IndexVaultPort } from "@/index/contracts";
import { compareCodeUnits } from "@/index/order";
import { deriveNoteContentId, sha256Hex } from "@/index/corpus/Hash";
import { Retriever, type RetrievalResult } from "@/index/retrieval/Retriever";
import {
  TalaDbEngine,
  TalaDbRepository,
  TalaLexicalIndex,
  TalaVectorIndex,
  createTalaNamespace,
  TALA_NAMESPACE_VERSION,
  TalaCheckpointStore,
  type TalaCheckpoint,
  type TalaNamespace,
  type TalaNoteInput,
  type TalaState,
} from "@/index/taladb";
import type { IndexStorage } from "@/index/taladb/storage";
import {
  NOOP_TRAMA_DIAGNOSTICS,
  emitTramaDiagnostic,
  projectDiagnosticError,
  type TramaDiagnosticRecord,
  type TramaDiagnostics,
} from "@/diagnostics/TramaDiagnostics";

export interface RelatedIndexHit {
  readonly path: string;
  readonly score: number;
  readonly similarity?: number;
  readonly excerpt?: string;
  readonly startLine?: number;
  readonly endLine?: number;
}
export interface RelatedIndexSnapshot {
  readonly generationId: string;
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
type RevisionOperation =
  | { readonly kind: "create" | "modify" | "delete" | "empty" | "unchanged"; readonly path: string }
  | { readonly kind: "rename"; readonly oldPath: string; readonly path: string };
interface Queued {
  operation: RevisionOperation;
  revision: number;
}
interface Bundle {
  readonly repository: TalaDbRepository;
  readonly retriever: Retriever;
  readonly generationId: string;
  leases: number;
}
interface ManagerOptions {
  readonly size?: number;
  readonly overlap?: number;
  readonly excludedPaths?: readonly string[];
  readonly isIndexEligible?: (path: string) => boolean;
  readonly onProgress?: (progress: IndexProgress) => void;
  /** Test-only injection. Production composition leaves this unset and uses native TalaDB. */
  readonly engine?: TalaDbEngine;
  readonly backend?: "native" | "memory";
  readonly namespace?: TalaNamespace;
}

export function createIndexFingerprint(
  embeddingBaseUrl: string,
  modelId: string,
  dimensions: number,
  options: Pick<ManagerOptions, "size" | "overlap" | "excludedPaths"> = {}
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

/** Direct TalaDB production lifecycle. The legacy corpus backends are intentionally absent. */
export class IndexManager implements VaultSearchPort {
  private active: Bundle | null = null;
  private engine?: TalaDbEngine;
  private loaded = false;
  private unavailable = false;
  private loadPromise?: Promise<boolean>;
  private buildPromise?: Promise<void>;
  private building = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private generation = 0;
  private revision = 0;
  private writer: Promise<void> = Promise.resolve();
  private readonly queued = new Map<string, Queued>();
  private lastReconciliationPublished = false;
  private namespace: TalaNamespace;
  private readonly namespaceExplicit: boolean;
  private readonly onProgress?: (progress: IndexProgress) => void;
  private fingerprintCache = "";

  constructor(
    private readonly vault: IndexVaultPort,
    private readonly embedding: EmbeddingModel,
    private readonly storage: IndexStorage,
    private readonly embeddingBaseUrl: string,
    private readonly modelId: string,
    private readonly options: ManagerOptions = {},
    private readonly diagnostics: TramaDiagnostics = NOOP_TRAMA_DIAGNOSTICS
  ) {
    this.namespace =
      options.namespace ?? options.engine?.namespace ?? createTalaNamespace("pending");
    this.namespaceExplicit = Boolean(options.namespace ?? options.engine?.namespace);
    this.onProgress = options.onProgress;
    if (options.engine) this.engine = options.engine;
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
  isBuilding(): boolean {
    return this.building;
  }
  hasUsableIndex(): boolean {
    return this.active !== null && !this.unavailable;
  }
  isSyncNeeded(): boolean {
    return this.engine?.state().syncNeeded ?? false;
  }
  state(): TalaState | undefined {
    return this.engine?.state();
  }

  async load(options: { readonly emitDiagnostics?: boolean } = {}): Promise<boolean> {
    if (!this.loadPromise) this.loadPromise = this.loadPersisted(options.emitDiagnostics === true);
    return this.loadPromise;
  }
  private async loadPersisted(emit: boolean): Promise<boolean> {
    if (this.closed) return false;
    let loadPhase = "namespace";
    await this.loadNamespaceIdentity();
    loadPhase = "marker";
    const marker = await this.storage.read(this.statePath());
    // No pointer means no database open, schema creation, embedding, or network work.
    if (!marker) {
      this.loaded = true;
      return false;
    }
    const started = Date.now();
    try {
      const state = JSON.parse(marker) as TalaState;
      loadPhase = "fingerprint";
      const fingerprint = await this.fingerprintId();
      if (state.fingerprint !== fingerprint || state.dimensions !== this.embedding.dimensions)
        throw new Error("Index fingerprint mismatch");
      loadPhase = "open-engine";
      await this.openEngine(state);
      loadPhase = "publish";
      await this.publishBundle();
      this.unavailable = false;
      if (emit)
        this.emit({
          area: "index",
          event: "index_operation",
          operation: "load",
          stage: "completed",
          durationMs: Date.now() - started,
          generation: this.active?.generationId,
        });
      return true;
    } catch (error) {
      this.active = null;
      this.unavailable = false;
      if (emit)
        this.emit({
          area: "index",
          event: "index_operation",
          operation: "load",
          stage: "failed",
          durationMs: Date.now() - started,
          error: { ...projectDiagnosticError(error), code: `load-${loadPhase}` },
        });
      return false;
    } finally {
      this.loaded = true;
    }
  }
  private namespaceMetadataPath(): string {
    const root = this.storage.root.replace(/\/$/, "");
    const prefix = `${root}/`;
    return this.namespace.root.startsWith(prefix)
      ? `${TALA_NAMESPACE_VERSION}/namespace.json`
      : `${root}/${TALA_NAMESPACE_VERSION}/namespace.json`;
  }
  private async loadNamespaceIdentity(): Promise<void> {
    if (this.namespaceExplicit) return;
    const marker = await this.storage.read(this.namespaceMetadataPath());
    if (!marker) return;
    try {
      const value = JSON.parse(marker) as { version?: number; id?: string };
      if (value.version !== 1 || typeof value.id !== "string") throw new Error("invalid");
      this.namespace = createTalaNamespace(value.id);
    } catch {
      // An invalid identity makes the persisted index unavailable; it must not
      // cause startup to select another vault's database.
      this.namespace = createTalaNamespace("pending");
    }
  }
  private async persistNamespaceIdentity(): Promise<void> {
    if (this.namespaceExplicit) return;
    await this.storage.prepare?.();
    await this.storage.write(
      this.namespaceMetadataPath(),
      JSON.stringify({ version: 1, id: this.namespace.root.split("/").at(-1) })
    );
  }
  private newNamespace(): TalaNamespace {
    const id =
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
    return createTalaNamespace(id);
  }
  private statePath(): string {
    const root = this.storage.root.replace(/\/$/, "");
    if (root === this.namespace.root) return "state.json";
    const prefix = `${root}/`;
    const relativeRoot = this.namespace.root.startsWith(prefix)
      ? this.namespace.root.slice(prefix.length)
      : this.namespace.root;
    return `${relativeRoot}/state.json`;
  }
  private createEngine(initialState?: TalaState): TalaDbEngine {
    // The native backend is the only production default. Tests must opt in to
    // the in-memory backend explicitly through ManagerOptions.backend or an
    // injected engine; never infer it from a storage class name.
    const backend = this.options.backend ?? "native";
    return new TalaDbEngine({
      namespace: this.namespace,
      dimensions: this.embedding.dimensions,
      fingerprint: this.fingerprintCache,
      backend,
      initialState,
      durability: {
        writeState: async (state) => this.storage.write(this.statePath(), JSON.stringify(state)),
      },
    });
  }
  private async openEngine(initialState?: TalaState): Promise<void> {
    if (!this.engine) {
      this.fingerprintCache = await this.fingerprintId();
      this.engine = this.createEngine(initialState);
    }
    await this.engine.open();
  }
  private async ensureEngineForMutation(): Promise<TalaDbEngine> {
    if (!this.engine) {
      this.fingerprintCache = await this.fingerprintId();
      this.engine = this.createEngine();
      await this.engine.open();
    }
    return this.engine;
  }
  private async publishBundle(): Promise<void> {
    const engine = this.engine;
    if (!engine) throw new Error("Tala database is unavailable");
    const generationId = `taladb-v1:${++this.generation}`;
    const repository = new TalaDbRepository(engine, generationId, false);
    const retriever = new Retriever({
      repository,
      vector: new TalaVectorIndex(engine, generationId),
      lexical: new TalaLexicalIndex(engine, generationId),
      embedding: this.embedding,
    });
    this.active = { repository, retriever, generationId: repository.generationId, leases: 0 };
  }
  private withWriter<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writer.then(operation, operation);
    this.writer = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async build(signal: AbortSignal): Promise<void> {
    if (this.building || this.buildPromise)
      throw new StructuredError("busy", "Index rebuild is already running.", true);
    const run = this.withWriter(() => this.buildInternal(signal));
    this.buildPromise = run.then(() => undefined);
    try {
      await run;
    } finally {
      this.buildPromise = undefined;
    }
  }
  private async buildInternal(signal: AbortSignal): Promise<void> {
    this.building = true;
    const started = Date.now();
    try {
      check(signal);
      const paths = [...(await this.vault.listMarkdownPaths(signal))]
        .map(normalizePath)
        .filter((path) => this.isIndexEligible(path))
        .sort(compareCodeUnits);
      this.reportProgress({
        operation: "full",
        phase: "discover",
        completed: paths.length,
        total: paths.length,
        unit: "paths",
        determinate: true,
      });
      // Enter the dirty state before any embedding work. The same mutable
      // engine remains queryable while rows are replaced, including a first
      // build where the initial bundle is empty.
      if (!this.namespaceExplicit && this.namespace.root.endsWith("/pending")) {
        this.namespace = this.newNamespace();
        await this.persistNamespaceIdentity();
      }
      const engine = await this.ensureEngineForMutation();
      await engine.markDirty("rebuilding");
      await this.publishBundle();
      const notes = await this.readAndEmbed(paths, signal, "full");
      await engine.rebuild(notes, signal);
      this.reportProgress({
        operation: "full",
        phase: "encode-write",
        completed: notes.length,
        total: notes.length,
        unit: "artifacts",
        determinate: true,
      });
      this.reportProgress({
        operation: "full",
        phase: "validate",
        completed: 1,
        total: 1,
        unit: "artifacts",
        determinate: true,
      });
      this.reportProgress({
        operation: "full",
        phase: "build-vector",
        completed: 1,
        total: 1,
        unit: "chunks",
        determinate: true,
      });
      this.reportProgress({
        operation: "full",
        phase: "build-lexical",
        completed: 1,
        total: 1,
        unit: "chunks",
        determinate: true,
      });
      this.reportProgress({
        operation: "full",
        phase: "activate",
        completed: 1,
        total: 1,
        unit: "artifacts",
        determinate: true,
      });
      await this.publishBundle();
      this.unavailable = false;
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "build",
        stage: "published",
        generation: this.active?.generationId,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      if (this.engine) await this.publishBundle().catch(() => undefined);
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "build",
        stage: signal.aborted ? "cancelled" : "failed",
        error: projectDiagnosticError(error),
        durationMs: Date.now() - started,
      });
      throw error;
    } finally {
      this.building = false;
    }
  }
  private async readAndEmbed(
    paths: readonly string[],
    signal: AbortSignal,
    operation: "full" | "incremental"
  ): Promise<TalaNoteInput[]> {
    const fingerprint = await this.fingerprintId();
    const result: TalaNoteInput[] = [];
    let embedded = 0;
    let chunked = 0;
    this.reportProgress({
      operation,
      phase: "read",
      completed: 0,
      total: paths.length,
      unit: "notes",
      determinate: true,
    });
    for (const path of paths) {
      check(signal);
      const doc = await this.readMarkdownIfAvailable(path, signal, operation);
      if (!doc) continue;
      this.reportProgress({
        operation,
        phase: "read",
        completed: result.length + 1,
        total: paths.length,
        unit: "notes",
        determinate: true,
      });
      const chunks = chunkMarkdown(
        doc.content,
        this.options.size ?? CHUNK_SIZE,
        this.options.overlap ?? CHUNK_OVERLAP,
        signal
      );
      chunked += chunks.length;
      this.reportProgress({
        operation,
        phase: "chunk",
        completed: chunked,
        unit: "chunks",
        determinate: false,
      });
      const vectors = chunks.length
        ? await this.embedding.embed(
            chunks.map((c) => c.text),
            signal,
            (progress) =>
              this.reportProgress({
                operation,
                phase: "embed",
                completed: embedded + progress.completed,
                unit: "texts",
                determinate: false,
              })
          )
        : [];
      if (
        vectors.length !== chunks.length ||
        vectors.some((vector) => vector.length !== this.embedding.dimensions)
      )
        throw new StructuredError(
          "internal",
          "Embedding dimensions changed during indexing.",
          false
        );
      embedded += chunks.length;
      this.reportProgress({
        operation,
        phase: "embed",
        completed: embedded,
        total: operation === "full" ? embedded : undefined,
        unit: "texts",
        determinate: operation === "full",
      });
      result.push({
        path,
        content: doc.content,
        contentId: await deriveNoteContentId(fingerprint, doc.content),
        chunks: chunks.map((chunk, ordinal) => ({ ...chunk, ordinal, vector: vectors[ordinal] })),
      });
    }
    this.reportProgress({
      operation,
      phase: "read",
      completed: paths.length,
      total: paths.length,
      unit: "notes",
      determinate: true,
    });
    this.reportProgress({
      operation,
      phase: "chunk",
      completed: chunked,
      total: chunked,
      unit: "chunks",
      determinate: true,
    });
    return result;
  }

  async synchronize(signal: AbortSignal): Promise<void> {
    await this.synchronizeWithPublication(signal);
  }
  async synchronizeWithPublication(signal: AbortSignal): Promise<boolean> {
    check(signal);
    if (!this.loaded) await this.load();
    if (!this.active || this.unavailable)
      throw new StructuredError("unavailable", "Rebuild index is required.", true);
    const paths = [...(await this.vault.listMarkdownPaths(signal))]
      .map(normalizePath)
      .filter((path) => this.isIndexEligible(path))
      .sort(compareCodeUnits);
    const present = new Set(paths);
    for (const path of paths) this.queueOperation({ kind: "modify", path });
    for (const note of this.active.repository.notes)
      if (!present.has(note.path)) this.queueOperation({ kind: "delete", path: note.path });
    return this.reconcileQueuedChangesWithPublication(signal);
  }
  async waitForBuild(): Promise<void> {
    await this.buildPromise;
  }
  queueChange(path: string): void {
    this.queueOperation({ kind: "modify", path });
  }
  queueOperation(operation: RevisionOperation): void {
    const key =
      operation.kind === "rename" ? `${operation.oldPath}\0${operation.path}` : operation.path;
    this.queued.set(key, { operation, revision: ++this.revision });
  }
  queueRename(oldPath: string, path: string): void {
    this.queueOperation({ kind: "rename", oldPath, path });
  }
  async reconcileQueuedChanges(signal: AbortSignal): Promise<void> {
    this.lastReconciliationPublished = await this.reconcileQueuedChangesWithPublication(signal);
  }
  getLastReconciliationPublished(): boolean {
    return this.lastReconciliationPublished;
  }
  async reconcileQueuedChangesWithPublication(signal: AbortSignal): Promise<boolean> {
    if (!this.queued.size) return false;
    return this.withWriter(async () => {
      if (!this.active || this.unavailable)
        throw new StructuredError("unavailable", "Rebuild index is required.", true);
      this.building = true;
      try {
        const captured = new Map(this.queued);
        const base = new Map(this.active.repository.notes.map((note) => [note.path, note]));
        const paths = [...(await this.vault.listMarkdownPaths(signal))]
          .map(normalizePath)
          .filter((path) => this.isIndexEligible(path))
          .sort(compareCodeUnits);
        const docs = new Map<string, IndexVaultDocument>();
        const skipped = new Set<string>();
        for (const path of paths) {
          const doc = await this.readMarkdownIfAvailable(path, signal, "incremental");
          if (doc) docs.set(path, doc);
          else skipped.add(path);
        }
        const fingerprint = await this.fingerprintId();
        const desired = new Map<string, { doc: IndexVaultDocument; contentId: string }>();
        for (const [path, doc] of docs)
          desired.set(path, {
            doc,
            contentId: await deriveNoteContentId(fingerprint, doc.content),
          });
        // Explicit delete requests are authoritative even when a test/tool vault
        // still exposes the file; ordinary update scans use modify operations.
        for (const { operation } of captured.values())
          if (operation.kind === "delete") desired.delete(normalizePath(operation.path));
          else if (operation.kind === "rename") desired.delete(normalizePath(operation.oldPath));
        const changed =
          [...desired].some(([path, value]) => base.get(path)?.contentId !== value.contentId) ||
          [...base].some(([path]) => !desired.has(path) && !skipped.has(path));
        if (!changed) {
          this.clearCaptured(captured);
          return false;
        }
        const engine = await this.ensureEngineForMutation();
        await engine.markDirty("syncing");
        await this.publishBundle();
        for (const [path] of base)
          if (!desired.has(path) && !skipped.has(path)) await engine.delete(path);
        for (const [path, value] of desired) {
          const old = [...base].find(
            ([oldPath, note]) =>
              oldPath !== path && note.contentId === value.contentId && !desired.has(oldPath)
          );
          if (old) {
            const oldCheckpoint = await engine.noteChunks(old[0]);
            await engine.delete(old[0]);
            if (oldCheckpoint.length) {
              await engine.reconcile({
                path,
                content: value.doc.content,
                contentId: value.contentId,
                chunks: oldCheckpoint,
              });
              continue;
            }
          }
          if (base.get(path)?.contentId === value.contentId) continue;
          const note = (await this.readAndEmbed([path], signal, "incremental"))[0];
          if (note) await engine.reconcile(note);
        }
        await engine.commitReady();
        this.reportProgress({
          operation: "incremental",
          phase: "encode-write",
          completed: 1,
          total: 1,
          unit: "artifacts",
          determinate: true,
        });
        this.reportProgress({
          operation: "incremental",
          phase: "validate",
          completed: 1,
          total: 1,
          unit: "artifacts",
          determinate: true,
        });
        this.reportProgress({
          operation: "incremental",
          phase: "build-vector",
          completed: 1,
          total: 1,
          unit: "chunks",
          determinate: true,
        });
        this.reportProgress({
          operation: "incremental",
          phase: "build-lexical",
          completed: 1,
          total: 1,
          unit: "chunks",
          determinate: true,
        });
        this.reportProgress({
          operation: "incremental",
          phase: "activate",
          completed: 1,
          total: 1,
          unit: "artifacts",
          determinate: true,
        });
        this.clearCaptured(captured);
        await this.publishBundle();
        return true;
      } catch (error) {
        if (this.engine) await this.publishBundle().catch(() => undefined);
        throw error;
      } finally {
        this.building = false;
      }
    });
  }

  /** Export is deliberately explicit; startup never restores checkpoints. */
  async exportCheckpoint(): Promise<TalaCheckpoint> {
    if (this.building) throw new StructuredError("busy", "Index operation is running.", true);
    if (!this.engine || !this.active || this.engine.state().status !== "ready")
      throw new StructuredError("unavailable", "A ready index is required.", true);
    const checkpoint = await this.engine.exportCheckpoint();
    await this.storage.prepare?.();
    await this.checkpointStore().export(checkpoint);
    return checkpoint;
  }
  async importCheckpoint(signal: AbortSignal): Promise<TalaState> {
    return this.withWriter(() => this.importCheckpointExclusive(signal));
  }
  private async importCheckpointExclusive(signal: AbortSignal): Promise<TalaState> {
    if (this.building) throw new StructuredError("busy", "Index operation is running.", true);
    if (!this.loaded) await this.load();
    let checkpoint: TalaCheckpoint | null;
    try {
      checkpoint = await this.checkpointStore().import();
    } catch {
      throw new StructuredError("internal", "Checkpoint is corrupt.", false);
    }
    if (!checkpoint) throw new StructuredError("unavailable", "No checkpoint is available.", true);
    const engine = await this.ensureEngineForMutation();
    if (checkpoint.version !== 1 || checkpoint.namespace !== this.namespace.root)
      throw new StructuredError("internal", "Checkpoint is incompatible with this index.", false);
    await engine.markDirty("syncing");
    try {
      await engine.importCheckpoint(checkpoint, signal);
      await engine.commitReady();
      await this.publishBundle();
      this.unavailable = false;
      return engine.state();
    } catch (error) {
      this.unavailable = false;
      await this.publishBundle().catch(() => undefined);
      throw error;
    }
  }
  private relativeNamespacePath(path: string): string {
    const root = this.storage.root.replace(/\/$/, "");
    const prefix = `${root}/`;
    if (!path.startsWith(prefix)) throw new Error("Checkpoint path is outside index storage");
    return path.slice(prefix.length);
  }
  private checkpointStore(): TalaCheckpointStore {
    const id = this.namespace.root.split("/").at(-1)!;
    const checkpointNamespace: TalaNamespace = {
      ...this.namespace,
      checkpoint: `.trama/index/${TALA_NAMESPACE_VERSION}/checkpoints/${id}.bin`,
    };
    const adapter = {
      read: (path: string) => this.storage.read(this.relativeNamespacePath(path)),
      write: (path: string, value: string) =>
        this.storage.write(this.relativeNamespacePath(path), value),
      remove: (path: string) => this.storage.remove(this.relativeNamespacePath(path)),
    };
    return new TalaCheckpointStore(adapter, checkpointNamespace);
  }
  private clearCaptured(captured: Map<string, Queued>): void {
    for (const [key, value] of captured)
      if (this.queued.get(key)?.revision === value.revision) this.queued.delete(key);
  }

  acquireLenteLease(): {
    readonly generationId: string;
    readonly retriever: Retriever;
    search(
      query: string,
      mode: "hybrid" | "lexical",
      signal?: AbortSignal
    ): Promise<readonly RetrievalResult[]>;
    release(): Promise<void>;
  } | null {
    const bundle = this.active;
    if (!bundle || this.unavailable) return null;
    bundle.leases++;
    let released = false;
    return {
      generationId: bundle.generationId,
      retriever: bundle.retriever,
      search: (query, mode, signal) =>
        bundle.retriever.search({
          query,
          mode,
          resultShape: "notes",
          limit: 160,
          feature: "lente",
          semanticCandidateLimit: 160,
          lexicalCandidateLimit: 160,
          lexicalProfile: "lente",
          signal,
        }),
      release: async () => {
        if (released) return;
        released = true;
        bundle.leases = Math.max(0, bundle.leases - 1);
      },
    };
  }
  async searchLente(
    query: string,
    mode: "hybrid" | "lexical" = "hybrid",
    signal?: AbortSignal
  ): Promise<readonly RetrievalResult[]> {
    const lease = this.acquireLenteLease();
    if (!lease) throw new StructuredError("unavailable", "Semantic index is unavailable.", true);
    try {
      return await lease.search(query, mode, signal);
    } finally {
      await lease.release();
    }
  }
  async search(
    query: string,
    signal: AbortSignal,
    limit: number
  ): Promise<readonly ProvenanceRecord[]> {
    const bundle = this.active;
    if (!bundle || this.unavailable)
      throw new StructuredError("unavailable", "Semantic index is unavailable.", true);
    check(signal);
    const results = await bundle.retriever.search({
      query,
      mode: "hybrid",
      resultShape: "chunks",
      limit: Math.min(20, Math.max(0, limit)),
      semanticCandidateLimit: 80,
      lexicalCandidateLimit: 80,
      signal,
    });
    return results.map((result) => ({
      path: result.path,
      startLine: result.startLine,
      endLine: result.endLine,
      excerpt: result.excerpt,
      score: result.fusedScore,
    }));
  }
  relatedSnapshot(path: string): RelatedIndexSnapshot | null {
    const bundle = this.active;
    if (!bundle || this.unavailable) return null;
    const currentPath = normalizePath(path);
    const note = bundle.repository.getNote(currentPath);
    if (!note) return null;
    return {
      generationId: bundle.generationId,
      currentPath,
      contentHash: note.contentId,
      prepareQuery: async (signal) => {
        check(signal);
        const chunks = (await this.engine?.noteChunks(currentPath)) ?? [];
        if (!chunks.length) return null;
        const text = chunks
          .map((chunk) => chunk.text)
          .join("\n\n")
          .slice(0, CHUNK_SIZE);
        const sum = new Float64Array(this.embedding.dimensions);
        for (const chunk of chunks)
          for (let i = 0; i < sum.length; i++) sum[i] += chunk.vector[i] ?? 0;
        let norm = 0;
        for (const value of sum) norm += value * value;
        const divisor = Math.sqrt(norm);
        return {
          text,
          vector:
            divisor > 1e-12 ? Array.from(sum, (value) => value / divisor) : [...chunks[0].vector],
        };
      },
      search: async (query, vector, signal, limit) =>
        (
          await bundle.retriever.search({
            query,
            queryVector: vector,
            mode: "related",
            resultShape: "chunks",
            currentPath,
            limit: Math.min(128, limit),
            semanticCandidateLimit: 128,
            lexicalCandidateLimit: 0,
            signal,
          })
        ).map((result) => ({
          path: result.path,
          score: result.fusedScore,
          similarity: result.semanticScore,
          excerpt: result.excerpt,
          startLine: result.startLine,
          endLine: result.endLine,
        })),
    };
  }
  async upsert(path: string, signal: AbortSignal): Promise<void> {
    this.queueOperation({ kind: "modify", path });
    await this.reconcileQueuedChanges(signal);
  }
  async delete(path: string, signal: AbortSignal): Promise<void> {
    this.queueOperation({ kind: "delete", path });
    await this.reconcileQueuedChanges(signal);
  }
  invalidate(): void {
    this.unavailable = true;
  }
  markUnavailable(): void {
    this.unavailable = true;
  }
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.closed = true;
      await this.buildPromise?.catch(() => undefined);
      await this.engine?.close().catch(() => undefined);
      this.active = null;
    })();
    return this.closePromise;
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
  private emit(record: TramaDiagnosticRecord): void {
    emitTramaDiagnostic(this.diagnostics, record);
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
  private reportProgress(progress: IndexProgress): void {
    try {
      this.onProgress?.(progress);
    } catch {
      /* observational */
    }
    this.emit({
      area: "index",
      event: "index_operation",
      operation: progress.operation,
      stage: "started",
      phase: progress.phase,
      completed: progress.completed,
      ...(progress.total === undefined ? {} : { total: progress.total }),
      unit: progress.unit,
      determinate: progress.determinate,
      ...(progress.generationId ? { generation: progress.generationId } : {}),
    });
  }
}
