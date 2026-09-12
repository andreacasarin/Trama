import type {
  IndexRevision,
  RetrievalChunk,
  RetrievalNote,
  RetrievalRepository,
  RetrievalRow,
} from "@/index/contracts";
import type { LexicalHit, LexicalSearchOptions } from "@/index/lexical/LexicalIndex";
import type { VectorIndex, VectorSearchHit, VectorSearchOptions } from "@/index/vector/VectorIndex";
import { TalaDbEngine } from "./TalaDbEngine";

/** Adapts the mutable engine to Trama's neutral retrieval contracts. */
export class TalaDbRepository implements RetrievalRepository, VectorIndex {
  readonly generationId: string;
  readonly dimensions: number;
  readonly profile = "default" as const;
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
  constructor(
    private readonly engine: TalaDbEngine,
    generationId = "taladb-v1",
    private readonly closeEngine = true
  ) {
    this.generationId = generationId;
    this.dimensions = engine.state().dimensions;
  }

  pin(): TalaDbRepository {
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
  async hydrateChunk(
    row: RetrievalRow | string,
    ordinal?: number
  ): Promise<RetrievalChunk | undefined> {
    if (typeof row === "string") {
      const [chunk] = await this.engine.hydrate([row]);
      return chunk ? { ...chunk } : undefined;
    }
    return this.hydrateRow(row);
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
    const visible = options.visiblePaths;
    const filtered = visible
      ? hits.filter((hit) =>
          Array.isArray(visible)
            ? visible.includes(hit.path)
            : (visible as ReadonlySet<string>).has(hit.path)
        )
      : hits;
    return filtered.map((hit) => ({ ...hit, id: hit.rowId }));
  }
  async searchText(
    query: string,
    options: LexicalSearchOptions = {}
  ): Promise<readonly LexicalHit[]> {
    if (options.signal?.aborted) throw new Error("Tala lexical search cancelled");
    const hits = await this.engine.lexicalSearch(query, options.limit ?? 20, options.excludePath);
    const visible = options.visiblePaths;
    const filtered = visible
      ? hits.filter((hit) =>
          Array.isArray(visible)
            ? visible.includes(hit.path)
            : (visible as ReadonlySet<string>).has(hit.path)
        )
      : hits;
    return filtered.map((hit) => ({ ...hit, id: hit.rowId }));
  }
  async close(): Promise<void> {
    if (this.closeEngine) await this.engine.close();
  }
}

export function createTalaRepository(engine: TalaDbEngine): TalaDbRepository {
  return new TalaDbRepository(engine);
}
