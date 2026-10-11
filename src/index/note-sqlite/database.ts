import type {
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

function validKeys(keys: unknown): asserts keys is readonly string[] {
  if (!Array.isArray(keys) || keys.length > 1000 || keys.some((key) => typeof key !== "string"))
    throw new TypeError("Invalid record keys");
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
      current_uid TEXT NOT NULL UNIQUE,
      embedding_profile TEXT,
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
    db.exec(`CREATE TABLE IF NOT EXISTS note_records(
      uid TEXT PRIMARY KEY,
      group_path TEXT,
      updated_at INTEGER NOT NULL
    ) WITHOUT ROWID`);
    db.exec(`CREATE TABLE IF NOT EXISTS note_record_clock(
      id INTEGER PRIMARY KEY CHECK(id=1),
      value INTEGER NOT NULL
    )`);
    db.exec("INSERT INTO note_record_clock(id,value) VALUES(1,0) ON CONFLICT(id) DO NOTHING");
  }

  async call<M extends NoteStoreMethod>(
    method: M,
    payload: NoteStoreRpc[M],
    signal?: AbortSignal
  ): Promise<unknown> {
    checkAbort(signal);
    switch (method) {
      case "noteStoreReplace":
        return this.replace(payload as NoteStoreRpc["noteStoreReplace"], signal);
      case "noteStoreDelete": {
        const { uids } = payload as NoteStoreRpc["noteStoreDelete"];
        validKeys(uids);
        this.db.exec("BEGIN IMMEDIATE");
        try {
          for (let index = 0; index < uids.length; index++) {
            const uid = uids[index];
            checkAbort(signal);
            const row = rows(this.db, "SELECT note_id FROM note_index WHERE current_uid=?", [
              uid,
            ])[0];
            if (row) {
              const id = Number(row.note_id);
              this.db.exec({ sql: "DELETE FROM note_fts WHERE rowid=?", bind: [id] });
              this.db.exec({
                sql: "DELETE FROM note_index WHERE note_id=? AND current_uid=?",
                bind: [id, uid],
              });
            }
            if ((index + 1) % 16 === 0 && index + 1 < uids.length) {
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
      case "noteStoreReset": {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          checkAbort(signal);
          this.db.exec("DELETE FROM note_fts");
          this.db.exec("DELETE FROM note_records");
          this.db.exec("UPDATE note_record_clock SET value=0 WHERE id=1");
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
      case "recordManagerGetTime":
        return this.reserveRecordTime();
      case "recordManagerUpdate":
        return this.updateRecords(payload as NoteStoreRpc["recordManagerUpdate"]);
      case "recordManagerExists":
        return this.recordExists(payload as NoteStoreRpc["recordManagerExists"]);
      case "recordManagerListKeys":
        return this.listRecordKeys(payload as NoteStoreRpc["recordManagerListKeys"]);
      case "recordManagerDeleteKeys":
        return this.deleteRecords(payload as NoteStoreRpc["recordManagerDeleteKeys"]);
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
    const { uid, path, profile, markdown, vectors } = input;
    validPath(path);
    if (
      typeof uid !== "string" ||
      !uid ||
      (profile !== null && typeof profile !== "string") ||
      typeof markdown !== "string" ||
      !Array.isArray(vectors)
    )
      throw new TypeError("Invalid note replacement");
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
          sql: "UPDATE note_index SET current_uid=?,embedding_profile=?,centroid=NULL WHERE note_id=?",
          bind: [uid, profile, id],
        });
      } else {
        this.db.exec({
          sql: "INSERT INTO note_index(path,current_uid,embedding_profile) VALUES(?,?,?)",
          bind: [path, uid, profile],
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
      const updatedAt = this.tickRecordClock();
      this.db.exec({
        sql: `INSERT INTO note_records(uid,group_path,updated_at) VALUES(?,?,?)
          ON CONFLICT(uid) DO UPDATE SET group_path=excluded.group_path,updated_at=excluded.updated_at`,
        bind: [uid, path, updatedAt],
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

  private async updateRecords(input: NoteStoreRpc["recordManagerUpdate"]): Promise<void> {
    const { keys, groupIds, timeAtLeast } = input;
    validKeys(keys);
    if (
      (groupIds !== undefined &&
        (!Array.isArray(groupIds) ||
          groupIds.length !== keys.length ||
          groupIds.some((group) => group !== null && typeof group !== "string"))) ||
      (timeAtLeast !== undefined && !Number.isSafeInteger(timeAtLeast))
    )
      throw new TypeError("Invalid record update");
    if (!keys.length) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = Number(
        rows(this.db, "SELECT value FROM note_record_clock WHERE id=1")[0].value
      );
      if (timeAtLeast !== undefined && current < timeAtLeast)
        throw new Error("Record manager time is earlier than timeAtLeast");
      const updatedAt = Math.max(current + 1, (timeAtLeast ?? 0) + 1);
      if (!Number.isSafeInteger(updatedAt)) throw new Error("Record manager clock is exhausted");
      this.db.exec({
        sql: "UPDATE note_record_clock SET value=? WHERE id=1",
        bind: [updatedAt],
      });
      for (let index = 0; index < keys.length; index++) {
        if (groupIds === undefined) {
          this.db.exec({
            sql: `INSERT INTO note_records(uid,group_path,updated_at) VALUES(?,NULL,?)
              ON CONFLICT(uid) DO UPDATE SET updated_at=excluded.updated_at`,
            bind: [keys[index], updatedAt],
          });
        } else {
          this.db.exec({
            sql: `INSERT INTO note_records(uid,group_path,updated_at) VALUES(?,?,?)
              ON CONFLICT(uid) DO UPDATE SET group_path=excluded.group_path,updated_at=excluded.updated_at`,
            bind: [keys[index], groupIds[index], updatedAt],
          });
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    }
  }

  private reserveRecordTime(): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const next = this.tickRecordClock();
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    }
  }

  private tickRecordClock(): number {
    const current = Number(
      rows(this.db, "SELECT value FROM note_record_clock WHERE id=1")[0].value
    );
    const next = current + 1;
    if (!Number.isSafeInteger(next)) throw new Error("Record manager clock is exhausted");
    this.db.exec({ sql: "UPDATE note_record_clock SET value=? WHERE id=1", bind: [next] });
    return next;
  }

  private recordExists(input: NoteStoreRpc["recordManagerExists"]): boolean[] {
    const { keys } = input;
    validKeys(keys);
    if (!keys.length) return [];
    const found = rows(
      this.db,
      `SELECT r.uid FROM note_records r JOIN note_index n ON n.current_uid=r.uid
      WHERE r.uid IN (${keys.map(() => "?").join(",")})`,
      keys
    );
    const existing = new Set(found.map((row) => String(row.uid)));
    return keys.map((key) => existing.has(key));
  }

  private listRecordKeys(input: NoteStoreRpc["recordManagerListKeys"]): string[] {
    const { before, after, groupIds, limit } = input;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      (before !== undefined && !Number.isSafeInteger(before)) ||
      (after !== undefined && !Number.isSafeInteger(after)) ||
      (groupIds !== undefined &&
        (!Array.isArray(groupIds) ||
          groupIds.length > 1000 ||
          groupIds.some((group) => group !== null && typeof group !== "string")))
    )
      throw new TypeError("Invalid record key page");
    if (groupIds?.length === 0) return [];
    const clauses: string[] = [];
    const binds: unknown[] = [];
    if (before !== undefined) {
      clauses.push("updated_at<?");
      binds.push(before);
    }
    if (after !== undefined) {
      clauses.push("updated_at>?");
      binds.push(after);
    }
    if (groupIds !== undefined) {
      const values = groupIds.filter((group): group is string => group !== null);
      const hasNull = values.length !== groupIds.length;
      clauses.push(
        `(${values.length ? `group_path IN (${values.map(() => "?").join(",")})` : "0"}${hasNull ? " OR group_path IS NULL" : ""})`
      );
      binds.push(...values);
    }
    binds.push(limit);
    return rows(
      this.db,
      `SELECT uid FROM note_records${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY uid COLLATE BINARY LIMIT ?`,
      binds
    ).map((row) => String(row.uid));
  }

  private deleteRecords(input: NoteStoreRpc["recordManagerDeleteKeys"]): void {
    const { keys } = input;
    validKeys(keys);
    if (!keys.length) return;
    this.db.exec({
      sql: `DELETE FROM note_records WHERE uid IN (${keys.map(() => "?").join(",")})`,
      bind: keys,
    });
  }
}
