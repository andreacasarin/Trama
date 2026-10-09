import { MarkdownTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import type {
  NoteStoreEntry,
  NoteStoreHit,
  NoteStoreHybridResult,
  NoteStoreRelatedResult,
  NoteStoreRpc,
  NoteStoreMethod,
  SqliteConnection,
} from "./protocol";

type Row = Record<string, unknown>;
const rows = (db: SqliteConnection, sql: string, bind: readonly unknown[] = []): Row[] => {
  const result: Row[] = [];
  db.exec({ sql, bind, rowMode: "object", callback: (row) => result.push(row) });
  return result;
};

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
}

function validPath(path: unknown): asserts path is string {
  if (typeof path !== "string" || path.length === 0)
    throw new TypeError("A non-empty note path is required");
}

function vectorBytes(values: readonly number[], dimensions?: number): Uint8Array {
  if (!Array.isArray(values) || values.length === 0 || (dimensions && values.length !== dimensions))
    throw new TypeError("Vector dimensions are invalid");
  let norm = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new TypeError("Vector values must be finite");
    norm += value * value;
  }
  if (!Number.isFinite(norm) || norm === 0) throw new TypeError("Vector magnitude is invalid");
  const output = new Float32Array(values.length);
  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < values.length; index++) output[index] = values[index] * scale;
  return new Uint8Array(output.buffer);
}

function ftsTerms(query: string): string {
  return (query.match(/[\p{L}\p{N}_]+/gu) ?? [])
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" AND ");
}

export class NoteSqliteDatabase {
  constructor(private readonly db: SqliteConnection) {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(`CREATE TABLE IF NOT EXISTS note_index(
      note_id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      source_hash TEXT NOT NULL,
      embedding_profile TEXT,
      chunk_count INTEGER NOT NULL CHECK(chunk_count>=0),
      centroid BLOB
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS note_vectors(
      note_id INTEGER NOT NULL REFERENCES note_index(note_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK(ordinal>=0),
      vector BLOB NOT NULL,
      PRIMARY KEY(note_id,ordinal)
    ) WITHOUT ROWID`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
      body,path_text,content='',contentless_delete=1,
      tokenize='unicode61 remove_diacritics 2'
    )`);
  }

  async call<M extends NoteStoreMethod>(
    method: M,
    payload: NoteStoreRpc[M],
    signal?: AbortSignal
  ): Promise<unknown> {
    checkAbort(signal);
    switch (method) {
      case "noteStoreGet": {
        const { path } = payload as NoteStoreRpc["noteStoreGet"];
        validPath(path);
        const row = rows(
          this.db,
          `SELECT n.source_hash AS hash,n.embedding_profile AS profile,
          n.chunk_count AS chunkCount,COUNT(v.ordinal) AS vectorCount FROM note_index n
          LEFT JOIN note_vectors v USING(note_id) WHERE n.path=? GROUP BY n.note_id`,
          [path]
        )[0];
        return row
          ? ({
              hash: String(row.hash),
              profile: row.profile as string | null,
              chunkCount: Number(row.chunkCount),
              vectorCount: Number(row.vectorCount),
            } satisfies NoteStoreEntry)
          : null;
      }
      case "noteStoreReplace":
        return this.replace(payload as NoteStoreRpc["noteStoreReplace"], signal);
      case "noteStoreDelete": {
        const { paths } = payload as NoteStoreRpc["noteStoreDelete"];
        if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string"))
          throw new TypeError("Invalid note paths");
        this.db.exec("BEGIN IMMEDIATE");
        try {
          for (let index = 0; index < paths.length; index++) {
            const path = paths[index];
            checkAbort(signal);
            const row = rows(this.db, "SELECT note_id FROM note_index WHERE path=?", [path])[0];
            if (row) {
              const id = Number(row.note_id);
              this.db.exec({ sql: "DELETE FROM note_fts WHERE rowid=?", bind: [id] });
              this.db.exec({ sql: "DELETE FROM note_index WHERE note_id=?", bind: [id] });
            }
            if ((index + 1) % 16 === 0 && index + 1 < paths.length) {
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              checkAbort(signal);
            }
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          checkAbort(signal);
          this.db.exec("COMMIT");
          return undefined;
        } catch (error) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            /* preserve original error */
          }
          throw error;
        }
      }
      case "noteStoreListPaths": {
        const { afterPath, limit } = payload as NoteStoreRpc["noteStoreListPaths"];
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 512 ||
          (afterPath !== undefined && typeof afterPath !== "string")
        )
          throw new TypeError("Invalid indexed path page");
        const found = rows(
          this.db,
          `SELECT path FROM note_index
          WHERE ? IS NULL OR path COLLATE BINARY > ? COLLATE BINARY
          ORDER BY path COLLATE BINARY LIMIT ?`,
          [afterPath ?? null, afterPath ?? null, limit]
        );
        return found.map((row) => String(row.path));
      }
      case "noteStoreReset": {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          checkAbort(signal);
          this.db.exec("DELETE FROM note_fts");
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          checkAbort(signal);
          this.db.exec("DELETE FROM note_index");
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          checkAbort(signal);
          this.db.exec("COMMIT");
          return undefined;
        } catch (error) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            /* preserve original error */
          }
          throw error;
        }
      }
      case "noteStoreSemantic": {
        const { vector, profile, k } = payload as NoteStoreRpc["noteStoreSemantic"];
        return (await this.hybridSearch({ vector, profile, k }, signal)).hits;
      }
      case "noteStoreHybrid":
        return this.hybridSearch(payload as NoteStoreRpc["noteStoreHybrid"], signal);
      case "noteStoreRelated":
        return this.related(payload as NoteStoreRpc["noteStoreRelated"], signal);
    }
  }

  private async hybridSearch(
    input: NoteStoreRpc["noteStoreHybrid"],
    signal?: AbortSignal
  ): Promise<NoteStoreHybridResult> {
    const { query, vector, profile, k } = input;
    if (
      (query !== undefined && (typeof query !== "string" || query.length > 4096)) ||
      (vector === undefined && query === undefined) ||
      !Number.isSafeInteger(k) ||
      k < 0 ||
      k > 100 ||
      (profile !== undefined && typeof profile !== "string") ||
      (vector !== undefined && (!profile || !Array.isArray(vector)))
    )
      throw new TypeError("Invalid note search request");

    if (vector !== undefined) vectorBytes(vector);

    const semanticCount =
      vector && profile
        ? Number(
            rows(
              this.db,
              "SELECT COUNT(*) AS count FROM note_index WHERE embedding_profile=? AND centroid IS NOT NULL",
              [profile]
            )[0].count
          )
        : 0;
    checkAbort(signal);
    const semanticAvailable = semanticCount > 0;
    const stored = semanticAvailable
      ? rows(
          this.db,
          "SELECT length(centroid) AS bytes FROM note_index WHERE embedding_profile=? AND centroid IS NOT NULL LIMIT 1",
          [profile]
        )[0]
      : undefined;
    if (stored && Number(stored.bytes) !== vector!.length * 4)
      throw new TypeError("Query vector dimensions do not match the profile");
    const needle = semanticAvailable ? vectorBytes(vector!) : null;
    const expression = query === undefined ? "" : ftsTerms(query);
    const candidateLimit = Math.min(200, k * 4);
    const lexicalCte = expression
      ? `lexical_base AS (
          SELECT n.note_id,n.path,bm25(note_fts) AS lexicalScore
          FROM note_fts JOIN note_index n ON n.note_id=note_fts.rowid
          WHERE note_fts MATCH ?
          ORDER BY lexicalScore ASC,n.path COLLATE BINARY ASC LIMIT ?
        ), lexical AS (
          SELECT *,ROW_NUMBER() OVER(ORDER BY lexicalScore ASC,path COLLATE BINARY ASC) AS lexicalRank FROM lexical_base
        ),`
      : `lexical AS (SELECT NULL AS note_id,NULL AS path,NULL AS lexicalScore,NULL AS lexicalRank WHERE 0),`;
    const found = rows(
      this.db,
      `WITH ${lexicalCte}
      semantic_base AS (
        SELECT n.note_id,n.path,MAX(trama_vector_dot(v.vector,?)) AS semanticScore
        FROM note_index n JOIN note_vectors v USING(note_id)
        WHERE n.embedding_profile=? AND ?=1
        GROUP BY n.note_id
        ORDER BY semanticScore DESC,n.path COLLATE BINARY ASC LIMIT ?
      ), semantic AS (
        SELECT *,ROW_NUMBER() OVER(ORDER BY semanticScore DESC,path COLLATE BINARY ASC) AS semanticRank FROM semantic_base
      ), combined AS (
        SELECT l.note_id,l.path,l.lexicalScore,s.semanticScore,
          1.0/(60+l.lexicalRank)+COALESCE(1.0/(60+s.semanticRank),0) AS fusedScore
        FROM lexical l LEFT JOIN semantic s ON s.note_id=l.note_id
        UNION ALL
        SELECT s.note_id,s.path,NULL,s.semanticScore,1.0/(60+s.semanticRank)
        FROM semantic s LEFT JOIN lexical l ON l.note_id=s.note_id WHERE l.note_id IS NULL
      )
      SELECT path,fusedScore,lexicalScore,semanticScore FROM combined
      ORDER BY fusedScore DESC,path COLLATE BINARY ASC LIMIT ?`,
      [
        ...(expression ? [expression, candidateLimit] : []),
        needle,
        semanticAvailable ? profile : null,
        semanticAvailable ? 1 : 0,
        candidateLimit,
        k,
      ]
    );
    checkAbort(signal);
    const hits = found.map((row) => {
      const semanticScore = row.semanticScore === null ? undefined : Number(row.semanticScore);
      const lexicalScore = row.lexicalScore === null ? undefined : Number(row.lexicalScore);
      const score = query === undefined ? (semanticScore ?? 0) : Number(row.fusedScore);
      return {
        path: String(row.path),
        score,
        ...(lexicalScore === undefined ? {} : { lexicalScore }),
        ...(semanticScore === undefined ? {} : { semanticScore }),
      } satisfies NoteStoreHit;
    });
    const degraded = vector !== undefined && !semanticAvailable;
    return {
      hits,
      mode: semanticAvailable ? "hybrid" : "lexical",
      degraded,
      ...(degraded ? { degradationReason: "semantic-unavailable" as const } : {}),
    };
  }

  private related(
    input: NoteStoreRpc["noteStoreRelated"],
    signal?: AbortSignal
  ): NoteStoreRelatedResult {
    const { sourcePath, profile, k } = input;
    validPath(sourcePath);
    if (typeof profile !== "string" || !Number.isSafeInteger(k) || k < 0 || k > 20)
      throw new TypeError("Invalid related-note request");
    const sourceAvailable =
      Number(
        rows(
          this.db,
          "SELECT EXISTS(SELECT 1 FROM note_index WHERE path=? AND embedding_profile=? AND centroid IS NOT NULL) AS available",
          [sourcePath, profile]
        )[0].available
      ) === 1;
    if (!sourceAvailable) return { hits: [], available: false };
    checkAbort(signal);
    const hits = rows(
      this.db,
      `SELECT other.path,trama_vector_dot(other.centroid,source.centroid) AS score
      FROM note_index source JOIN note_index other
        ON other.embedding_profile=source.embedding_profile
      WHERE source.path=? AND source.embedding_profile=? AND source.centroid IS NOT NULL
        AND other.centroid IS NOT NULL AND other.note_id<>source.note_id
      ORDER BY score DESC,other.path COLLATE BINARY ASC LIMIT ?`,
      [sourcePath, profile, k]
    ).map((row) => ({ path: String(row.path), score: Number(row.score) }));
    checkAbort(signal);
    return { hits, available: true };
  }

  private async replace(
    input: NoteStoreRpc["noteStoreReplace"],
    signal?: AbortSignal
  ): Promise<{ path: string }> {
    const { path, hash, profile, markdown, vectors } = input;
    validPath(path);
    if (
      !/^[0-9a-f]{64}$/i.test(hash) ||
      (profile !== null && typeof profile !== "string") ||
      typeof markdown !== "string" ||
      !Array.isArray(vectors)
    )
      throw new TypeError("Invalid note replacement");
    const splitter = new MarkdownTextSplitter();
    const chunks = await splitter.splitDocuments([
      new Document({ pageContent: markdown, metadata: { path } }),
    ]);
    if (
      (profile === null && vectors.length !== 0) ||
      (profile !== null && chunks.length !== vectors.length)
    )
      throw new TypeError("Chunk and vector counts differ");
    const dimensions = vectors[0]?.length;
    const normalized = vectors.map((vector) => vectorBytes(vector, dimensions));
    checkAbort(signal);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      checkAbort(signal);
      const existing = rows(this.db, "SELECT note_id FROM note_index WHERE path=?", [path])[0];
      let id: number;
      if (existing) {
        id = Number(existing.note_id);
        this.db.exec({ sql: "DELETE FROM note_fts WHERE rowid=?", bind: [id] });
        this.db.exec({
          sql: "UPDATE note_index SET source_hash=?,embedding_profile=?,chunk_count=?,centroid=NULL WHERE note_id=?",
          bind: [hash, profile, chunks.length, id],
        });
      } else {
        this.db.exec({
          sql: "INSERT INTO note_index(path,source_hash,embedding_profile,chunk_count) VALUES(?,?,?,?)",
          bind: [path, hash, profile, chunks.length],
        });
        id = Number(rows(this.db, "SELECT last_insert_rowid() AS id")[0].id);
      }
      this.db.exec({ sql: "DELETE FROM note_vectors WHERE note_id=?", bind: [id] });
      for (let i = 0; i < normalized.length; i++) {
        checkAbort(signal);
        this.db.exec({
          sql: "INSERT INTO note_vectors(note_id,ordinal,vector) VALUES(?,?,?)",
          bind: [id, i, normalized[i]],
        });
        if ((i + 1) % 16 === 0 && i + 1 < normalized.length) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          checkAbort(signal);
        }
      }
      if (profile !== null) {
        this.db.exec({
          sql: `UPDATE note_index SET centroid=(
            SELECT trama_vector_centroid(vector) FROM note_vectors WHERE note_id=?
          ) WHERE note_id=?`,
          bind: [id, id],
        });
      }
      this.db.exec({
        sql: "INSERT INTO note_fts(rowid,body,path_text) VALUES(?,?,?)",
        bind: [id, markdown, path],
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      checkAbort(signal);
      this.db.exec("COMMIT");
      return { path };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    }
  }
}
