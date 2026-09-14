import {
  SQLITE_MAX_RESULTS,
  type SqliteHit,
  type SqliteNoteInput,
  type SqliteState,
  type SqliteMutationResult,
  type SqliteNoteSummary,
  type SqliteReconciliationPlan,
  sqliteError,
} from "./protocol";
import { SQLITE_APPLICATION_ID, SQLITE_SCHEMA_VERSION, schemaSql } from "./schema";

export interface SqliteStatement {
  bind(values: readonly unknown[]): SqliteStatement;
  stepReset(): SqliteStatement;
  finalize(): void;
}

export interface SqliteConnection {
  exec(
    options:
      | string
      | {
          readonly sql: string;
          readonly bind?: readonly unknown[];
          readonly rowMode?: "object";
          readonly callback?: (row: Record<string, unknown>) => void;
        }
  ): void;
  prepare?(sql: string): SqliteStatement;
  close(): void;
}

const APP_VERSION = "trama";
const EXTRACTION_VERSION = 1;
const CHUNK_ALGORITHM_VERSION = 2;
const RRF_K = 60;

function rows(
  db: SqliteConnection,
  sql: string,
  bind: readonly unknown[] = []
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  db.exec({ sql, bind, rowMode: "object", callback: (row) => result.push(row) });
  return result;
}

function transaction(db: SqliteConnection, body: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    body();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original SQLite error.
    }
    throw error;
  }
}

function vectorBytes(vector: Float32Array, dimensions?: number): Uint8Array {
  if (dimensions !== undefined && vector.length !== dimensions)
    throw sqliteError("invalid_request", "Vector dimensions mismatch");
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (!Number.isFinite(norm) || norm <= 0)
    throw sqliteError("invalid_request", "Vector must have non-zero magnitude");
  const scale = 1 / Math.sqrt(norm);
  const normalized = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index++) normalized[index] = vector[index] * scale;
  return new Uint8Array(normalized.buffer);
}

function bytesOf(value: unknown): Uint8Array {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : value instanceof Uint8Array
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array();
  if (!bytes.byteLength || bytes.byteLength % 4 !== 0)
    throw sqliteError("integrity_failed", "Stored vector bytes are invalid");
  return bytes;
}

function vectorOf(value: unknown): Float32Array {
  const bytes = bytesOf(value);
  return new Float32Array(bytes.slice().buffer);
}

function hit(row: Record<string, unknown>): SqliteHit {
  const score = Number(row.score);
  return {
    id: String(row.id),
    path: String(row.path),
    contentId: String(row.contentId),
    ordinal: Number(row.ordinal),
    score,
    text: String(row.text),
    startLine: Number(row.startLine),
    endLine: Number(row.endLine),
    ...(row.fusedScore === undefined ? {} : { fusedScore: Number(row.fusedScore) }),
    ...(row.semanticScore === undefined ? {} : { semanticScore: Number(row.semanticScore) }),
    ...(row.lexicalScore === undefined ? {} : { lexicalScore: Number(row.lexicalScore) }),
  };
}

/** SQLite statements and invariants for one mutable, eventually-consistent index. */
export class MutableSqliteDatabase {
  private dimensions = 0;
  private closed = false;

  constructor(private readonly db: SqliteConnection) {}

  boot(fingerprint: string, dimensions: number): SqliteState {
    if (this.closed) throw sqliteError("storage_unavailable", "Database is closed");
    this.dimensions = dimensions;
    const application = Number(
      rows(this.db, "PRAGMA application_id")[0]?.application_id ?? SQLITE_APPLICATION_ID
    );
    const version = Number(
      rows(this.db, "PRAGMA user_version")[0]?.user_version ?? SQLITE_SCHEMA_VERSION
    );
    if (
      application !== SQLITE_APPLICATION_ID ||
      (version !== 0 && version !== SQLITE_SCHEMA_VERSION)
    ) {
      this.resetSchema(dimensions, fingerprint);
    } else {
      this.db.exec(schemaSql(dimensions));
      const state = rows(this.db, "SELECT * FROM index_state WHERE id=1")[0];
      if (
        state &&
        (Number(state.dimensions) !== dimensions ||
          String(state.fingerprint) !== fingerprint ||
          Number(state.schema_version) !== SQLITE_SCHEMA_VERSION)
      )
        this.resetSchema(dimensions, fingerprint);
      else if (!state)
        transaction(this.db, () => {
          this.db.exec({
            sql: "INSERT INTO index_state(id,app_version,schema_version,extraction_version,chunk_algorithm_version,dimensions,fingerprint,incomplete,change_counter) VALUES(1,?,?,?,?,?,?,1,0)",
            bind: [
              APP_VERSION,
              SQLITE_SCHEMA_VERSION,
              EXTRACTION_VERSION,
              CHUNK_ALGORITHM_VERSION,
              dimensions,
              fingerprint,
            ],
          });
        });
    }
    this.initializeVector();
    // Every open fences uncertainty from events that may have arrived while
    // the previous Worker was stopped. Update/Rebuild re-establishes complete.
    return this.markIncomplete();
  }

  getState(): SqliteState {
    this.ensureOpen();
    const state = rows(this.db, "SELECT * FROM index_state WHERE id=1")[0];
    if (!state) throw sqliteError("incompatible_state", "SQLite state is not initialized");
    const counts = rows(
      this.db,
      "SELECT (SELECT count(*) FROM notes) AS noteCount, (SELECT count(*) FROM chunks) AS chunkCount"
    )[0];
    return {
      schemaVersion: Number(state.schema_version),
      dimensions: Number(state.dimensions),
      fingerprint: String(state.fingerprint),
      incomplete: Number(state.incomplete) !== 0,
      changeCounter: Number(state.change_counter),
      noteCount: Number(counts.noteCount),
      chunkCount: Number(counts.chunkCount),
    };
  }

  listNotes(): readonly { path: string; contentId: string; chunkCount: number }[] {
    this.ensureOpen();
    return rows(
      this.db,
      "SELECT n.path, n.content_id AS contentId, count(c.chunk_pk) AS chunkCount FROM notes n LEFT JOIN chunks c ON c.note_pk=n.note_pk GROUP BY n.note_pk ORDER BY n.path COLLATE BINARY"
    ).map((row) => ({
      path: String(row.path),
      contentId: String(row.contentId),
      chunkCount: Number(row.chunkCount),
    }));
  }

  planReconciliation(summaries: readonly SqliteNoteSummary[]): SqliteReconciliationPlan {
    this.ensureOpen();
    const manifest = JSON.stringify(summaries);
    const planned = rows(
      this.db,
      `WITH expected(path,content_id) AS MATERIALIZED (
         SELECT json_extract(value,'$.path'),json_extract(value,'$.contentId') FROM json_each(?)
       ), actual(path,content_id) AS MATERIALIZED (
         SELECT path,content_id FROM notes
       ), missing AS MATERIALIZED (
         SELECT a.* FROM actual a WHERE NOT EXISTS(SELECT 1 FROM expected e WHERE e.path=a.path)
       ), added AS MATERIALIZED (
         SELECT e.* FROM expected e WHERE NOT EXISTS(SELECT 1 FROM actual a WHERE a.path=e.path)
       ), old_ranked AS MATERIALIZED (
         SELECT *,ROW_NUMBER() OVER(PARTITION BY content_id ORDER BY path COLLATE BINARY) AS rank
           FROM missing
       ), new_ranked AS MATERIALIZED (
         SELECT *,ROW_NUMBER() OVER(PARTITION BY content_id ORDER BY path COLLATE BINARY) AS rank
           FROM added
       ), renames AS MATERIALIZED (
         SELECT o.path,n.path AS target,o.content_id
           FROM old_ranked o JOIN new_ranked n
             ON n.content_id=o.content_id AND n.rank=o.rank
       ), upserts AS MATERIALIZED (
         SELECT e.path,NULL AS target,e.content_id
           FROM expected e LEFT JOIN actual a ON a.path=e.path
          WHERE (a.path IS NULL OR a.content_id<>e.content_id)
            AND NOT EXISTS(SELECT 1 FROM renames r WHERE r.target=e.path)
       ), deletes AS MATERIALIZED (
         SELECT m.path,NULL AS target,m.content_id
           FROM missing m
          WHERE NOT EXISTS(SELECT 1 FROM renames r WHERE r.path=m.path)
       )
       SELECT 'rename' AS kind,path,target,content_id AS contentId FROM renames
       UNION ALL SELECT 'upsert',path,target,content_id FROM upserts
       UNION ALL SELECT 'delete',path,target,content_id FROM deletes
       ORDER BY kind COLLATE BINARY,path COLLATE BINARY`,
      [manifest]
    );
    const renames = planned
      .filter((row) => row.kind === "rename")
      .map((row) => ({
        from: String(row.path),
        to: String(row.target),
        contentId: String(row.contentId),
      }));
    const upserts = planned
      .filter((row) => row.kind === "upsert")
      .map((row) => ({ path: String(row.path), contentId: String(row.contentId) }));
    const deletes = planned
      .filter((row) => row.kind === "delete")
      .map((row) => ({ path: String(row.path), contentId: String(row.contentId) }));
    return {
      renames,
      upserts,
      deletes,
      state: planned.length ? this.markIncomplete() : this.getState(),
    };
  }

  /** Durably fences a vault event observed after a reconciliation snapshot. */
  markIncomplete(): SqliteState {
    this.ensureOpen();
    const current = this.getState();
    if (!current.incomplete) {
      transaction(this.db, () => {
        this.db.exec(
          "UPDATE index_state SET incomplete=1, change_counter=change_counter+1 WHERE id=1"
        );
      });
    }
    return this.getState();
  }

  beginRebuild(): SqliteState {
    this.ensureOpen();
    transaction(this.db, () => {
      this.db.exec("DELETE FROM chunks; DELETE FROM notes;");
      this.markMutation(true);
    });
    return this.getState();
  }

  upsertNote(note: SqliteNoteInput): SqliteMutationResult {
    this.ensureOpen();
    const existing = rows(
      this.db,
      "SELECT note_pk, content_id AS contentId FROM notes WHERE path=?",
      [note.path]
    )[0];
    if (existing && String(existing.contentId).toLowerCase() === note.contentId.toLowerCase())
      return { changed: false, status: "unchanged", state: this.getState() };
    transaction(this.db, () => {
      this.markMutation(true);
      if (existing)
        this.db.exec({ sql: "DELETE FROM notes WHERE note_pk=?", bind: [existing.note_pk] });
      this.db.exec({
        sql: "INSERT INTO notes(path,content_id) VALUES(?,?)",
        bind: [note.path, note.contentId],
      });
      const pk = rows(this.db, "SELECT note_pk FROM notes WHERE path=?", [note.path])[0].note_pk;
      const sql =
        "INSERT INTO chunks(note_pk,chunk_id,ordinal,start_line,end_line,path_text,filename,body,embedding) VALUES(?,?,?,?,?,?,?,?,vector_as_f32(?))";
      const statement = this.db.prepare?.(sql);
      const filename = note.path.slice(note.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
      try {
        for (const chunk of note.chunks) {
          const vector = vectorBytes(chunk.vector, this.dimensions);
          const bind = [
            pk,
            chunk.id,
            chunk.ordinal,
            chunk.startLine,
            chunk.endLine,
            note.path,
            filename,
            chunk.text,
            vector,
          ];
          if (statement) statement.bind(bind).stepReset();
          else this.db.exec({ sql, bind });
        }
      } finally {
        statement?.finalize();
      }
    });
    return { changed: true, status: "changed", state: this.getState() };
  }

  renameNote(from: string, to: string, contentId?: string): SqliteMutationResult {
    this.ensureOpen();
    const row = rows(this.db, "SELECT note_pk, content_id AS contentId FROM notes WHERE path=?", [
      from,
    ])[0];
    const destination = rows(this.db, "SELECT content_id AS contentId FROM notes WHERE path=?", [
      to,
    ])[0];
    if (!row) {
      if (destination && (!contentId || String(destination.contentId) === contentId))
        return { changed: false, status: "alreadyApplied", state: this.getState() };
      return {
        changed: false,
        status: destination ? "state_changed" : "absent",
        ...(destination ? { rescan: true } : {}),
        state: this.getState(),
      };
    }
    if (contentId && String(row.contentId) !== contentId)
      return { changed: false, status: "state_changed", rescan: true, state: this.getState() };
    if (from === to) return { changed: false, status: "unchanged", state: this.getState() };
    if (destination) {
      return { changed: false, status: "state_changed", rescan: true, state: this.getState() };
    }
    transaction(this.db, () => {
      this.markMutation(true);
      this.db.exec({ sql: "UPDATE notes SET path=? WHERE note_pk=?", bind: [to, row.note_pk] });
      const filename = to.slice(to.lastIndexOf("/") + 1).replace(/\.md$/i, "");
      this.db.exec({
        sql: "UPDATE chunks SET path_text=?,filename=? WHERE note_pk=?",
        bind: [to, filename, row.note_pk],
      });
    });
    return { changed: true, status: "changed", state: this.getState() };
  }

  deleteNote(path: string, contentId?: string): SqliteMutationResult {
    this.ensureOpen();
    const row = rows(this.db, "SELECT note_pk, content_id AS contentId FROM notes WHERE path=?", [
      path,
    ])[0];
    if (!row) return { changed: false, status: "absent", state: this.getState() };
    if (contentId && String(row.contentId) !== contentId)
      return { changed: false, status: "state_changed", rescan: true, state: this.getState() };
    transaction(this.db, () => {
      this.markMutation(true);
      this.db.exec({ sql: "DELETE FROM notes WHERE note_pk=?", bind: [row.note_pk] });
    });
    return { changed: true, status: "changed", state: this.getState() };
  }

  finishReconciliation(
    summaries: readonly SqliteNoteSummary[],
    observedChangeCounter: number
  ): SqliteState {
    this.ensureOpen();
    const current = this.getState();
    if (!current.incomplete) return current;
    const manifest = JSON.stringify(summaries);
    transaction(this.db, () => {
      this.db.exec({
        sql: `WITH expected(path,content_id,chunk_count) AS MATERIALIZED (
                SELECT json_extract(value,'$.path'),json_extract(value,'$.contentId'),json_extract(value,'$.chunkCount')
                  FROM json_each(?)
              ), actual(path,content_id,chunk_count) AS MATERIALIZED (
                SELECT n.path,n.content_id,count(c.chunk_pk)
                  FROM notes n LEFT JOIN chunks c ON c.note_pk=n.note_pk
                 GROUP BY n.note_pk
              ), missing_expected(path,content_id) AS (
                SELECT path,content_id FROM expected
                EXCEPT
                SELECT path,content_id FROM actual
              ), missing_actual(path,content_id) AS (
                SELECT path,content_id FROM actual
                EXCEPT
                SELECT path,content_id FROM expected
              ), differences AS (
                SELECT path FROM missing_expected
                UNION ALL
                SELECT path FROM missing_actual
                UNION ALL
                SELECT e.path
                  FROM expected e JOIN actual a
                    ON a.path=e.path AND a.content_id=e.content_id
                 WHERE e.chunk_count IS NOT NULL AND e.chunk_count<>a.chunk_count
              )
              UPDATE index_state
                 SET incomplete=0,reconciliation_summary=?
               WHERE id=1 AND incomplete=1 AND change_counter=?
                 AND NOT EXISTS(SELECT 1 FROM differences)`,
        bind: [manifest, `notes:${summaries.length}`, observedChangeCounter],
      });
    });
    return this.getState();
  }

  retrieve(
    query: string | undefined,
    vector: Float32Array | undefined,
    limit: number,
    currentPath?: string,
    options: {
      readonly semanticCandidateLimit?: number;
      readonly lexicalCandidateLimit?: number;
      readonly lexicalProfile?: "voce" | "lente";
      readonly resultShape?: "chunks" | "notes";
    } = {}
  ): readonly SqliteHit[] {
    this.ensureOpen();
    const resultLimit = Math.min(SQLITE_MAX_RESULTS, Math.max(0, limit));
    if (resultLimit === 0) return [];
    const semanticLimit = Math.min(
      SQLITE_MAX_RESULTS,
      Math.max(0, options.semanticCandidateLimit ?? limit)
    );
    const lexicalLimit = Math.min(
      SQLITE_MAX_RESULTS,
      Math.max(0, options.lexicalCandidateLimit ?? limit)
    );
    const noteShape = options.resultShape === "notes" || options.lexicalProfile === "lente";
    const ctes: string[] = [];
    const bind: unknown[] = [];
    const channels: string[] = [];

    if (vector && semanticLimit > 0) {
      const bytes = vectorBytes(vector, this.dimensions);
      const pathClause = currentPath ? "WHERE n.path<>?" : "";
      ctes.push(`semantic_scored AS MATERIALIZED (
        SELECT c.chunk_pk AS chunkPk,c.chunk_id AS id,n.path,c.ordinal,v.distance
          FROM vector_full_scan('chunks','embedding',?) v
          JOIN chunks c ON c.chunk_pk=v.rowid
          JOIN notes n ON n.note_pk=c.note_pk ${pathClause}
      )`);
      bind.push(bytes);
      if (currentPath) bind.push(currentPath);
      if (noteShape) {
        ctes.push(`semantic_shaped AS (
          SELECT *,ROW_NUMBER() OVER (
            PARTITION BY path ORDER BY distance,path COLLATE BINARY,ordinal,id COLLATE BINARY
          ) AS shapeRank
            FROM semantic_scored
        ), semantic_ordered AS MATERIALIZED (
          SELECT *,max(-1.0,min(1.0,1.0-distance)) AS score,
                 ROW_NUMBER() OVER (ORDER BY distance,path COLLATE BINARY,ordinal,id COLLATE BINARY) AS channelRank
            FROM semantic_shaped WHERE shapeRank=1
        ), semantic_boundary AS (
          SELECT score FROM semantic_ordered WHERE channelRank=?
        ), semantic AS (
          SELECT chunkPk,id,path,ordinal,score,channelRank,0 AS channel
            FROM semantic_ordered
           WHERE channelRank<=? OR score>=(SELECT score FROM semantic_boundary)-0.00001
        )`);
        bind.push(semanticLimit, semanticLimit);
      } else {
        ctes.push(`semantic_limited AS MATERIALIZED (
          SELECT *,max(-1.0,min(1.0,1.0-distance)) AS score
            FROM semantic_scored
           ORDER BY distance,path COLLATE BINARY,ordinal,id COLLATE BINARY LIMIT ?
        ), semantic AS (
          SELECT chunkPk,id,path,ordinal,score,ROW_NUMBER() OVER (
            ORDER BY distance,path COLLATE BINARY,ordinal,id COLLATE BINARY
          ) AS channelRank,0 AS channel
            FROM semantic_limited
        )`);
        bind.push(semanticLimit);
      }
      channels.push("SELECT * FROM semantic");
    }

    const expression = query
      ? [...new Set(literalTerms(query))]
          .slice(0, 64)
          .map((term) => safeFtsQuery(term))
          .join(" OR ")
      : "";
    if (expression && lexicalLimit > 0) {
      const scopedExpression =
        (options.lexicalProfile ?? "voce") === "voce" ? `body:(${expression})` : expression;
      const pathClause = currentPath ? "AND n.path<>?" : "";
      const limitClause = noteShape
        ? ""
        : "ORDER BY lexicalRank,path COLLATE BINARY,ordinal,id COLLATE BINARY LIMIT ?";
      ctes.push(`lexical_raw AS MATERIALIZED (
        SELECT c.chunk_pk AS chunkPk,c.chunk_id AS id,n.path,c.ordinal,
               bm25(chunks_fts,1,2,3) AS lexicalRank
          FROM chunks_fts
          JOIN chunks c ON c.chunk_pk=chunks_fts.rowid
          JOIN notes n ON n.note_pk=c.note_pk
         WHERE chunks_fts MATCH ? ${pathClause} ${limitClause}
      )`);
      bind.push(scopedExpression);
      if (currentPath) bind.push(currentPath);
      if (!noteShape) bind.push(lexicalLimit);
      ctes.push(`lexical_shaped AS (
        SELECT *,${
          noteShape
            ? "ROW_NUMBER() OVER (PARTITION BY path ORDER BY lexicalRank,path COLLATE BINARY,ordinal,id COLLATE BINARY)"
            : "1"
        } AS shapeRank
          FROM lexical_raw
      ), lexical_scored AS (
        SELECT *,CASE
          WHEN min(lexicalRank) OVER ()<0 THEN lexicalRank/min(lexicalRank) OVER ()
          ELSE (1.0+min(lexicalRank) OVER ())/(1.0+lexicalRank)
        END AS score
          FROM lexical_shaped WHERE shapeRank=1
      ), lexical_ordered AS MATERIALIZED (
        SELECT *,ROW_NUMBER() OVER (
          ORDER BY lexicalRank,path COLLATE BINARY,ordinal,id COLLATE BINARY
        ) AS channelRank
          FROM lexical_scored
      ), lexical_boundary AS (
        SELECT score FROM lexical_ordered WHERE channelRank=?
      ), lexical AS (
        SELECT chunkPk,id,path,ordinal,score,channelRank,1 AS channel
          FROM lexical_ordered
         WHERE channelRank<=? OR score>=(SELECT score FROM lexical_boundary)-0.00001
      )`);
      bind.push(lexicalLimit, lexicalLimit);
      channels.push("SELECT * FROM lexical");
    }

    if (!channels.length) return [];
    const hydratedColumns =
      "c.chunk_id AS id,n.path,n.content_id AS contentId,c.ordinal,c.start_line AS startLine,c.end_line AS endLine,c.body AS text";
    let finalSql: string;
    if (channels.length === 1) {
      const name = channels[0].includes("semantic") ? "semantic" : "lexical";
      const scoreColumn = name === "semantic" ? "semanticScore" : "lexicalScore";
      finalSql = `SELECT ${hydratedColumns},e.score,e.score AS ${scoreColumn}
        FROM ${name} e JOIN chunks c ON c.chunk_pk=e.chunkPk JOIN notes n ON n.note_pk=c.note_pk
       ORDER BY e.score DESC,n.path COLLATE BINARY,c.ordinal,c.chunk_id COLLATE BINARY LIMIT ?`;
    } else {
      ctes.push(`combined AS (${channels.join(" UNION ALL ")}), keyed AS (
        SELECT *,${noteShape ? "path" : "CAST(chunkPk AS TEXT)"} AS resultKey FROM combined
      ), fused_window AS (
        SELECT *,sum(1.0/(${RRF_K}+channelRank)) OVER (PARTITION BY resultKey) AS fusedScore,
               max(CASE WHEN channel=0 THEN score END) OVER (PARTITION BY resultKey) AS semanticScore,
               max(CASE WHEN channel=1 THEN score END) OVER (PARTITION BY resultKey) AS lexicalScore,
               ROW_NUMBER() OVER (
                 PARTITION BY resultKey
                 ORDER BY channelRank,channel,score DESC,ordinal,id COLLATE BINARY
               ) AS evidenceRank
          FROM keyed
      ), fused AS (SELECT * FROM fused_window WHERE evidenceRank=1)`);
      finalSql = `SELECT ${hydratedColumns},e.fusedScore AS score,e.fusedScore,e.semanticScore,e.lexicalScore
        FROM fused e JOIN chunks c ON c.chunk_pk=e.chunkPk JOIN notes n ON n.note_pk=c.note_pk
       ORDER BY e.fusedScore DESC,n.path COLLATE BINARY,c.ordinal,c.chunk_id COLLATE BINARY LIMIT ?`;
    }
    bind.push(resultLimit);
    return rows(this.db, `WITH ${ctes.join(",")} ${finalSql}`, bind).map(hit);
  }

  findRelated(path: string, vector: Float32Array | undefined, limit: number): readonly SqliteHit[] {
    let queryVector = vector;
    if (!queryVector) {
      const noteRows = rows(
        this.db,
        "SELECT c.embedding FROM chunks c JOIN notes n ON n.note_pk=c.note_pk WHERE n.path=? ORDER BY c.ordinal",
        [path]
      );
      if (!noteRows.length) return [];
      const sum = new Float64Array(this.dimensions);
      for (const row of noteRows) {
        const values = vectorOf(row.embedding);
        if (values.length !== sum.length)
          throw sqliteError("integrity_failed", "Stored vector dimensions mismatch");
        for (let i = 0; i < sum.length; i++) sum[i] += values[i];
      }
      let norm = 0;
      for (const value of sum) norm += value * value;
      if (!(norm > 1e-12)) return [];
      const scale = 1 / Math.sqrt(norm);
      queryVector = new Float32Array(sum.length);
      for (let i = 0; i < sum.length; i++) queryVector[i] = sum[i] * scale;
    }
    return this.retrieve(undefined, queryVector, limit, path, {
      semanticCandidateLimit: Math.min(128, Math.max(limit, 1)),
      resultShape: "notes",
    });
  }

  /** Validates a closed-import candidate without changing the live database. */
  validateSnapshot(fingerprint: string, dimensions: number): void {
    try {
      this.validateSnapshotContents(fingerprint, dimensions);
    } catch (error) {
      if (error && typeof error === "object" && "error" in error) throw error;
      throw sqliteError("integrity_failed", "Snapshot integrity check failed");
    }
  }

  private validateSnapshotContents(fingerprint: string, dimensions: number): void {
    this.ensureOpen();
    this.dimensions = dimensions;
    const application = Number(rows(this.db, "PRAGMA application_id")[0]?.application_id ?? 0);
    const version = Number(rows(this.db, "PRAGMA user_version")[0]?.user_version ?? 0);
    if (application !== SQLITE_APPLICATION_ID || version !== SQLITE_SCHEMA_VERSION)
      throw sqliteError("incompatible_state", "Snapshot compatibility check failed");
    const state = rows(
      this.db,
      "SELECT app_version, schema_version, dimensions, fingerprint FROM index_state WHERE id=1"
    )[0];
    if (
      !state ||
      String(state.app_version) !== APP_VERSION ||
      Number(state.schema_version) !== SQLITE_SCHEMA_VERSION ||
      Number(state.dimensions) !== dimensions ||
      String(state.fingerprint) !== fingerprint
    )
      throw sqliteError("incompatible_state", "Snapshot compatibility check failed");
    const integrity = String(rows(this.db, "PRAGMA integrity_check")[0]?.integrity_check ?? "");
    if (integrity !== "ok")
      throw sqliteError("integrity_failed", "Snapshot integrity check failed");
    if (rows(this.db, "PRAGMA foreign_key_check").length)
      throw sqliteError("integrity_failed", "Snapshot integrity check failed");
    this.initializeVector();
    try {
      this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES ('integrity-check')");
    } catch {
      throw sqliteError("integrity_failed", "Snapshot integrity check failed");
    }
    const invalidVectors = Number(
      rows(this.db, "SELECT count(*) AS count FROM chunks WHERE length(embedding)<>?", [
        dimensions * 4,
      ])[0]?.count ?? 0
    );
    if (invalidVectors !== 0)
      throw sqliteError("integrity_failed", "Snapshot vector integrity check failed");
  }

  /** Marks a validated imported state incomplete and advances its counter. */
  markImported(previousChangeCounter: number): SqliteState {
    this.ensureOpen();
    const current = this.getState();
    const next = Math.max(current.changeCounter + 1, previousChangeCounter + 1);
    transaction(this.db, () => {
      this.db.exec({
        sql: "UPDATE index_state SET incomplete=1, change_counter=? WHERE id=1",
        bind: [next],
      });
    });
    return this.getState();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private resetSchema(dimensions: number, fingerprint: string): void {
    this.db.exec(
      `PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY; PRAGMA application_id=${SQLITE_APPLICATION_ID}; PRAGMA user_version=${SQLITE_SCHEMA_VERSION};`
    );
    transaction(this.db, () => {
      this.db.exec(
        "DROP TRIGGER IF EXISTS chunks_ai; DROP TRIGGER IF EXISTS chunks_ad; DROP TRIGGER IF EXISTS chunks_au; DROP TRIGGER IF EXISTS chunks_au_fts; DROP TRIGGER IF EXISTS chunks_au_vec; DROP TRIGGER IF EXISTS notes_au; DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks_vec; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS notes; DROP TABLE IF EXISTS index_state;"
      );
      this.db.exec(schemaSql(dimensions).replace(/^PRAGMA[^\n]*\n/gm, ""));
      this.db.exec({
        sql: "INSERT INTO index_state(id,app_version,schema_version,extraction_version,chunk_algorithm_version,dimensions,fingerprint,incomplete,change_counter) VALUES(1,?,?,?,?,?,?,1,1)",
        bind: [
          APP_VERSION,
          SQLITE_SCHEMA_VERSION,
          EXTRACTION_VERSION,
          CHUNK_ALGORITHM_VERSION,
          dimensions,
          fingerprint,
        ],
      });
    });
  }

  private markMutation(incomplete: boolean): void {
    this.db.exec({
      sql: "UPDATE index_state SET incomplete=CASE WHEN ? THEN 1 ELSE incomplete END, change_counter=change_counter+1 WHERE id=1",
      bind: [incomplete ? 1 : 0],
    });
  }

  private initializeVector(): void {
    this.db.exec({
      sql: "SELECT vector_init('chunks','embedding',?)",
      bind: [`dimension=${this.dimensions},type=FLOAT32,distance=COSINE,normalized=1`],
    });
  }

  private ensureOpen(): void {
    if (this.closed) throw sqliteError("storage_unavailable", "Database is closed");
  }
}

export function literalTerms(query: string): readonly string[] {
  return (
    query
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.slice(0, 64) ?? []
  );
}

/** Converts user text to bound, quoted FTS5 literals; operators are never interpreted. */
export function safeFtsQuery(query: string): string {
  return [...new Set(literalTerms(query))]
    .slice(0, 64)
    .map((term) => `"${term.split('"').join('""')}"`)
    .join(" AND ");
}
