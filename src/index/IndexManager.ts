import { EmbeddingModel, ProvenanceRecord, StructuredError } from "@/domain/contracts";
import { VaultSearchPort } from "@/tools/ToolRegistry";
import {
  CHUNK_ALGORITHM_VERSION,
  CHUNK_OVERLAP,
  CHUNK_SIZE,
  EXTRACTION_VERSION,
  INDEX_SCHEMA_VERSION,
  chunkMarkdown,
} from "@/index/chunking";
import { IndexStorage } from "@/index/storage";
import { create, insertMultiple, load, save, search } from "@orama/orama";

export interface IndexVaultDocument {
  readonly path: string;
  readonly content: string;
  readonly revision?: string;
}
export interface IndexVaultPort {
  listMarkdownPaths(signal: AbortSignal): Promise<readonly string[]>;
  readMarkdown(path: string, signal: AbortSignal): Promise<IndexVaultDocument>;
}
export interface IndexFingerprint {
  readonly embeddingBaseUrl: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly chunking: {
    readonly algorithmVersion: number;
    readonly size: number;
    readonly overlap: number;
  };
  readonly extractionVersion: number;
  readonly schemaVersion: number;
}
interface RecordItem {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  vector: number[];
  contentHash: string;
}
interface Generation {
  fingerprint: IndexFingerprint;
  orama: ReturnType<typeof save>;
  records: RecordItem[];
}

function hash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}
function canonical(value: unknown): string {
  return JSON.stringify(value);
}

/** Creates the stable configuration identity used to decide whether an index can be reused. */
export function createIndexFingerprint(
  embeddingBaseUrl: string,
  modelId: string,
  dimensions: number,
  options: { readonly size?: number; readonly overlap?: number } = {}
): IndexFingerprint {
  return {
    embeddingBaseUrl: embeddingBaseUrl.trim().replace(/\/$/, "").toLowerCase(),
    modelId,
    dimensions,
    chunking: {
      algorithmVersion: CHUNK_ALGORITHM_VERSION,
      size: options.size ?? CHUNK_SIZE,
      overlap: options.overlap ?? CHUNK_OVERLAP,
    },
    extractionVersion: EXTRACTION_VERSION,
    schemaVersion: INDEX_SCHEMA_VERSION,
  };
}

/** Builds and searches the vault's generation-swapped semantic index. */
export class IndexManager implements VaultSearchPort {
  private active: Generation | null = null;
  private building = false;
  private generation = 0;
  private buildEpoch = 0;
  private loaded = false;
  private loadPromise?: Promise<boolean>;
  private readonly queued = new Map<string, number>();
  private queueRevision = 0;
  private deferredSignal?: AbortSignal;
  private unavailable = false;
  private buildPromise?: Promise<void>;
  constructor(
    private readonly vault: IndexVaultPort,
    private readonly embedding: EmbeddingModel,
    private readonly storage: IndexStorage,
    private readonly embeddingBaseUrl: string,
    private readonly modelId: string,
    private readonly options: { readonly size?: number; readonly overlap?: number } = {},
    private readonly onError?: (error: unknown) => void
  ) {}
  fingerprint(): IndexFingerprint {
    return createIndexFingerprint(
      this.embeddingBaseUrl,
      this.modelId,
      this.embedding.dimensions,
      this.options
    );
  }
  /** Drops the active generation when its embedding configuration is no longer valid. */
  invalidate(): void {
    this.active = null;
    this.unavailable = true;
    this.buildEpoch++;
  }
  /** Marks the published generation unusable while retaining queued changes for retry. */
  markUnavailable(): void {
    this.active = null;
    this.unavailable = true;
  }
  async load(): Promise<boolean> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadPersisted();
    return this.loadPromise;
  }
  private async loadPersisted(): Promise<boolean> {
    try {
      const primary = await this.loadPersistedCandidate("active.json");
      if (primary) {
        this.active = primary.generation;
        this.unavailable = false;
        this.generation = primary.number;
        return true;
      }
      let primaryGeneration: number | undefined;
      try {
        const pointer = await this.storage.read("active.json");
        const parsed = JSON.parse(pointer ?? "") as { generation?: unknown };
        if (typeof parsed.generation === "number" && Number.isInteger(parsed.generation))
          primaryGeneration = parsed.generation;
      } catch {
        // A malformed primary pointer has no generation to seed.
      }
      // A crash can leave the previous pointer in .bak after active.json has
      // been moved but before the replacement pointer is published. Validate
      // the backup exactly like the primary before making it searchable.
      const backup = await this.loadPersistedCandidate("active.json.bak");
      if (backup) {
        this.active = backup.generation;
        this.unavailable = false;
        this.generation = backup.number;
        return true;
      }
      this.active = null;
      if (primaryGeneration !== undefined) this.generation = primaryGeneration;
      return false;
    } finally {
      this.loaded = true;
    }
  }
  private async loadPersistedCandidate(
    pointerPath: string
  ): Promise<{ generation: Generation; number: number } | null> {
    try {
      const pointer = await this.storage.read(pointerPath);
      if (!pointer) return null;
      const parsed = JSON.parse(pointer) as { generation: number; fingerprint: IndexFingerprint };
      if (
        !Number.isInteger(parsed.generation) ||
        parsed.generation < 0 ||
        canonical(parsed.fingerprint) !== canonical(this.fingerprint())
      )
        return null;
      const raw = await this.storage.read(`generations/${parsed.generation}.json`);
      if (!raw) return null;
      const candidate = JSON.parse(raw) as Generation;
      await this.validateGeneration(candidate);
      return { generation: candidate, number: parsed.generation };
    } catch {
      return null;
    }
  }
  async build(signal: AbortSignal): Promise<void> {
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
    if (this.building) throw new StructuredError("busy", "Index rebuild is already running.", true);
    if (signal.aborted) throw new StructuredError("cancelled", "Index rebuild cancelled.", true);
    this.building = true;
    let published = false;
    const buildEpoch = this.buildEpoch;
    try {
      // The persisted pointer must be read before choosing a generation number.
      // Otherwise startup rebuilds can overwrite the generation the pointer names.
      if (!this.loaded) await this.load();
      const buildGeneration = this.generation + 1;
      const queuedAtStart = new Map(this.queued);
      await this.storage.prepare?.();
      const paths = [...(await this.vault.listMarkdownPaths(signal))].sort();
      const docs = await Promise.all(paths.map((path) => this.vault.readMarkdown(path, signal)));
      const chunks = docs.flatMap((doc) =>
        chunkMarkdown(
          doc.content,
          this.options.size ?? CHUNK_SIZE,
          this.options.overlap ?? CHUNK_OVERLAP,
          signal
        ).map((chunk) => ({ ...chunk, path: doc.path, contentHash: hash(doc.content) }))
      );
      const vectors = await this.embedding.embed(
        chunks.map((chunk) => chunk.text),
        signal
      );
      if (
        vectors.length !== chunks.length ||
        vectors.some((v) => v.length !== this.embedding.dimensions)
      )
        throw new StructuredError(
          "internal",
          "Embedding dimensions changed during indexing.",
          false
        );
      const db = await create({
        schema: {
          text: "string",
          path: "string",
          startLine: "number",
          endLine: "number",
          contentHash: "string",
          embedding: `vector[${this.embedding.dimensions}]`,
        },
      });
      await insertMultiple(
        db,
        chunks.map((chunk, i) => ({ ...chunk, embedding: [...vectors[i]] }))
      );
      const generation: Generation = {
        fingerprint: this.fingerprint(),
        records: chunks.map((chunk, i) => ({ ...chunk, vector: [...vectors[i]] })),
        orama: save(db),
      };
      await this.storage.write(`generations/${buildGeneration}.json`, JSON.stringify(generation));
      const persisted = await this.storage.read(`generations/${buildGeneration}.json`);
      if (!persisted) throw new StructuredError("internal", "Staged index disappeared.", true);
      const staged = JSON.parse(persisted) as Generation;
      await this.validateGeneration(staged);
      if (
        signal.aborted ||
        buildEpoch !== this.buildEpoch ||
        this.generation !== buildGeneration - 1
      )
        throw new StructuredError("cancelled", "Index rebuild cancelled.", true);
      await this.storage.activate(
        "active.json",
        JSON.stringify({ generation: buildGeneration, fingerprint: generation.fingerprint }),
        signal
      );
      // Publication is the commit point. Cancellation after it cannot turn a
      // successful persisted activation into a reported failure.
      this.active = generation;
      this.generation = buildGeneration;
      this.unavailable = false;
      published = true;
      for (const [path, revision] of queuedAtStart)
        if (this.queued.get(path) === revision) this.queued.delete(path);
    } finally {
      this.building = false;
      if (!published && (signal.aborted || buildEpoch !== this.buildEpoch)) {
        this.active = null;
        this.unavailable = true;
      }
      const deferred = this.deferredSignal;
      this.deferredSignal = undefined;
      if (published && deferred && this.queued.size > 0 && !deferred.aborted)
        void this.reconcileQueuedChanges(deferred).catch((error) => {
          this.markUnavailable();
          this.onError?.(error);
        });
    }
  }
  /** Queues a vault path observed while a rebuild is in progress. */
  queueChange(path: string): void {
    this.queued.set(path, ++this.queueRevision);
  }
  /** Rebuilds queued paths after a generation is active, preserving atomic activation. */
  async reconcileQueuedChanges(signal: AbortSignal): Promise<void> {
    if (this.queued.size === 0) return;
    if (this.building) {
      this.deferredSignal = signal;
      return;
    }
    await this.build(signal);
  }
  /** Applies a changed note by rebuilding a consistent generation. */
  async upsert(path: string, signal: AbortSignal): Promise<void> {
    this.queueChange(path);
    await this.reconcileQueuedChanges(signal);
  }
  /** Applies a deletion by rebuilding a consistent generation without the removed note. */
  async delete(path: string, signal: AbortSignal): Promise<void> {
    this.queueChange(path);
    await this.reconcileQueuedChanges(signal);
  }
  async search(
    query: string,
    signal: AbortSignal,
    limit: number
  ): Promise<readonly ProvenanceRecord[]> {
    if (signal.aborted) throw new StructuredError("cancelled", "Search cancelled.", true);
    if (!this.active || this.unavailable)
      throw new StructuredError("unavailable", "The vault index is not ready.", true);
    const cap = Math.max(0, Math.min(100, Math.floor(limit)));
    const [vector] = await this.embedding.embed([query], signal);
    const db = await create({
      schema: {
        text: "string",
        path: "string",
        startLine: "number",
        endLine: "number",
        contentHash: "string",
        embedding: `vector[${this.embedding.dimensions}]`,
      },
    });
    load(db, this.active.orama);
    const result = await search(db, {
      mode: "vector",
      vector: { value: [...vector], property: "embedding" },
      similarity: 0,
      limit: cap,
    });
    return result.hits.map((hit) => {
      const doc = hit.document as unknown as RecordItem;
      return {
        path: doc.path,
        startLine: doc.startLine,
        endLine: doc.endLine,
        excerpt: doc.text.slice(0, 500),
        score: hit.score,
      };
    });
  }
  private async validateGeneration(generation: Generation): Promise<void> {
    if (
      canonical(generation.fingerprint) !== canonical(this.fingerprint()) ||
      !Array.isArray(generation.records)
    )
      throw new Error("Invalid index generation");
    const db = await create({
      schema: {
        text: "string",
        path: "string",
        startLine: "number",
        endLine: "number",
        contentHash: "string",
        embedding: `vector[${this.embedding.dimensions}]`,
      },
    });
    load(db, generation.orama);
    if (generation.records.length > 0 && !generation.records[0].path)
      throw new Error("Invalid index records");
  }
}
