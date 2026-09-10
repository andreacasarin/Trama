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
import {
  CorpusStore,
  type CorpusSnapshot,
  type CorpusTransaction,
  type IncrementalChange,
} from "@/index/corpus/CorpusStore";
import { compareCodeUnits } from "@/index/corpus/CorpusManifest";
import { deriveNoteContentId, sha256Hex } from "@/index/corpus/Hash";
import { ExactVectorIndex } from "@/index/vector/ExactVectorIndex";
import { OramaLexicalIndex } from "@/index/lexical/OramaLexicalIndex";
import { Retriever, type RetrievalResult } from "@/index/retrieval/Retriever";
import type { IndexStorage } from "@/index/storage";
import {
  NOOP_TRAMA_DIAGNOSTICS,
  emitTramaDiagnostic,
  projectDiagnosticError,
  type TramaDiagnosticRecord,
  type TramaDiagnostics,
} from "@/diagnostics/TramaDiagnostics";

export interface IndexVaultDocument {
  readonly path: string;
  readonly content: string;
  readonly revision?: string;
}
export interface IndexVaultPort {
  listMarkdownPaths(signal: AbortSignal): Promise<readonly string[]>;
  readMarkdown(path: string, signal: AbortSignal): Promise<IndexVaultDocument>;
  /** Live plugin-owned index eligibility; omitted by non-Obsidian test ports. */
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
  readonly snapshot: CorpusSnapshot;
  readonly retriever: Retriever;
  readonly number: number;
  leases: number;
  retired: boolean;
  closePromise?: Promise<void>;
}

export interface LenteBundleLease {
  readonly generationId: string;
  readonly retriever: Retriever;
  search(
    query: string,
    mode: "hybrid" | "lexical",
    signal?: AbortSignal
  ): Promise<readonly RetrievalResult[]>;
  release(): Promise<void>;
}
interface FullIndexPlan {
  readonly paths: readonly string[];
  readonly estimatedTexts?: number;
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

export class IndexManager implements VaultSearchPort {
  private active: Bundle | null = null;
  private building = false;
  private loaded = false;
  private unavailable = false;
  private loadPromise?: Promise<boolean>;
  private buildPromise?: Promise<void>;
  private generation = 0;
  private epoch = 0;
  private revision = 0;
  private readonly queued = new Map<string, Queued>();
  private lastReconciliationPublished = false;
  private readonly corpus: CorpusStore;
  private readonly onProgress?: (progress: IndexProgress) => void;
  constructor(
    private readonly vault: IndexVaultPort,
    private readonly embedding: EmbeddingModel,
    storage: IndexStorage,
    private readonly embeddingBaseUrl: string,
    private readonly modelId: string,
    private readonly options: {
      readonly size?: number;
      readonly overlap?: number;
      readonly excludedPaths?: readonly string[];
      /** Fixed eligibility predicate for this index fingerprint. */
      readonly isIndexEligible?: (path: string) => boolean;
      readonly onProgress?: (progress: IndexProgress) => void;
    } = {},
    private readonly diagnostics: TramaDiagnostics = NOOP_TRAMA_DIAGNOSTICS
  ) {
    this.corpus = new CorpusStore(storage, diagnostics);
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
  isBuilding(): boolean {
    return this.building;
  }
  hasUsableIndex(): boolean {
    return this.active !== null && !this.unavailable;
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
        phase: "validate-corpus",
      });
    try {
      const snapshot = await this.corpus.load();
      if (observable)
        this.emit({
          area: "index",
          event: "index_operation",
          operation: "load",
          stage: "completed",
          phase: "validate-corpus",
          durationMs: Date.now() - started,
          generation: snapshot.generationId,
          counts: {
            notes: snapshot.notes.length,
            chunks: snapshot.notes.reduce((sum, note) => sum + note.chunkCount, 0),
          },
        });
      if (snapshot.fingerprint !== (await this.fingerprintId()))
        throw new Error("Index fingerprint mismatch");
      this.active = await this.derive(snapshot, 0, undefined, "startup");
      this.generation = 1;
      this.unavailable = false;
      if (observable)
        this.emit({
          area: "index",
          event: "index_operation",
          operation: "load",
          stage: "completed",
          durationMs: Date.now() - started,
          generation: snapshot.generationId,
        });
      return true;
    } catch (error) {
      this.active = null;
      this.unavailable = false;
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
  private async derive(
    snapshot: CorpusSnapshot,
    number: number,
    signal?: AbortSignal,
    operation: "full" | "incremental" | "startup" = "full"
  ): Promise<Bundle> {
    check(signal ?? new AbortController().signal);
    const chunkCount = snapshot.notes.reduce((sum, note) => sum + note.chunkCount, 0);
    const vectorStarted = Date.now();
    this.emit({
      area: "index",
      event: "index_operation",
      operation,
      stage: "started",
      phase: "build-vector",
      counts: { notes: snapshot.notes.length, chunks: chunkCount },
      generation: snapshot.generationId,
    });
    this.reportProgress(
      {
        operation,
        phase: "build-vector",
        completed: 0,
        total: chunkCount,
        unit: "chunks",
        determinate: true,
        generationId: snapshot.generationId,
      },
      operation !== "startup"
    );
    const vector = await ExactVectorIndex.open(snapshot);
    this.emit({
      area: "index",
      event: "index_operation",
      operation,
      stage: "completed",
      phase: "build-vector",
      durationMs: Date.now() - vectorStarted,
      counts: { chunks: chunkCount },
      generation: snapshot.generationId,
    });
    this.reportProgress(
      {
        operation,
        phase: "build-vector",
        completed: chunkCount,
        total: chunkCount,
        unit: "chunks",
        determinate: true,
        generationId: snapshot.generationId,
      },
      operation !== "startup"
    );
    try {
      const lexicalStarted = Date.now();
      this.emit({
        area: "index",
        event: "index_operation",
        operation,
        stage: "started",
        phase: "build-lexical",
        counts: { chunks: chunkCount },
        generation: snapshot.generationId,
      });
      this.reportProgress(
        {
          operation,
          phase: "build-lexical",
          completed: 0,
          total: chunkCount,
          unit: "chunks",
          determinate: true,
          generationId: snapshot.generationId,
        },
        operation !== "startup"
      );
      const lexical = await OramaLexicalIndex.build(snapshot, {
        signal,
        profile: "lente",
        onProgress: (progress) =>
          this.reportProgress(
            {
              operation,
              phase: "build-lexical",
              completed: progress.completed,
              total: progress.total,
              unit: "chunks",
              determinate: progress.total !== undefined,
              generationId: snapshot.generationId,
            },
            operation !== "startup"
          ),
      });
      this.emit({
        area: "index",
        event: "index_operation",
        operation,
        stage: "completed",
        phase: "build-lexical",
        durationMs: Date.now() - lexicalStarted,
        counts: { chunks: chunkCount },
        generation: snapshot.generationId,
      });
      try {
        return {
          snapshot,
          retriever: new Retriever({ snapshot, vector, lexical, embedding: this.embedding }),
          number,
          leases: 0,
          retired: false,
        };
      } catch (e) {
        await lexical.close();
        throw e;
      }
    } catch (e) {
      await vector.close();
      throw e;
    }
  }
  async build(signal: AbortSignal): Promise<void> {
    if (this.building) throw new StructuredError("busy", "Index rebuild is already running.", true);
    const run = this.buildInternal(signal);
    this.buildPromise = run;
    try {
      await run;
    } finally {
      if (this.buildPromise === run) this.buildPromise = undefined;
    }
  }
  /** Synchronizes the committed corpus, embedding only notes whose content changed. */
  async synchronize(signal: AbortSignal): Promise<void> {
    await this.synchronizeWithPublication(signal);
  }

  async synchronizeWithPublication(signal: AbortSignal): Promise<boolean> {
    if (this.building) throw new StructuredError("busy", "Index update is already running.", true);
    check(signal);
    if (!this.loaded) await this.load();
    if (!this.active || this.unavailable) {
      await this.build(signal);
      return true;
    }

    const paths = [...(await this.vault.listMarkdownPaths(signal))]
      .map(normalizePath)
      .filter((path) => this.isIndexEligible(path))
      .sort();
    const present = new Set(paths);
    for (const path of paths)
      this.queueOperation({ kind: this.active.snapshot.getNote(path) ? "modify" : "create", path });
    for (const note of this.active.snapshot.notes)
      if (!present.has(note.path)) this.queueOperation({ kind: "delete", path: note.path });
    return this.reconcileQueuedChangesWithPublication(signal);
  }

  async waitForBuild(): Promise<void> {
    await this.buildPromise;
  }
  private async buildInternal(signal: AbortSignal): Promise<void> {
    if (this.building) throw new StructuredError("busy", "Index rebuild is already running.", true);
    check(signal);
    this.building = true;
    this.corpus.enableDiagnostics();
    this.emit({
      area: "index",
      event: "index_operation",
      operation: "full",
      stage: "started",
      phase: "discover",
      completed: 0,
      unit: "paths",
      determinate: false,
    });
    this.reportProgress({
      operation: "full",
      phase: "discover",
      completed: 0,
      unit: "paths",
      determinate: false,
    });
    const epoch = ++this.epoch;
    const started = Date.now();
    let tx: CorpusTransaction | undefined;
    let bundle: Bundle | undefined;
    let encodedArtifacts = 0;
    try {
      if (!this.loaded) await this.load();
      const plan = await this.planFullIndex(signal);
      tx = await this.corpus.stage(this.noteInputs(plan, signal), await this.fingerprintId(), {
        signal,
        onProgress: (event) => {
          if (event.phase === "encode-write") {
            encodedArtifacts = Math.max(encodedArtifacts, event.completed);
          }
        },
      });
      this.reportProgress({
        operation: "full",
        phase: "encode-write",
        completed: encodedArtifacts,
        total: encodedArtifacts,
        unit: "artifacts",
        determinate: true,
        generationId: tx.snapshot.generationId,
      });
      this.reportProgress({
        operation: "full",
        phase: "validate",
        completed: 1,
        total: 1,
        unit: "artifacts",
        determinate: true,
        generationId: tx.snapshot.generationId,
      });
      check(signal);
      if (epoch !== this.epoch)
        throw new StructuredError("cancelled", "Index rebuild cancelled.", true);
      bundle = await this.derive(tx.snapshot, ++this.generation, signal);
      this.reportProgress({
        operation: "full",
        phase: "activate",
        completed: 0,
        total: 1,
        unit: "artifacts",
        determinate: true,
        generationId: tx.snapshot.generationId,
      });
      check(signal);
      await tx.commit();
      this.reportProgress({
        operation: "full",
        phase: "activate",
        completed: 1,
        total: 1,
        unit: "artifacts",
        determinate: true,
        generationId: tx.snapshot.generationId,
      });
      const published = bundle;
      bundle = undefined;
      await this.swap(published);
      this.unavailable = false;
      await this.collectGarbage("full", tx.snapshot.generationId);
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "build",
        stage: "published",
        generation: tx.snapshot.generationId,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      if (bundle) await bundle.retriever.close().catch(() => undefined);
      if (tx) await tx.abort().catch(() => undefined);
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
  private async planFullIndex(signal: AbortSignal): Promise<FullIndexPlan> {
    const paths = [...(await this.vault.listMarkdownPaths(signal))]
      .map(normalizePath)
      .filter((path) => this.isIndexEligible(path))
      .sort();
    this.reportProgress({
      operation: "full",
      phase: "discover",
      completed: paths.length,
      total: paths.length,
      unit: "paths",
      determinate: true,
    });
    const estimatedTexts = await this.vault.estimateMarkdownTextCount?.(
      paths,
      this.options.size ?? CHUNK_SIZE,
      this.options.overlap ?? CHUNK_OVERLAP,
      signal
    );
    this.reportProgress({
      operation: "full",
      phase: "read",
      completed: paths.length,
      total: paths.length,
      unit: "notes",
      determinate: true,
      estimated: true,
    });
    this.reportProgress({
      operation: "full",
      phase: "chunk",
      completed: 0,
      ...(estimatedTexts === undefined ? {} : { total: estimatedTexts }),
      unit: "texts",
      determinate: estimatedTexts !== undefined,
      estimated: estimatedTexts !== undefined,
    });
    return { paths, ...(estimatedTexts === undefined ? {} : { estimatedTexts }) };
  }

  private async *noteInputs(
    plan: FullIndexPlan,
    signal: AbortSignal
  ): AsyncIterable<{
    path: string;
    contentId: string;
    records: Array<{
      ordinal: number;
      startLine: number;
      endLine: number;
      text: string;
      vector: readonly number[];
    }>;
  }> {
    const fingerprint = await this.fingerprintId();
    let embedded = 0;
    const estimateFields = (completed: number) =>
      plan.estimatedTexts !== undefined && completed <= plan.estimatedTexts
        ? { total: plan.estimatedTexts, determinate: true as const, estimated: true }
        : { determinate: false as const };
    this.reportProgress({
      operation: "full",
      phase: "embed",
      completed: 0,
      ...estimateFields(0),
      unit: "texts",
    });
    for (const path of plan.paths) {
      check(signal);
      if (!this.isIndexEligible(path)) continue;
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
            chunks.map((c) => c.text),
            signal,
            (progress) =>
              this.reportProgress({
                operation: "full",
                phase: "embed",
                completed: embedded + progress.completed,
                ...estimateFields(embedded + progress.completed),
                unit: "texts",
              })
          )
        : [];
      embedded += chunks.length;
      this.reportProgress({
        operation: "full",
        phase: "embed",
        completed: embedded,
        ...estimateFields(embedded),
        unit: "texts",
      });
      if (
        vectors.length !== chunks.length ||
        vectors.some((v) => v.length !== this.embedding.dimensions)
      )
        throw new StructuredError(
          "internal",
          "Embedding dimensions changed during indexing.",
          false
        );
      yield {
        path,
        contentId: await deriveNoteContentId(fingerprint, doc.content),
        records: chunks.map((c, i) => ({ ...c, ordinal: i, vector: vectors[i] })),
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
  private async swap(bundle: Bundle): Promise<void> {
    const old = this.active;
    this.active = bundle;
    if (old) await this.retireBundle(old);
  }

  /** Acquires a generation-stable reader for Lente. Retired bundles remain alive until release. */
  acquireLenteLease(): LenteBundleLease | null {
    const bundle = this.active;
    if (!bundle || this.unavailable) return null;
    bundle.leases++;
    let released = false;
    return {
      generationId: bundle.snapshot.generationId,
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
        if (bundle.retired && bundle.leases === 0) await this.closeBundle(bundle);
      },
    };
  }

  /** Feature-specific Lente retrieval entry point; RAG search remains unchanged. */
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

  private async closeBundle(bundle: Bundle): Promise<void> {
    if (!bundle.closePromise) bundle.closePromise = bundle.retriever.close();
    await bundle.closePromise;
  }

  private async retireBundle(bundle: Bundle): Promise<void> {
    bundle.retired = true;
    if (bundle.leases === 0) await this.closeBundle(bundle);
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
    if (this.building) {
      await this.buildPromise;
      return this.reconcileQueuedChangesWithPublication(signal);
    }
    if (!this.active || this.unavailable) {
      await this.build(signal);
      return true;
    }
    const run = this.reconcileIncremental(signal);
    const pending = run.then(() => undefined);
    this.buildPromise = pending;
    void pending.catch(() => undefined);
    try {
      return await run;
    } finally {
      if (this.buildPromise === pending) this.buildPromise = undefined;
    }
  }
  private async reconcileIncremental(signal: AbortSignal): Promise<boolean> {
    if (this.building)
      throw new StructuredError("busy", "Index reconciliation is already running.", true);
    const captured = new Map(this.queued);
    this.building = true;
    this.corpus.enableDiagnostics();
    this.emit({
      area: "index",
      event: "index_operation",
      operation: "incremental",
      stage: "started",
      phase: "discover",
      completed: 0,
      unit: "paths",
      determinate: false,
    });
    const epoch = ++this.epoch;
    let tx: CorpusTransaction | undefined;
    let bundle: Bundle | undefined;
    let encodedArtifacts = 0;
    try {
      const base = this.active?.snapshot;
      if (!base) throw new Error("Index base is unavailable");
      const fingerprint = await this.fingerprintId();
      const present = new Set(
        (await this.vault.listMarkdownPaths(signal))
          .map(normalizePath)
          .filter((path) => this.isIndexEligible(path))
      );
      const virtualNotes = new Map(base.notes.map((note) => [note.path, note.contentId]));
      const changes: IncrementalChange[] = [];
      const operations = [...captured.values()].sort((a, b) => a.revision - b.revision);
      const readableState = new Set(base.notes.map((note) => note.path));
      let readable = 0;
      for (const { operation } of operations) {
        const path = normalizePath(operation.path);
        if (operation.kind === "rename") {
          const oldPath = normalizePath(operation.oldPath);
          if (!present.has(path)) readableState.delete(oldPath);
          else if (readableState.delete(oldPath)) readableState.add(path);
          else {
            readable++;
            readableState.add(path);
          }
        } else if (operation.kind === "delete" || !present.has(path)) {
          readableState.delete(path);
        } else if (operation.kind !== "unchanged") {
          readable++;
          readableState.add(path);
        }
      }
      this.reportProgress({
        operation: "incremental",
        phase: "discover",
        completed: captured.size,
        total: captured.size,
        unit: "paths",
        determinate: true,
      });
      this.reportProgress({
        operation: "incremental",
        phase: "read",
        completed: 0,
        total: readable,
        unit: "notes",
        determinate: true,
      });
      this.reportProgress({
        operation: "incremental",
        phase: "chunk",
        completed: 0,
        unit: "chunks",
        determinate: false,
      });
      this.reportProgress({
        operation: "incremental",
        phase: "embed",
        completed: 0,
        unit: "texts",
        determinate: false,
      });
      let read = 0;
      let chunked = 0;
      let embedded = 0;
      for (const { operation } of operations) {
        check(signal);
        let readableOperation = operation;
        if (operation.kind === "rename") {
          const oldPath = normalizePath(operation.oldPath);
          const newPath = normalizePath(operation.path);
          if (!present.has(newPath)) {
            changes.push({ type: "delete", path: oldPath });
            virtualNotes.delete(oldPath);
            continue;
          }
          const oldContentId = virtualNotes.get(oldPath);
          if (oldContentId) {
            changes.push({ type: "rename", path: newPath, previousPath: oldPath });
            virtualNotes.delete(oldPath);
            virtualNotes.set(newPath, oldContentId);
            continue;
          }
          // A rename can be observed while a full build is still reading its old
          // discovery snapshot. If the old path was skipped, index the new path.
          readableOperation = { kind: "create", path: newPath };
        }
        const path = normalizePath(readableOperation.path);
        if (readableOperation.kind === "unchanged") continue;
        if (
          readableOperation.kind === "delete" ||
          !present.has(path) ||
          !this.isIndexEligible(path)
        ) {
          changes.push({ type: "delete", path });
          virtualNotes.delete(path);
          continue;
        }
        const doc = await this.readMarkdownIfAvailable(path, signal, "incremental");
        if (!doc) {
          changes.push({ type: "delete", path });
          virtualNotes.delete(path);
          continue;
        }
        read++;
        this.reportProgress({
          operation: "incremental",
          phase: "read",
          completed: read,
          total: readable,
          unit: "notes",
          determinate: true,
        });
        const contentId = await deriveNoteContentId(fingerprint, doc.content);
        if (virtualNotes.get(path) === contentId) continue;
        const chunks = chunkMarkdown(
          doc.content,
          this.options.size ?? CHUNK_SIZE,
          this.options.overlap ?? CHUNK_OVERLAP,
          signal
        );
        chunked += chunks.length;
        this.reportProgress({
          operation: "incremental",
          phase: "chunk",
          completed: chunked,
          unit: "chunks",
          determinate: false,
        });
        const vectors =
          readableOperation.kind === "empty" || chunks.length === 0
            ? []
            : await this.embedding.embed(
                chunks.map((c) => c.text),
                signal,
                (progress) =>
                  this.reportProgress({
                    operation: "incremental",
                    phase: "embed",
                    completed: embedded + progress.completed,
                    unit: "texts",
                    determinate: false,
                  })
              );
        embedded += chunks.length;
        this.reportProgress({
          operation: "incremental",
          phase: "embed",
          completed: embedded,
          unit: "texts",
          determinate: false,
        });
        if (vectors.length !== chunks.length) throw new Error("Embedding count mismatch");
        changes.push({
          type: readableOperation.kind === "empty" ? "empty" : readableOperation.kind,
          path,
          note: {
            path,
            contentId,
            records: chunks.map((c, i) => ({ ...c, ordinal: i, vector: vectors[i] })),
          },
        });
        virtualNotes.set(path, contentId);
      }
      this.reportProgress({
        operation: "incremental",
        phase: "chunk",
        completed: chunked,
        total: chunked,
        unit: "chunks",
        determinate: true,
      });
      this.reportProgress({
        operation: "incremental",
        phase: "embed",
        completed: embedded,
        total: embedded,
        unit: "texts",
        determinate: true,
      });
      if (changes.length === 0) {
        for (const [key, value] of captured)
          if (this.queued.get(key)?.revision === value.revision) this.queued.delete(key);
        this.emit({
          area: "index",
          event: "index_operation",
          operation: "incremental",
          stage: "completed",
          counts: { changes: 0 },
        });
        return false;
      }
      tx = await this.corpus.stageIncremental(base, changes, fingerprint, {
        signal,
        onProgress: (event) => {
          if (event.phase === "encode-write") {
            encodedArtifacts = Math.max(encodedArtifacts, event.completed);
            this.reportProgress({
              operation: "incremental",
              phase: "encode-write",
              completed: encodedArtifacts,
              unit: "artifacts",
              determinate: false,
            });
          } else {
            this.reportProgress({
              operation: "incremental",
              phase: "validate",
              completed: event.completed,
              ...(event.total === undefined ? {} : { total: event.total }),
              unit: "artifacts",
              determinate: event.total !== undefined,
            });
          }
        },
      });
      this.reportProgress({
        operation: "incremental",
        phase: "encode-write",
        completed: encodedArtifacts,
        total: encodedArtifacts,
        unit: "artifacts",
        determinate: true,
        generationId: tx.snapshot.generationId,
      });
      this.reportProgress({
        operation: "incremental",
        phase: "validate",
        completed: 1,
        total: 1,
        unit: "artifacts",
        determinate: true,
        generationId: tx.snapshot.generationId,
      });
      check(signal);
      if (epoch !== this.epoch)
        throw new StructuredError("cancelled", "Index reconciliation cancelled.", true);
      bundle = await this.derive(tx.snapshot, ++this.generation, signal, "incremental");
      check(signal);
      this.reportProgress({
        operation: "incremental",
        phase: "activate",
        completed: 0,
        total: 1,
        unit: "artifacts",
        determinate: true,
        generationId: tx.snapshot.generationId,
      });
      await tx.commit();
      this.reportProgress({
        operation: "incremental",
        phase: "activate",
        completed: 1,
        total: 1,
        unit: "artifacts",
        determinate: true,
        generationId: tx.snapshot.generationId,
      });
      const published = bundle;
      bundle = undefined;
      await this.swap(published);
      await this.collectGarbage("incremental", tx.snapshot.generationId);
      for (const [key, value] of captured)
        if (this.queued.get(key)?.revision === value.revision) this.queued.delete(key);
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "incremental",
        stage: "published",
        generation: tx.snapshot.generationId,
        counts: { changes: captured.size },
      });
      return true;
    } catch (error) {
      if (bundle) await bundle.retriever.close().catch(() => undefined);
      if (tx) await tx.abort().catch(() => undefined);
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "incremental",
        stage: signal.aborted ? "cancelled" : "failed",
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
    return results.map((r) => this.provenance(r));
  }
  relatedSnapshot(path: string): RelatedIndexSnapshot | null {
    const bundle = this.active;
    if (!bundle || this.unavailable) return null;
    const currentPath = normalizePath(path);
    const note = bundle.snapshot.getNote(currentPath);
    if (!note) return null;
    return {
      generationId: bundle.snapshot.generationId,
      currentPath,
      contentHash: note.contentId,
      prepareQuery: async (signal) => {
        check(signal);
        const textParts: string[] = [];
        let textLength = 0;
        let vectorSum: Float64Array | undefined;
        let firstVector: readonly number[] | Float32Array | undefined;
        let vectorCount = 0;
        for (const view of await bundle.snapshot.hydrateNote(currentPath)) {
          for (const record of view.segment.records) {
            check(signal);
            if (!vectorSum) vectorSum = new Float64Array(record.vector.length);
            if (record.vector.length !== vectorSum.length)
              throw new StructuredError(
                "internal",
                "Related-note vector dimensions changed within the committed note.",
                false
              );
            firstVector ??= record.vector;
            for (let i = 0; i < vectorSum.length; i++) vectorSum[i] += record.vector[i];
            vectorCount++;
            if (textLength < CHUNK_SIZE) {
              const separator = textParts.length ? "\n\n" : "";
              const remaining = CHUNK_SIZE - textLength - separator.length;
              if (remaining > 0) {
                const piece = record.text.slice(0, remaining);
                if (piece) {
                  textParts.push(`${separator}${piece}`);
                  textLength += separator.length + piece.length;
                }
              }
            }
          }
        }
        if (!vectorSum || !firstVector || vectorCount === 0) return null;
        let normSquared = 0;
        for (const value of vectorSum) normSquared += value * value;
        const norm = Math.sqrt(normSquared);
        const vector =
          norm > 1e-12 ? Array.from(vectorSum, (value) => value / norm) : Array.from(firstVector);
        return { text: textParts.join(""), vector };
      },
      search: async (query, vector, signal, limit) =>
        (
          await bundle.retriever.search({
            query,
            queryVector: vector,
            // Related-note lookup runs automatically when the active note
            // changes. Use its committed aggregate vector so this path
            // never invokes Orama's synchronous whole-index text search
            // on Obsidian's renderer thread.
            mode: "related",
            resultShape: "chunks",
            currentPath,
            limit: Math.min(128, limit),
            semanticCandidateLimit: 128,
            lexicalCandidateLimit: 0,
            signal,
          })
        ).map((r) => ({
          path: r.path,
          score: r.fusedScore,
          ...(r.semanticScore === undefined ? {} : { similarity: r.semanticScore }),
          excerpt: r.excerpt,
          startLine: r.startLine,
          endLine: r.endLine,
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
    this.epoch++;
    this.unavailable = true;
    const old = this.active;
    this.active = null;
    if (old) void this.retireBundle(old);
  }
  markUnavailable(): void {
    this.unavailable = true;
    const old = this.active;
    this.active = null;
    if (old) void this.retireBundle(old);
  }
  private provenance(r: RetrievalResult): ProvenanceRecord {
    return {
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      excerpt: r.excerpt,
      score: r.fusedScore,
    };
  }

  /** Eligibility is fixed for this manager and applied only while constructing the corpus. */
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
        // Preserve the original read error when availability cannot be checked.
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
  private reportProgress(progress: IndexProgress, emitDiagnostic = true): void {
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
      this.onProgress?.(progress);
    } catch {
      // Progress is observational and must not affect indexing.
    }
  }

  private async collectGarbage(
    operation: "full" | "incremental",
    generationId: string
  ): Promise<void> {
    this.reportProgress({
      operation,
      phase: "GC",
      completed: 0,
      unit: "artifacts",
      determinate: false,
      generationId,
    });
    try {
      const result = await this.corpus.collectGarbage((event) =>
        this.reportProgress({
          operation,
          phase: "GC",
          completed: event.completed,
          ...(event.total === undefined ? {} : { total: event.total }),
          unit: "artifacts",
          determinate: event.total !== undefined,
          generationId,
        })
      );
      this.reportProgress({
        operation,
        phase: "GC",
        completed: result.removed,
        total: result.removed,
        unit: "artifacts",
        determinate: true,
        generationId,
      });
    } catch (error) {
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "GC",
        stage: "failed",
        error: projectDiagnosticError(error),
      });
    }
  }
}
