import type {
  IndexRevision,
  RetrievalChunk,
  RetrievalNote,
  RetrievalRepository,
  RetrievalRow,
} from "@/index/contracts";
import type { LexicalHit, LexicalIndex, LexicalSearchOptions } from "@/index/lexical/LexicalIndex";
import type { VectorIndex, VectorSearchHit, VectorSearchOptions } from "@/index/vector/VectorIndex";
import { TalaDbEngine } from "./TalaDbEngine";

function visible(
  path: string,
  paths: VectorSearchOptions["visiblePaths"] | LexicalSearchOptions["visiblePaths"]
): boolean {
  return paths === undefined
    ? true
    : Array.isArray(paths)
      ? paths.includes(path)
      : (paths as ReadonlySet<string>).has(path);
}

/** Exact vector adapter over the current mutable row set. */
export class TalaVectorIndex implements VectorIndex {
  readonly generationId: string;
  readonly dimensions: number;
  get revision(): IndexRevision {
    return this.engine.state().revision;
  }
  get fingerprint(): string {
    return this.engine.state().fingerprint;
  }
  constructor(
    private readonly engine: TalaDbEngine,
    generationId = "taladb-v1"
  ) {
    this.generationId = generationId;
    this.dimensions = engine.state().dimensions;
  }
  async search(
    vector: readonly number[],
    optionsOrSignal: VectorSearchOptions | AbortSignal = {},
    positionalLimit?: number
  ): Promise<readonly VectorSearchHit[]> {
    const options =
      "aborted" in optionsOrSignal
        ? { signal: optionsOrSignal, limit: positionalLimit }
        : optionsOrSignal;
    if (options.signal?.aborted) throw new Error("Tala vector search cancelled");
    const hits = await this.engine.search(
      vector,
      options.limit ?? 20,
      options.excludePath ?? options.currentPath
    );
    return hits
      .filter(
        (hit) =>
          visible(hit.path, options.visiblePaths) &&
          (!options.isVisible || options.isVisible(hit.path))
      )
      .map((hit) => ({ ...hit, id: hit.rowId }));
  }
  async close(): Promise<void> {
    return;
  }
}

/** BM25-like lexical adapter with independent body, filename, and path channels. */
export class TalaLexicalIndex implements LexicalIndex {
  readonly generationId: string;
  readonly profile = "default" as const;
  get revision(): IndexRevision {
    return this.engine.state().revision;
  }
  get fingerprint(): string {
    return this.engine.state().fingerprint;
  }
  constructor(
    private readonly engine: TalaDbEngine,
    generationId = "taladb-v1"
  ) {
    this.generationId = generationId;
  }
  async search(query: string, options: LexicalSearchOptions = {}): Promise<readonly LexicalHit[]> {
    if (options.signal?.aborted) throw new Error("Tala lexical search cancelled");
    const hits = await this.engine.lexicalSearch(query, options.limit ?? 20, options.excludePath);
    return hits
      .filter((hit) => visible(hit.path, options.visiblePaths))
      .map((hit) => ({ ...hit, id: hit.rowId }));
  }
  async close(): Promise<void> {
    return;
  }
}

/** Retrieval-only adapter; hydration returns undefined when a row was concurrently deleted. */
export class TalaRetrievalRepository implements RetrievalRepository {
  readonly generationId = "taladb-v1";
  get revision(): IndexRevision {
    return this.engine.state().revision;
  }
  get fingerprint(): string {
    return this.engine.state().fingerprint;
  }
  get notes(): readonly RetrievalNote[] {
    return this.engine.noteCatalog().map((note) => ({
      path: note.path,
      contentId: note.contentId ?? "",
      chunkCount: note.chunkCount,
    }));
  }
  constructor(private readonly engine: TalaDbEngine) {}
  pin(): TalaRetrievalRepository {
    return this;
  }
  async release(): Promise<void> {
    return;
  }
  getNote(path: string): RetrievalNote | undefined {
    return this.notes.find((note) => note.path === path);
  }
  async hydrateRow(row: RetrievalRow): Promise<RetrievalChunk | undefined> {
    const id = row.rowId ?? row.id ?? row.canonicalId;
    if (!id) return undefined;
    const [chunk] = await this.engine.hydrate([id]);
    return chunk
      ? {
          rowId: chunk.rowId,
          canonicalId: chunk.canonicalId,
          ordinal: chunk.ordinal,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text,
          vector: chunk.vector,
        }
      : undefined;
  }
  async hydrateChunk(row: RetrievalRow | string): Promise<RetrievalChunk | undefined> {
    return typeof row === "string"
      ? this.hydrateRow({ rowId: row, path: "", ordinal: 0 })
      : this.hydrateRow(row);
  }
}
