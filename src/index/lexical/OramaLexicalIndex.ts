import { create, insertMultiple, search, type AnyOrama } from "@orama/orama";
import type { CorpusSnapshot } from "../corpus/CorpusStore";
import { compareCodeUnits } from "../corpus/CorpusManifest";
import type {
  LexicalBuildOptions,
  LexicalHit,
  LexicalIndex,
  LexicalSearchOptions,
  LexicalProfile,
} from "./LexicalIndex";

const BATCH_SIZE = 32;
const cancelled = () => new Error("Lexical operation cancelled");
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}
function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
type LexicalDocument = {
  id: string;
  text: string;
  path: string;
  ordinal: number;
  filename?: string;
  pathText?: string;
  body?: string;
};
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
    readonly fingerprint: string,
    readonly profile: LexicalProfile,
    private readonly documentCount: number
  ) {}

  static async build(
    source: CorpusSnapshot,
    options: LexicalBuildOptions = {}
  ): Promise<OramaLexicalIndex> {
    check(options.signal);
    const snapshot = source.pin();
    const profile = options.profile ?? "default";
    try {
      const db = await create({
        schema:
          profile === "lente"
            ? {
                id: "string",
                text: "string",
                path: "string",
                ordinal: "number",
                filename: "string",
                pathText: "string",
                body: "string",
              }
            : { id: "string", text: "string", path: "string", ordinal: "number" },
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
        // Orama's resolved promises remain in the microtask queue. Yield to a
        // macrotask between batches so a large vault cannot monopolize the
        // Obsidian renderer while rebuilding this derived index.
        await yieldMacrotask();
        check(options.signal);
      };
      for (const note of snapshot.notes) {
        check(options.signal);
        let noteOffset = 0;
        for (const segment of await snapshot.hydrateNote(note.path)) {
          for (const record of segment.segment.records) {
            check(options.signal);
            const ordinal = noteOffset + record.ordinal;
            const document: LexicalDocument = {
              id: `${note.path}:${ordinal}`,
              text: record.text,
              path: note.path,
              ordinal,
              filename: note.path.slice(note.path.lastIndexOf("/") + 1),
              pathText: note.path,
              body: record.text,
            };
            batch.push(
              profile === "lente"
                ? document
                : { id: document.id, text: document.text, path: document.path, ordinal }
            );
            if (batch.length >= BATCH_SIZE) await flush();
          }
          noteOffset += segment.segment.records.length;
        }
      }
      await flush();
      return new OramaLexicalIndex(
        db,
        snapshot,
        snapshot.generationId,
        snapshot.fingerprint,
        profile,
        total
      );
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
    const profile: LexicalProfile = options.profile ?? "default";
    const params: Record<string, unknown> = {
      term: query,
      properties: profile === "lente" ? ["filename", "pathText", "body"] : ["text"],
      limit: candidateLimit,
    };
    if (profile === "lente") params.boost = { filename: 3, pathText: 2, body: 1 };
    if (where.length === 1) params.where = where[0];
    else if (where.length > 1) params.where = { and: where };
    let result;
    if (profile === "lente" && candidateLimit > 0) {
      let searchLimit = Math.min(this.documentCount, Math.max(32, candidateLimit));
      result = await search(this.db, { ...params, limit: searchLimit } as never);
      while (distinctPathCount(result.hits) < Math.min(candidateLimit, this.documentCount)) {
        check(options.signal);
        if (searchLimit >= this.documentCount) break;
        searchLimit = Math.min(this.documentCount, searchLimit * 2);
        result = await search(this.db, { ...params, limit: searchLimit } as never);
        check(options.signal);
      }
    } else {
      result = await search(this.db, params as never);
    }
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
    if (profile !== "lente") return hits.slice(0, limit);
    const distinct: LexicalHit[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      if (seen.has(hit.path)) continue;
      seen.add(hit.path);
      distinct.push(hit);
      if (distinct.length >= limit) break;
    }
    return distinct;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.snapshot.release();
  }
}

function distinctPathCount(hits: readonly { document: unknown }[]): number {
  const paths = new Set<string>();
  for (const hit of hits) {
    const path = (hit.document as { path?: unknown }).path;
    if (typeof path === "string") paths.add(path);
  }
  return paths.size;
}
