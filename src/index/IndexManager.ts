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
import { compareCodeUnits } from "@/index/Ordering";
import { deriveNoteContentId, sha256Hex } from "@/index/Hash";
import {
  normalizeIndexPath,
  oramaDocumentId,
  parseOramaDocumentId,
  publicChunkId,
} from "@/index/Identity";
import {
  countOramaDocuments,
  getOramaDocument,
  insertOramaDocuments,
  removeOramaDocuments,
} from "@/index/orama/OramaDatabase";
import { OramaProjection } from "@/index/orama/OramaProjection";
import {
  createSnapshotEnvelope,
  decodeSnapshot,
  encodeSnapshot,
  loadAndValidateSnapshot,
  SNAPSHOT_DIMENSIONS,
} from "@/index/orama/SnapshotCodec";
import type { OramaCatalog, OramaCatalogNote, OramaDocument } from "@/index/orama/OramaTypes";
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

export type RevisionOperation =
  | { readonly kind: "create" | "modify" | "delete" | "empty" | "unchanged"; readonly path: string }
  | { readonly kind: "rename"; readonly oldPath: string; readonly path: string };

interface Queued {
  readonly operation: RevisionOperation;
  readonly revision: number;
}

interface FullIndexPlan {
  readonly paths: readonly string[];
  readonly estimatedTexts?: number;
}

interface DesiredNote {
  readonly path: string;
  readonly content: string;
  readonly contentId: string;
}

function normalizePath(path: string): string {
  return normalizeIndexPath(path);
}

function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort(compareCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported fingerprint value");
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StructuredError("cancelled", "Index operation cancelled.", true);
}

function normalizeVector(vector: readonly number[], dimensions: number): number[] {
  if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)))
    throw new StructuredError("internal", "Embedding dimensions changed during indexing.", false);
  let normSquared = 0;
  for (const value of vector) normSquared += value * value;
  const norm = Math.sqrt(normSquared);
  if (!(norm > 1e-12)) throw new StructuredError("internal", "Embedding norm is zero.", false);
  return vector.map((value) => value / norm);
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

/** One mutable Orama projection with availability-first reconciliation. */
export class IndexManager implements VaultSearchPort {
  readonly projection = new OramaProjection();
  private readonly retriever: Retriever;
  private readonly notes = new Map<string, OramaCatalogNote>();
  private readonly knownIds = new Set<string>();
  private readonly queued = new Map<string, Queued>();
  private readonly storage: IndexStorage;
  private readonly onProgress?: (progress: IndexProgress) => void;
  private building = false;
  private loaded = false;
  private unavailable = false;
  private loadPromise?: Promise<boolean>;
  private buildPromise?: Promise<void>;
  private queueRevision = 0;
  private snapshotRevision = 0;
  private durableRevision = 0;
  private epoch = 0;
  private lastReconciliationPublished = false;

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
      readonly isIndexEligible?: (path: string) => boolean;
      readonly onProgress?: (progress: IndexProgress) => void;
    } = {},
    private readonly diagnostics: TramaDiagnostics = NOOP_TRAMA_DIAGNOSTICS
  ) {
    this.storage = storage;
    this.onProgress = options.onProgress;
    this.retriever = new Retriever({ projection: this.projection, embedding });
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
    return this.projection.ready && !this.unavailable;
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
      const raw = await this.storage.read("index.json");
      if (!raw) return false;
      const fingerprint = await this.fingerprintId();
      const loaded = await loadAndValidateSnapshot(raw, fingerprint);
      if (loaded.envelope.catalog.fingerprint !== fingerprint)
        throw new Error("Orama snapshot fingerprint mismatch");
      this.replaceCatalog(loaded.envelope.catalog);
      this.knownIds.clear();
      for (const note of loaded.envelope.catalog.notes)
        for (const id of note.documentIds) this.knownIds.add(id);
      this.snapshotRevision = loaded.envelope.snapshotRevision;
      this.durableRevision = this.snapshotRevision;
      this.projection.attach(
        loaded.db,
        loaded.envelope.catalog,
        fingerprint,
        loaded.envelope.dimensions,
        this.snapshotRevision,
        true,
        false
      );
      this.unavailable = false;
      if (observable)
        this.emit({
          area: "index",
          event: "index_operation",
          operation: "load",
          stage: "completed",
          phase: "validate-corpus",
          durationMs: Date.now() - started,
          generation: String(this.snapshotRevision),
          counts: {
            notes: loaded.envelope.catalog.noteCount,
            chunks: loaded.envelope.catalog.chunkCount,
          },
        });
      return true;
    } catch (error) {
      this.projection.detach();
      this.notes.clear();
      this.knownIds.clear();
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

  async synchronize(signal: AbortSignal): Promise<void> {
    await this.synchronizeWithPublication(signal);
  }

  async synchronizeWithPublication(signal: AbortSignal): Promise<boolean> {
    if (this.building) throw new StructuredError("busy", "Index update is already running.", true);
    check(signal);
    if (!this.loaded) await this.load();
    if (!this.projection.ready || this.unavailable) {
      await this.build(signal);
      return true;
    }
    const run = this.runUpdate(signal, new Map(this.queued));
    const wait = run.then(
      () => undefined,
      () => undefined
    );
    this.buildPromise = wait;
    try {
      return await run;
    } finally {
      if (this.buildPromise === wait) this.buildPromise = undefined;
    }
  }

  async waitForBuild(): Promise<void> {
    await this.buildPromise;
  }

  private async buildInternal(signal: AbortSignal): Promise<void> {
    if (this.building) throw new StructuredError("busy", "Index rebuild is already running.", true);
    this.building = true;
    const started = Date.now();
    const epoch = ++this.epoch;
    try {
      if (!this.loaded) await this.load();
      const queueBoundary = this.queueRevision;
      const plan = await this.planFullIndex(signal);
      await this.ensureProjection();
      const paths = plan.paths;
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "build",
        stage: "started",
        phase: "build-vector",
        generation: this.generationId(),
      });
      const changed = await this.reconcilePaths(paths, signal, true, plan.estimatedTexts);
      check(signal);
      if (epoch !== this.epoch)
        throw new StructuredError("cancelled", "Index rebuild cancelled.", true);
      await this.verifyConvergence(signal);
      await this.saveSnapshot("rebuild", signal);
      this.clearQueueThrough(queueBoundary);
      this.unavailable = false;
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "build",
        stage: "published",
        generation: this.generationId(),
        durationMs: Date.now() - started,
        counts: {
          changes: changed ? 1 : 0,
          notes: this.projection.catalog.noteCount,
          chunks: this.projection.catalog.chunkCount,
        },
      });
    } catch (error) {
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

  private async runUpdate(signal: AbortSignal, captured: Map<string, Queued>): Promise<boolean> {
    if (this.building)
      throw new StructuredError("busy", "Index reconciliation is already running.", true);
    this.building = true;
    const started = Date.now();
    const epoch = ++this.epoch;
    try {
      const paths = await this.discoverPaths(signal);
      const changed = await this.reconcilePaths(paths, signal, false);
      check(signal);
      if (epoch !== this.epoch)
        throw new StructuredError("cancelled", "Index reconciliation cancelled.", true);
      if (!changed && !this.projection.dirty && this.projection.complete) {
        this.clearCapturedQueue(captured);
        this.lastReconciliationPublished = false;
        this.emit({
          area: "index",
          event: "index_operation",
          operation: "incremental",
          stage: "completed",
          counts: { changes: 0 },
        });
        return false;
      }
      await this.verifyConvergence(signal);
      await this.saveSnapshot("update", signal);
      this.clearCapturedQueue(captured);
      this.lastReconciliationPublished = true;
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "incremental",
        stage: "published",
        generation: this.generationId(),
        durationMs: Date.now() - started,
        counts: {
          changes: changed ? 1 : 0,
          notes: this.projection.catalog.noteCount,
          chunks: this.projection.catalog.chunkCount,
        },
      });
      return true;
    } catch (error) {
      this.lastReconciliationPublished = false;
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "incremental",
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
    const paths = await this.discoverPaths(signal);
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

  private async discoverPaths(signal: AbortSignal): Promise<string[]> {
    const paths = new Set<string>();
    for (const raw of await this.vault.listMarkdownPaths(signal)) {
      check(signal);
      try {
        const path = normalizePath(raw);
        if (this.isIndexEligible(path)) paths.add(path);
      } catch {
        // Invalid or non-Markdown paths are ignored by the index boundary.
      }
    }
    return [...paths].sort(compareCodeUnits);
  }

  private async ensureProjection(): Promise<void> {
    if (this.projection.ready) return;
    if (this.embedding.dimensions !== SNAPSHOT_DIMENSIONS)
      throw new StructuredError(
        "internal",
        `Unified Orama requires ${SNAPSHOT_DIMENSIONS} embedding dimensions.`,
        false
      );
    const fingerprint = await this.fingerprintId();
    const db = await (
      await import("@/index/orama/OramaDatabase")
    ).createOramaDatabase(this.embedding.dimensions);
    const catalog = this.makeCatalog([], fingerprint);
    this.replaceCatalog(catalog);
    this.projection.attach(
      db,
      catalog,
      fingerprint,
      this.embedding.dimensions,
      Math.max(1, this.snapshotRevision),
      false,
      false
    );
  }

  private async reconcilePaths(
    paths: readonly string[],
    signal: AbortSignal,
    force: boolean,
    estimatedTexts?: number
  ): Promise<boolean> {
    const desired = new Set(paths);
    const missingByContent = new Map<string, string[]>();
    if (!force) {
      for (const note of this.notes.values())
        if (!desired.has(note.path)) {
          const entries = missingByContent.get(note.contentId) ?? [];
          entries.push(note.path);
          missingByContent.set(note.contentId, entries);
        }
      for (const entries of missingByContent.values()) entries.sort(compareCodeUnits);
    }
    let changed = false;
    let embedded = 0;
    let estimateExceeded = false;
    for (const path of paths) {
      check(signal);
      const document = await this.readMarkdownIfAvailable(
        path,
        signal,
        force ? "full" : "incremental"
      );
      if (!document) continue;
      const contentId = await deriveNoteContentId(await this.fingerprintId(), document.content);
      const prior = this.notes.get(path);
      if (!force && prior?.contentId === contentId && this.hasCompleteNote(prior)) continue;
      if (!force && !prior) {
        const candidates = missingByContent.get(contentId);
        const oldPath = candidates?.shift();
        if (oldPath && this.notes.has(oldPath) && (await this.renamePath(oldPath, path, signal))) {
          changed = true;
          continue;
        }
      }
      const chunks = chunkMarkdown(
        document.content,
        this.options.size ?? CHUNK_SIZE,
        this.options.overlap ?? CHUNK_OVERLAP,
        signal
      );
      const vectors = chunks.length
        ? await this.embedding.embed(
            chunks.map((chunk) => chunk.text),
            signal
          )
        : [];
      embedded += vectors.length;
      if (estimatedTexts !== undefined && embedded > estimatedTexts) estimateExceeded = true;
      this.reportProgress({
        operation: force ? "full" : "incremental",
        phase: "embed",
        completed: embedded,
        ...(estimatedTexts === undefined || estimateExceeded ? {} : { total: estimatedTexts }),
        unit: "texts",
        determinate: estimatedTexts !== undefined && !estimateExceeded,
        estimated: estimatedTexts !== undefined && !estimateExceeded,
      });
      if (vectors.length !== chunks.length)
        throw new StructuredError("internal", "Embedding count mismatch.", false);
      const documents: OramaDocument[] = chunks.map((chunk, ordinal) => ({
        id: oramaDocumentId(path, ordinal),
        path,
        contentId,
        chunkId: publicChunkId(contentId, ordinal),
        ordinal,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        filename: path.slice(path.lastIndexOf("/") + 1),
        pathText: path,
        body: chunk.text,
        embedding: normalizeVector(vectors[ordinal] ?? [], this.embedding.dimensions),
      }));
      changed = (await this.replaceNote(path, documents, contentId, signal)) || changed;
    }
    for (const note of [...this.notes.values()]) {
      check(signal);
      if (!desired.has(note.path)) changed = (await this.removePath(note.path, signal)) || changed;
    }
    this.reportProgress({
      operation: force ? "full" : "incremental",
      phase: "embed",
      completed: embedded,
      total: embedded,
      unit: "texts",
      determinate: true,
    });
    return changed;
  }

  private hasCompleteNote(note: OramaCatalogNote): boolean {
    if (note.documentIds.length !== note.chunkCount) return false;
    if (!this.projection.ready) return false;
    return note.documentIds.every((id) => {
      const document = getOramaDocument(this.projection.db, id);
      return Boolean(
        document && document.path === note.path && document.contentId === note.contentId
      );
    });
  }

  private async replaceNote(
    path: string,
    documents: readonly OramaDocument[],
    contentId: string,
    signal: AbortSignal
  ): Promise<boolean> {
    const previous = this.notes.get(path);
    const ids = this.idsForPath(path, previous);
    if (!ids.length && !documents.length && !previous) return false;
    this.markDirty();
    if (ids.length) await this.removeIds(ids, signal);
    if (documents.length) await this.insertDocuments(documents, signal);
    if (documents.length) {
      this.notes.set(path, {
        path,
        contentId,
        chunkCount: documents.length,
        documentIds: documents.map((document) => document.id),
      });
    } else this.notes.delete(path);
    this.refreshCatalog(false, true);
    return true;
  }

  private async renamePath(
    oldPath: string,
    newPath: string,
    signal: AbortSignal
  ): Promise<boolean> {
    const previous = this.notes.get(oldPath);
    if (!previous) return false;
    const source = previous.documentIds
      .map((id) => getOramaDocument(this.projection.db, id))
      .filter((document): document is OramaDocument => Boolean(document));
    if (source.length !== previous.documentIds.length) return false;
    const renamed = source.map((document) => ({
      ...document,
      id: oramaDocumentId(newPath, document.ordinal),
      path: newPath,
      filename: newPath.slice(newPath.lastIndexOf("/") + 1),
      pathText: newPath,
    }));
    this.markDirty();
    await this.removeIds(previous.documentIds, signal);
    await this.insertDocuments(renamed, signal);
    this.notes.delete(oldPath);
    this.notes.set(newPath, {
      path: newPath,
      contentId: previous.contentId,
      chunkCount: renamed.length,
      documentIds: renamed.map((document) => document.id),
    });
    this.refreshCatalog(false, true);
    return true;
  }

  private async removePath(path: string, signal: AbortSignal): Promise<boolean> {
    const previous = this.notes.get(path);
    const ids = this.idsForPath(path, previous);
    if (!previous && !ids.length) return false;
    this.markDirty();
    if (ids.length) await this.removeIds(ids, signal);
    this.notes.delete(path);
    this.refreshCatalog(false, true);
    return true;
  }

  private idsForPath(path: string, note?: OramaCatalogNote): string[] {
    const ids = new Set(note?.documentIds ?? []);
    for (const id of this.knownIds) {
      try {
        if (parseOramaDocumentId(id).path === path) ids.add(id);
      } catch {
        // Unknown IDs are never addressed by the public projection.
      }
    }
    return [...ids].sort(compareCodeUnits);
  }

  private async removeIds(ids: readonly string[], signal: AbortSignal): Promise<void> {
    for (let offset = 0; offset < ids.length; offset += 64) {
      check(signal);
      const batch = ids.slice(offset, offset + 64);
      try {
        await this.projection.withGate(() => removeOramaDocuments(this.projection.db, batch));
      } catch (error) {
        this.trackKnownIds(batch);
        throw error;
      }
      for (const id of batch)
        if (!getOramaDocument(this.projection.db, id)) this.knownIds.delete(id);
      await macrotask();
    }
  }

  private async insertDocuments(
    documents: readonly OramaDocument[],
    signal: AbortSignal
  ): Promise<void> {
    for (let offset = 0; offset < documents.length; offset += 64) {
      check(signal);
      const batch = documents.slice(offset, offset + 64);
      try {
        await this.projection.withGate(() =>
          insertOramaDocuments(this.projection.db, batch, batch.length)
        );
      } catch (error) {
        this.trackKnownIds(batch.map((document) => document.id));
        throw error;
      }
      this.trackKnownIds(batch.map((document) => document.id));
      await macrotask();
    }
  }

  private trackKnownIds(ids: readonly string[]): void {
    for (const id of ids) if (getOramaDocument(this.projection.db, id)) this.knownIds.add(id);
  }

  private async verifyConvergence(signal: AbortSignal): Promise<void> {
    check(signal);
    const expected = new Set<string>();
    for (const note of this.notes.values()) for (const id of note.documentIds) expected.add(id);
    const orphanIds = [...this.knownIds].filter(
      (id) => !expected.has(id) && getOramaDocument(this.projection.db, id)
    );
    if (orphanIds.length) {
      this.markDirty();
      await this.removeIds(orphanIds.sort(compareCodeUnits), signal);
    }
    const catalog = this.refreshCatalog(true, true);
    if (countOramaDocuments(this.projection.db) !== catalog.chunkCount)
      throw new Error("Orama convergence count mismatch");
    for (const note of catalog.notes) {
      if (note.documentIds.length !== note.chunkCount)
        throw new Error("Orama convergence catalog mismatch");
      for (const id of note.documentIds) {
        const document = getOramaDocument(this.projection.db, id);
        if (!document || document.path !== note.path || document.contentId !== note.contentId)
          throw new Error("Orama convergence document mismatch");
      }
    }
    const actualKnown = [...this.knownIds].filter((id) => getOramaDocument(this.projection.db, id));
    if (actualKnown.length !== expected.size || actualKnown.some((id) => !expected.has(id)))
      throw new Error("Orama convergence identity mismatch");
    this.projection.update(catalog, this.projection.revision, true, this.projection.dirty);
  }

  private async saveSnapshot(operation: "update" | "rebuild", signal: AbortSignal): Promise<void> {
    if (!this.projection.ready || !this.projection.complete)
      throw new Error("Cannot save an incomplete Orama projection");
    const fingerprint = await this.fingerprintId();
    await this.storage.prepare?.();
    const replacementCapability = await this.storage.verifyReplaceCapability?.();
    if (
      !replacementCapability ||
      replacementCapability.operation !== "same-directory-overwrite" ||
      replacementCapability.atomicity !== "single-rename-platform-assumption"
    )
      throw new StructuredError(
        "internal",
        "A verified same-directory index replacement capability is required.",
        true
      );
    await this.projection.withGate(async () => {
      const envelope = createSnapshotEnvelope(
        this.projection.catalog,
        fingerprint,
        this.projection.dimensions,
        this.projection.revision,
        operation,
        this.projection.db
      );
      const encoded = encodeSnapshot(envelope);
      this.reportProgress({
        operation: operation === "rebuild" ? "full" : "incremental",
        phase: "encode-write",
        completed: 0,
        total: 2,
        unit: "artifacts",
        determinate: true,
        generationId: this.generationId(),
      });
      try {
        await this.storage.write("index.json.tmp", encoded);
        const readBack = await this.storage.read("index.json.tmp");
        if (readBack !== encoded) throw new Error("Orama temporary snapshot readback mismatch");
        const loaded = await loadAndValidateSnapshot(readBack ?? "", fingerprint, signal);
        this.reportProgress({
          operation: operation === "rebuild" ? "full" : "incremental",
          phase: "validate",
          completed: 1,
          total: 1,
          unit: "artifacts",
          determinate: true,
          generationId: this.generationId(),
        });
        if (!this.storage.replace)
          throw new StructuredError(
            "internal",
            "Same-directory index replacement is unavailable.",
            true
          );
        // Cancellation is checked at the commit boundary. Once this call
        // starts, replacement is non-cancellable and commit wins the race.
        check(signal);
        await this.storage.replace("index.json.tmp", "index.json");
      } catch (error) {
        this.projection.update(
          this.projection.catalog,
          this.projection.revision,
          this.projection.complete,
          true
        );
        try {
          await this.storage.remove("index.json.tmp");
        } catch (cleanupError) {
          this.emit({
            area: "index",
            event: "index_operation",
            operation: operation === "rebuild" ? "build" : "incremental",
            stage: "cleanup-failed",
            phase: "encode-write",
            generation: this.generationId(),
            counts: { temporarySnapshots: 1 },
            error: projectDiagnosticError(cleanupError),
          });
        }
        throw error;
      }
    });
    this.durableRevision = this.projection.revision;
    this.projection.update(this.projection.catalog, this.projection.revision, true, false);
    this.reportProgress({
      operation: operation === "rebuild" ? "full" : "incremental",
      phase: "encode-write",
      completed: 2,
      total: 2,
      unit: "artifacts",
      determinate: true,
      generationId: this.generationId(),
    });
  }

  private makeCatalog(notes: readonly OramaCatalogNote[], fingerprint: string): OramaCatalog {
    const sorted = [...notes]
      .map((note) => ({ ...note, documentIds: [...note.documentIds] }))
      .sort((a, b) => compareCodeUnits(a.path, b.path));
    return {
      schema: 1,
      fingerprint,
      dimensions: this.embedding.dimensions,
      noteCount: sorted.length,
      chunkCount: sorted.reduce((sum, note) => sum + note.chunkCount, 0),
      notes: sorted,
    };
  }

  private replaceCatalog(catalog: OramaCatalog): void {
    this.notes.clear();
    for (const note of catalog.notes)
      this.notes.set(note.path, { ...note, documentIds: [...note.documentIds] });
  }

  private refreshCatalog(complete: boolean, dirty: boolean): OramaCatalog {
    const catalog = this.makeCatalog(
      [...this.notes.values()],
      this.projection.ready ? this.projection.fingerprint : "0".repeat(64)
    );
    if (this.projection.ready)
      this.projection.update(catalog, this.projection.revision, complete, dirty);
    return catalog;
  }

  private markDirty(): void {
    if (!this.projection.ready) throw new Error("Orama projection is unavailable");
    this.snapshotRevision = Math.max(this.snapshotRevision, this.projection.revision) + 1;
    this.projection.update(this.projection.catalog, this.snapshotRevision, false, true);
  }

  private clearCapturedQueue(captured: Map<string, Queued>): void {
    for (const [key, value] of captured)
      if (this.queued.get(key)?.revision === value.revision) this.queued.delete(key);
  }

  private clearQueueThrough(boundary: number): void {
    for (const [key, value] of this.queued) if (value.revision <= boundary) this.queued.delete(key);
  }

  acquireLenteLease(): LenteBundleLease | null {
    if (!this.projection.ready || this.unavailable) return null;
    const getGenerationId = () => this.generationId();
    return {
      get generationId() {
        return getGenerationId();
      },
      retriever: this.retriever,
      search: (query, mode, signal) =>
        this.retriever.search({
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
      release: async () => undefined,
    } as LenteBundleLease;
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

  queueChange(path: string): void {
    this.queueOperation({ kind: "modify", path });
  }

  queueOperation(operation: RevisionOperation): void {
    const key =
      operation.kind === "rename" ? `${operation.oldPath}\0${operation.path}` : operation.path;
    this.queued.set(key, { operation, revision: ++this.queueRevision });
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
    while (this.building) {
      const active = this.buildPromise;
      if (!active)
        throw new StructuredError("busy", "Index reconciliation is already running.", true);
      await active;
    }
    if (!this.queued.size) return false;
    if (!this.projection.ready || this.unavailable) {
      await this.build(signal);
      return true;
    }
    const captured = new Map(this.queued);
    const run = this.runUpdate(signal, captured);
    const wait = run.then(
      () => undefined,
      () => undefined
    );
    this.buildPromise = wait;
    try {
      return await run;
    } finally {
      if (this.buildPromise === wait) this.buildPromise = undefined;
    }
  }

  async search(
    query: string,
    signal: AbortSignal,
    limit: number
  ): Promise<readonly ProvenanceRecord[]> {
    if (!this.projection.ready || this.unavailable)
      throw new StructuredError("unavailable", "Semantic index is unavailable.", true);
    const results = await this.retriever.search({
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
    if (!this.projection.ready || this.unavailable) return null;
    const currentPath = normalizePath(path);
    const note = this.projection.catalog.notes.find((candidate) => candidate.path === currentPath);
    if (!note) return null;
    const projection = this.projection;
    return {
      get generationId() {
        return projection.generationId;
      },
      currentPath,
      contentHash: note.contentId,
      prepareQuery: async (signal) => {
        check(signal);
        const documents = projection.documentsForPath(currentPath);
        if (!documents.length) return null;
        const vectorSum = new Float64Array(projection.dimensions);
        let text = "";
        for (const document of documents) {
          check(signal);
          for (let dimension = 0; dimension < document.embedding.length; dimension++)
            vectorSum[dimension] += document.embedding[dimension];
          const separator = text ? "\n\n" : "";
          const remaining = CHUNK_SIZE - text.length - separator.length;
          if (remaining > 0) text += `${separator}${document.body.slice(0, remaining)}`;
        }
        let normSquared = 0;
        for (const value of vectorSum) normSquared += value * value;
        const norm = Math.sqrt(normSquared);
        return {
          text,
          vector:
            norm > 1e-12
              ? Array.from(vectorSum, (value) => value / norm)
              : [...documents[0].embedding],
        };
      },
      search: async (query, vector, signal, limit) =>
        (
          await this.retriever.search({
            query,
            queryVector: vector,
            mode: "related",
            resultShape: "chunks",
            currentPath,
            limit: Math.max(0, Math.min(1000, Math.floor(limit))),
            semanticCandidateLimit: Math.max(0, Math.min(1000, Math.floor(limit))),
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
    this.epoch++;
    this.unavailable = true;
    this.projection.detach();
  }

  markUnavailable(): void {
    this.unavailable = true;
    this.projection.detach();
  }

  private generationId(): string {
    return String(this.projection.revision || this.snapshotRevision || 0);
  }

  private isIndexEligible(path: string): boolean {
    try {
      const normalized = normalizePath(path);
      const excluded = this.fingerprint().excludedPaths.some(
        (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
      );
      return (
        !excluded &&
        (this.options.isIndexEligible?.(normalized) ??
          this.vault.isIndexEligible?.(normalized) ??
          true)
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
        // Preserve the original read failure when availability cannot be checked.
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
      // Progress listeners are observational.
    }
  }
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

function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
