import { create, insertMultiple, search, type AnyOrama } from "@orama/orama";
import type { CorpusSnapshot } from "../corpus/CorpusStore";
import { compareCodeUnits } from "../corpus/CorpusManifest";
import type {
  LexicalBuildOptions,
  LexicalHit,
  LexicalIndex,
  LexicalSearchOptions,
} from "./LexicalIndex";

const BATCH_SIZE = 256;
const cancelled = () => new Error("Lexical operation cancelled");
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}
type LexicalDocument = { id: string; text: string; path: string; ordinal: number };
type LexicalDb = AnyOrama;

function paths(value: LexicalSearchOptions["visiblePaths"]): readonly string[] | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value : [...value];
}

/** A derived, in-memory BM25 index for one immutable corpus generation. */
export class OramaLexicalIndex implements LexicalIndex {
  private closed = false;
  private constructor(
    private readonly db: LexicalDb,
    private readonly snapshot: CorpusSnapshot,
    readonly generationId: string,
    readonly fingerprint: string
  ) {}

  static async build(
    source: CorpusSnapshot,
    options: LexicalBuildOptions = {}
  ): Promise<OramaLexicalIndex> {
    check(options.signal);
    const snapshot = source.pin();
    try {
      const db = await create({
        schema: { id: "string", text: "string", path: "string", ordinal: "number" },
      });
      const total = snapshot.notes.reduce((sum, note) => sum + note.chunkCount, 0);
      let completed = 0;
      let batch: LexicalDocument[] = [];
      const flush = async () => {
        if (!batch.length) return;
        check(options.signal);
        const docs = batch;
        batch = [];
        await insertMultiple(db, docs, BATCH_SIZE);
        completed += docs.length;
        options.onProgress?.({ phase: "build-lexical", completed, total, unit: "chunks" });
      };
      for (const note of snapshot.notes) {
        check(options.signal);
        let noteOffset = 0;
        for (const segment of await snapshot.hydrateNote(note.path)) {
          for (const record of segment.segment.records) {
            check(options.signal);
            const ordinal = noteOffset + record.ordinal;
            batch.push({
              id: `${note.path}:${ordinal}`,
              text: record.text,
              path: note.path,
              ordinal,
            });
            if (batch.length >= BATCH_SIZE) await flush();
          }
          noteOffset += segment.segment.records.length;
        }
      }
      await flush();
      return new OramaLexicalIndex(db, snapshot, snapshot.generationId, snapshot.fingerprint);
    } catch (error) {
      await snapshot.release();
      throw error;
    }
  }

  async search(query: string, options: LexicalSearchOptions = {}): Promise<readonly LexicalHit[]> {
    if (this.closed) throw new Error("Lexical index is closed");
    check(options.signal);
    const limit = Math.max(0, Math.min(1000, options.limit ?? 20));
    const candidateLimit = Math.max(0, Math.min(1000, options.candidateLimit ?? limit));
    if (!query.trim() || limit === 0) return [];
    const visible = paths(options.visiblePaths);
    const where: Record<string, unknown>[] = [];
    if (visible) where.push({ path: visible });
    if (options.excludePath) where.push({ not: { path: options.excludePath } });
    const params: Record<string, unknown> = {
      term: query,
      properties: ["text"],
      limit: candidateLimit,
    };
    if (where.length === 1) params.where = where[0];
    else if (where.length > 1) params.where = { and: where };
    const result = await search(this.db, params as never);
    check(options.signal);
    const hits: LexicalHit[] = result.hits
      .map((hit) => {
        const doc = hit.document as LexicalDocument;
        return { id: doc.id, path: doc.path, ordinal: doc.ordinal, score: hit.score };
      })
      .filter((hit) => (!visible || visible.includes(hit.path)) && hit.path !== options.excludePath)
      .sort(
        (a, b) =>
          b.score - a.score ||
          compareCodeUnits(a.path, b.path) ||
          a.ordinal - b.ordinal ||
          compareCodeUnits(a.id, b.id)
      );
    return hits.slice(0, limit);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.snapshot.release();
  }
}
