import {
  SQLITE_MAX_RESULTS,
  type MissingVector,
  type SqliteHit,
  type SqliteNoteInput,
  type SqliteState,
  type SqliteMutationResult,
  type SqliteNoteSummary,
  type SqliteReconciliationPlan,
  type StoredVectorInput,
  sqliteError,
} from "./protocol";
import {
  SQLITE_APPLICATION_ID,
  SQLITE_PROTOCOL_VERSION,
  SQLITE_SCHEMA_VERSION,
  schemaSql,
} from "./schema";
import { SQLITE_BUILD_IDENTITY } from "../../build/identity";

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
/** Float32 round-off from normalizedVector is well below this bound. */
export const SQLITE_VECTOR_NORMALIZATION_TOLERANCE = 1e-3;
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
      /* preserve original */
    }
    throw error;
  }
}
function normalizedVector(vector: Float32Array, dimensions: number): Uint8Array {
  if (vector.length !== dimensions || !vector.every(Number.isFinite))
    throw sqliteError("invalid_request", "Vector dimensions or values are invalid");
  let norm = 0;
  for (const x of vector) norm += x * x;
  if (!(norm > 0) || !Number.isFinite(norm))
    throw sqliteError("invalid_request", "Vector must have non-zero magnitude");
  const out = new Float32Array(dimensions);
  const scale = 1 / Math.sqrt(norm);
  for (let i = 0; i < dimensions; i++) out[i] = vector[i] * scale;
  return new Uint8Array(out.buffer);
}
function vectorOf(value: unknown): Float32Array {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : value instanceof Uint8Array
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array();
  if (!bytes.byteLength || bytes.byteLength % 4)
    throw sqliteError("integrity_failed", "Stored vector bytes are invalid");
  return new Float32Array(bytes.slice().buffer);
}
function hit(row: Record<string, unknown>): SqliteHit {
  return {
    id: String(row.id),
    path: String(row.path),
    contentId: String(row.contentId),
    ordinal: Number(row.ordinal),
    score: Number(row.score),
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
  private embeddingFingerprint = "";
  private closed = false;
  constructor(private readonly db: SqliteConnection) {}

  boot(
    corpusFingerprint: string,
    dimensions: number,
    embeddingFingerprint = "",
    buildIdentity: string = SQLITE_BUILD_IDENTITY
  ): SqliteState {
    this.ensureOpen();
    this.dimensions = dimensions;
    this.embeddingFingerprint = embeddingFingerprint;
    const app = Number(rows(this.db, "PRAGMA application_id")[0]?.application_id ?? 0);
    const version = Number(rows(this.db, "PRAGMA user_version")[0]?.user_version ?? 0);
    if (app === 0 && version === 0) {
      this.db.exec(schemaSql(dimensions));
      transaction(this.db, () =>
        this.db.exec({
          sql: "INSERT INTO index_state(id,app_version,schema_version,protocol_version,build_identity,extraction_version,chunk_algorithm_version,dimensions,corpus_fingerprint,embedding_fingerprint,incomplete,change_counter,snapshot_loaded) VALUES(1,?,?,?,?,?,?,?,?,?,1,0,0)",
          bind: [
            APP_VERSION,
            SQLITE_SCHEMA_VERSION,
            SQLITE_PROTOCOL_VERSION,
            buildIdentity,
            EXTRACTION_VERSION,
            CHUNK_ALGORITHM_VERSION,
            dimensions,
            corpusFingerprint,
            embeddingFingerprint,
          ],
        })
      );
    } else {
      if (app !== SQLITE_APPLICATION_ID || version !== SQLITE_SCHEMA_VERSION)
        throw sqliteError(
          "incompatible_state",
          "SQLite database schema/build is incompatible (expected schema 5).",
          false
        );
      this.db.exec(schemaSql(dimensions));
      const state = rows(this.db, "SELECT * FROM index_state WHERE id=1")[0];
      if (
        !state ||
        Number(state.protocol_version) !== SQLITE_PROTOCOL_VERSION ||
        String(state.build_identity) !== buildIdentity ||
        Number(state.dimensions) !== dimensions ||
        ![0, 1].includes(Number(state.snapshot_loaded))
      )
        throw sqliteError(
          "incompatible_state",
          "SQLite database build identity is incompatible.",
          false
        );
      const changedCorpus = String(state.corpus_fingerprint) !== corpusFingerprint;
      const changedEmbedding = String(state.embedding_fingerprint) !== embeddingFingerprint;
      if (changedCorpus || changedEmbedding)
        transaction(this.db, () =>
          this.db.exec({
            sql: "UPDATE index_state SET corpus_fingerprint=?,embedding_fingerprint=?,incomplete=CASE WHEN ? THEN 1 ELSE incomplete END,change_counter=change_counter+? WHERE id=1",
            bind: [
              corpusFingerprint,
              embeddingFingerprint,
              changedCorpus ? 1 : 0,
              changedCorpus || changedEmbedding ? 1 : 0,
            ],
          })
        );
    }
    this.initializeVector();
    return this.getState();
  }
  getState(): SqliteState {
    this.ensureOpen();
    const s = rows(this.db, "SELECT * FROM index_state WHERE id=1")[0];
    if (!s) throw sqliteError("incompatible_state", "SQLite state is not initialized");
    const c = rows(
      this.db,
      "SELECT (SELECT count(*) FROM notes) AS notes,(SELECT count(*) FROM chunks) AS chunks,(SELECT count(*) FROM chunk_vectors) AS vectors,(SELECT count(*) FROM chunk_vectors WHERE embedding_fingerprint=?) AS compatible",
      [String(s.embedding_fingerprint)]
    )[0];
    const chunks = Number(c.chunks);
    const compatible = Number(c.compatible);
    const coverage = compatible === 0 ? "none" : compatible === chunks ? "complete" : "partial";
    return {
      schemaVersion: Number(s.schema_version),
      protocolVersion: Number(s.protocol_version),
      buildIdentity: String(s.build_identity),
      dimensions: Number(s.dimensions),
      corpusFingerprint: String(s.corpus_fingerprint),
      embeddingFingerprint: String(s.embedding_fingerprint),
      incomplete: Number(s.incomplete) !== 0,
      snapshotLoaded: Number(s.snapshot_loaded) !== 0,
      changeCounter: Number(s.change_counter),
      noteCount: Number(c.notes),
      chunkCount: chunks,
      compatibleVectorCount: compatible,
      vectorCount: Number(c.vectors),
      vectorCoverage: coverage,
      semanticReady: coverage === "complete" && !Number(s.incomplete),
      ...(s.publication_id == null ? {} : { publicationId: String(s.publication_id) }),
    };
  }
  listNotes(): readonly { path: string; contentId: string; chunkCount: number }[] {
    this.ensureOpen();
    return rows(
      this.db,
      "SELECT n.path,n.content_id AS contentId,count(c.chunk_pk) AS chunkCount FROM notes n LEFT JOIN chunks c ON c.note_pk=n.note_pk GROUP BY n.note_pk ORDER BY n.path COLLATE BINARY"
    ).map((r) => ({
      path: String(r.path),
      contentId: String(r.contentId),
      chunkCount: Number(r.chunkCount),
    }));
  }
  planReconciliation(summaries: readonly SqliteNoteSummary[]): SqliteReconciliationPlan {
    const actual = this.listNotes();
    const expected = [...summaries].sort((a, b) => a.path.localeCompare(b.path));
    const missing = actual.filter((a) => !expected.some((e) => e.path === a.path));
    const added = expected.filter((e) => !actual.some((a) => a.path === e.path));
    const renames: { from: string; to: string; contentId: string }[] = [];
    for (const old of [...missing]) {
      const ix = added.findIndex((n) => n.contentId === old.contentId);
      if (ix >= 0) {
        const [n] = added.splice(ix, 1);
        renames.push({ from: old.path, to: n.path, contentId: old.contentId });
      }
    }
    const upserts = expected.filter((n) => {
      const old = actual.find((a) => a.path === n.path);
      return (!old || old.contentId !== n.contentId) && !renames.some((r) => r.to === n.path);
    });
    const deletes = missing.filter((n) => !renames.some((r) => r.from === n.path));
    return {
      renames: renames.sort((a, b) => a.from.localeCompare(b.from)),
      upserts,
      deletes,
      state:
        renames.length || upserts.length || deletes.length
          ? this.markIncomplete()
          : this.getState(),
    };
  }
  markIncomplete(): SqliteState {
    this.ensureOpen();
    const s = this.getState();
    if (!s.incomplete)
      transaction(this.db, () =>
        this.db.exec(
          "UPDATE index_state SET incomplete=1,change_counter=change_counter+1 WHERE id=1"
        )
      );
    return this.getState();
  }
  /** Starts a full lexical pass without discarding chunks whose identities may survive. */
  beginRebuild(): SqliteState {
    this.ensureOpen();
    transaction(this.db, () => {
      this.markMutation();
    });
    return this.getState();
  }

  clearVectors(): SqliteState {
    this.ensureOpen();
    if (this.getState().vectorCount > 0)
      transaction(this.db, () => {
        this.db.exec("DELETE FROM chunk_vectors");
        this.markMutation(false);
      });
    return this.getState();
  }

  upsertNote(note: SqliteNoteInput): SqliteMutationResult {
    this.ensureOpen();
    const old = rows(this.db, "SELECT note_pk,content_id AS contentId FROM notes WHERE path=?", [
      note.path,
    ])[0];
    if (
      old &&
      String(old.contentId) === note.contentId &&
      this.noteMatches(Number(old.note_pk), note)
    )
      return { changed: false, status: "unchanged", state: this.getState() };
    transaction(this.db, () => {
      this.markMutation();
      let pk: number;
      if (old) {
        pk = Number(old.note_pk);
        this.db.exec({
          sql: "UPDATE notes SET content_id=? WHERE note_pk=?",
          bind: [note.contentId, pk],
        });
      } else {
        this.db.exec({
          sql: "INSERT INTO notes(path,content_id) VALUES(?,?)",
          bind: [note.path, note.contentId],
        });
        pk = Number(
          rows(this.db, "SELECT note_pk FROM notes WHERE path=?", [note.path])[0].note_pk
        );
      }
      const wanted = new Set(note.chunks.map((c) => c.id));
      const current = rows(
        this.db,
        "SELECT chunk_pk,chunk_id,body,content_id FROM chunks WHERE note_pk=?",
        [pk]
      );
      for (const row of current)
        if (!wanted.has(String(row.chunk_id)))
          this.db.exec({ sql: "DELETE FROM chunks WHERE chunk_pk=?", bind: [row.chunk_pk] });
      const filename = note.path.slice(note.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
      const insert =
        "INSERT INTO chunks(note_pk,content_id,chunk_id,ordinal,start_line,end_line,path_text,filename,body) VALUES(?,?,?,?,?,?,?,?,?)";
      for (const chunk of note.chunks) {
        const prior = current.find((r) => String(r.chunk_id) === chunk.id);
        if (prior) {
          const same =
            String(prior.body) === chunk.text && String(prior.content_id) === note.contentId;
          this.db.exec({
            sql: "UPDATE chunks SET content_id=?,ordinal=?,start_line=?,end_line=?,path_text=?,filename=?,body=? WHERE chunk_pk=?",
            bind: [
              note.contentId,
              chunk.ordinal,
              chunk.startLine,
              chunk.endLine,
              note.path,
              filename,
              chunk.text,
              prior.chunk_pk,
            ],
          });
          if (!same)
            this.db.exec({
              sql: "DELETE FROM chunk_vectors WHERE chunk_pk=?",
              bind: [prior.chunk_pk],
            });
        } else
          this.db.exec({
            sql: insert,
            bind: [
              pk,
              note.contentId,
              chunk.id,
              chunk.ordinal,
              chunk.startLine,
              chunk.endLine,
              note.path,
              filename,
              chunk.text,
            ],
          });
      }
    });
    return { changed: true, status: "changed", state: this.getState() };
  }
  renameNote(from: string, to: string, contentId?: string): SqliteMutationResult {
    this.ensureOpen();
    const row = rows(this.db, "SELECT note_pk,content_id AS contentId FROM notes WHERE path=?", [
      from,
    ])[0];
    const dest = rows(this.db, "SELECT content_id AS contentId FROM notes WHERE path=?", [to])[0];
    if (!row)
      return {
        changed: false,
        status:
          dest && (!contentId || String(dest.contentId) === contentId)
            ? "alreadyApplied"
            : dest
              ? "state_changed"
              : "absent",
        ...(dest ? { rescan: true } : {}),
        state: this.getState(),
      };
    if (contentId && String(row.contentId) !== contentId)
      return { changed: false, status: "state_changed", rescan: true, state: this.getState() };
    if (dest || from === to)
      return {
        changed: false,
        status: from === to ? "unchanged" : "state_changed",
        ...(dest ? { rescan: true } : {}),
        state: this.getState(),
      };
    transaction(this.db, () => {
      this.markMutation();
      this.db.exec({ sql: "UPDATE notes SET path=? WHERE note_pk=?", bind: [to, row.note_pk] });
      const file = to.slice(to.lastIndexOf("/") + 1).replace(/\.md$/i, "");
      this.db.exec({
        sql: "UPDATE chunks SET path_text=?,filename=? WHERE note_pk=?",
        bind: [to, file, row.note_pk],
      });
    });
    return { changed: true, status: "changed", state: this.getState() };
  }
  deleteNote(path: string, contentId?: string): SqliteMutationResult {
    this.ensureOpen();
    const row = rows(this.db, "SELECT note_pk,content_id AS contentId FROM notes WHERE path=?", [
      path,
    ])[0];
    if (!row) return { changed: false, status: "absent", state: this.getState() };
    if (contentId && String(row.contentId) !== contentId)
      return { changed: false, status: "state_changed", rescan: true, state: this.getState() };
    transaction(this.db, () => {
      this.markMutation();
      this.db.exec({ sql: "DELETE FROM notes WHERE note_pk=?", bind: [row.note_pk] });
    });
    return { changed: true, status: "changed", state: this.getState() };
  }
  finishReconciliation(
    summaries: readonly SqliteNoteSummary[],
    observedChangeCounter: number
  ): SqliteState {
    const current = this.getState();
    if (current.changeCounter !== observedChangeCounter) return current;
    const expected = new Set(summaries.map((s) => s.path));
    const actual = this.listNotes();
    const extras = actual.filter((a) => !expected.has(a.path));
    const remaining = actual.filter((a) => expected.has(a.path));
    const same =
      remaining.length === summaries.length &&
      remaining.every((a) => {
        const s = summaries.find((item) => item.path === a.path);
        return (
          !!s &&
          s.contentId === a.contentId &&
          (s.chunkCount === undefined || s.chunkCount === a.chunkCount)
        );
      });
    if (same)
      transaction(this.db, () => {
        for (const old of extras)
          this.db.exec({ sql: "DELETE FROM notes WHERE path=?", bind: [old.path] });
        this.db.exec({
          sql: "UPDATE index_state SET incomplete=0,snapshot_loaded=0,reconciliation_summary=?,change_counter=change_counter+? WHERE id=1 AND change_counter=?",
          bind: [JSON.stringify(summaries), extras.length ? 1 : 0, observedChangeCounter],
        });
      });
    return this.getState();
  }

  listMissingVectors(
    embeddingFingerprint = this.embeddingFingerprint,
    limit = 128,
    afterChunkPk = 0
  ): readonly MissingVector[] {
    this.ensureOpen();
    return rows(
      this.db,
      "SELECT c.chunk_pk AS chunkPk,c.chunk_id AS chunkId,c.content_id AS contentId,c.ordinal,c.body AS text FROM chunks c LEFT JOIN chunk_vectors v ON v.chunk_pk=c.chunk_pk AND v.embedding_fingerprint=? WHERE v.chunk_pk IS NULL AND c.chunk_pk>? ORDER BY c.chunk_pk LIMIT ?",
      [embeddingFingerprint, afterChunkPk, limit]
    ).map((r) => ({
      chunkPk: Number(r.chunkPk),
      chunkId: String(r.chunkId),
      contentId: String(r.contentId),
      ordinal: Number(r.ordinal),
      text: String(r.text),
    }));
  }
  storeVectors(
    vectors: readonly StoredVectorInput[],
    embeddingFingerprint: string,
    observedChangeCounter: number
  ): { stored: number; skipped: number; state: SqliteState };
  storeVectors(payload: {
    readonly vectors: readonly StoredVectorInput[];
    readonly embeddingFingerprint: string;
    readonly observedChangeCounter: number;
  }): { stored: number; skipped: number; state: SqliteState };
  storeVectors(
    vectorsOrPayload:
      | readonly StoredVectorInput[]
      | {
          readonly vectors: readonly StoredVectorInput[];
          readonly embeddingFingerprint: string;
          readonly observedChangeCounter: number;
        },
    embeddingFingerprint?: string,
    observedChangeCounter?: number
  ): { stored: number; skipped: number; state: SqliteState } {
    this.ensureOpen();
    let vectors: readonly StoredVectorInput[];
    let fp: string;
    let counter: number;
    if (Array.isArray(vectorsOrPayload)) {
      vectors = vectorsOrPayload as readonly StoredVectorInput[];
      fp = embeddingFingerprint!;
      counter = observedChangeCounter!;
    } else {
      const payload = vectorsOrPayload as {
        readonly vectors: readonly StoredVectorInput[];
        readonly embeddingFingerprint: string;
        readonly observedChangeCounter: number;
      };
      vectors = payload.vectors;
      fp = payload.embeddingFingerprint;
      counter = payload.observedChangeCounter;
    }
    const before = this.getState();
    if (before.changeCounter !== counter)
      return { stored: 0, skipped: vectors.length, state: before };
    let stored = 0;
    let skipped = 0;
    transaction(this.db, () => {
      for (const item of vectors) {
        const row = rows(
          this.db,
          "SELECT chunk_pk,chunk_id,content_id FROM chunks WHERE chunk_pk=?",
          [item.chunkPk]
        )[0];
        if (
          !row ||
          String(row.chunk_id) !== item.chunkId ||
          String(row.content_id) !== item.contentId
        ) {
          skipped++;
          continue;
        }
        this.putVector(item.chunkId, item.contentId, item.vector, fp, Number(item.chunkPk));
        stored++;
      }
      if (stored) this.markMutation(false);
    });
    return { stored, skipped, state: this.getState() };
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
    if (!resultLimit) return [];
    const noteShape = options.resultShape === "notes" || options.lexicalProfile === "lente";
    const binds: unknown[] = [];
    const ctes: string[] = [];
    const channels: string[] = [];
    const semanticLimit = Math.min(
      SQLITE_MAX_RESULTS,
      Math.max(0, options.semanticCandidateLimit ?? limit)
    );
    if (vector && semanticLimit) {
      const bytes = normalizedVector(vector, this.dimensions);
      const semanticScanLimit = noteShape ? Math.max(semanticLimit, 8192) : semanticLimit;
      ctes.push(
        `semantic_raw AS MATERIALIZED (SELECT c.chunk_pk AS chunkPk,c.chunk_id AS id,n.path,c.ordinal,v.distance FROM vector_full_scan('chunk_vectors','vector',?) v JOIN chunks c ON c.chunk_pk=v.rowid JOIN chunk_vectors cv ON cv.chunk_pk=v.rowid JOIN notes n ON n.note_pk=c.note_pk WHERE cv.embedding_fingerprint=?${currentPath ? " AND n.path<>?" : ""})`
      );
      binds.push(bytes, this.embeddingFingerprint);
      if (currentPath) binds.push(currentPath);
      ctes.push(
        `semantic_ranked AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY path ORDER BY distance,path COLLATE BINARY,ordinal,id COLLATE BINARY) shapeRank FROM semantic_raw),semantic AS (SELECT chunkPk,id,path,ordinal,1.0-distance AS score,ROW_NUMBER() OVER (ORDER BY distance,path COLLATE BINARY,ordinal,id COLLATE BINARY) channelRank,0 AS channel FROM semantic_ranked WHERE ${noteShape ? "shapeRank=1 AND " : ""}1 ORDER BY distance,path COLLATE BINARY,ordinal,id COLLATE BINARY LIMIT ?)`
      );
      binds.push(semanticScanLimit);
      channels.push("SELECT * FROM semantic");
    }
    const expression = query
      ? [...new Set(literalTerms(query))]
          .slice(0, 64)
          .map((term) => `"${term.replace(/"/g, '""')}"`)
          .join(" OR ")
      : "";
    const lexicalLimit = Math.min(
      SQLITE_MAX_RESULTS,
      Math.max(0, options.lexicalCandidateLimit ?? limit)
    );
    if (expression && lexicalLimit) {
      const scoped = options.lexicalProfile === "voce" ? `body:(${expression})` : expression;
      ctes.push(
        `lexical_raw AS MATERIALIZED (SELECT c.chunk_pk AS chunkPk,c.chunk_id AS id,n.path,c.ordinal,bm25(chunks_fts,1,2,3) AS lexicalRank FROM chunks_fts JOIN chunks c ON c.chunk_pk=chunks_fts.rowid JOIN notes n ON n.note_pk=c.note_pk WHERE chunks_fts MATCH ?${currentPath ? " AND n.path<>?" : ""}),lexical_ranked AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY path ORDER BY lexicalRank,path COLLATE BINARY,ordinal,id COLLATE BINARY) shapeRank FROM lexical_raw),lexical_scored AS (SELECT *,CASE WHEN min(lexicalRank) OVER ()<0 THEN lexicalRank/min(lexicalRank) OVER () ELSE (1.0+min(lexicalRank) OVER ())/(1.0+lexicalRank) END AS score FROM lexical_ranked),lexical AS (SELECT chunkPk,id,path,ordinal,score,ROW_NUMBER() OVER (ORDER BY lexicalRank,path COLLATE BINARY,ordinal,id COLLATE BINARY) channelRank,1 AS channel FROM lexical_scored WHERE ${noteShape ? "shapeRank=1 AND " : ""}1 ORDER BY lexicalRank,path COLLATE BINARY,ordinal,id COLLATE BINARY LIMIT ?)`
      );
      binds.push(scoped);
      if (currentPath) binds.push(currentPath);
      binds.push(lexicalLimit);
      channels.push("SELECT * FROM lexical");
    }
    if (!channels.length) return [];
    // SQLite-Vector's table-valued scan cannot safely be combined with FTS5 in
    // one compound statement on all supported WASM builds. Keep the channels
    // independent and fuse their bounded, hydrated results deterministically.
    if (channels.length === 2) {
      const semantic = this.retrieve(undefined, vector, semanticLimit, currentPath, {
        semanticCandidateLimit: semanticLimit,
        resultShape: options.resultShape,
      });
      const lexical = this.retrieve(query, undefined, lexicalLimit, currentPath, {
        lexicalCandidateLimit: lexicalLimit,
        lexicalProfile: options.lexicalProfile,
        resultShape: options.resultShape,
      });
      type FusedHit = Omit<SqliteHit, "score" | "fusedScore" | "lexicalScore"> & {
        score: number;
        fusedScore?: number;
        lexicalScore?: number;
        rank: number;
        semanticRank?: number;
        lexicalRank?: number;
      };
      const fused = new Map<string, FusedHit>();
      semantic.forEach((item, rank) => {
        const key = noteShape ? item.path : item.id;
        fused.set(key, {
          ...item,
          rank,
          semanticRank: rank + 1,
          score: 1 / (RRF_K + rank + 1),
          fusedScore: 1 / (RRF_K + rank + 1),
          semanticScore: item.score,
        });
      });
      lexical.forEach((item, rank) => {
        const key = noteShape ? item.path : item.id;
        const prior = fused.get(key);
        if (prior) {
          prior.lexicalRank = rank + 1;
          prior.fusedScore = 1 / (RRF_K + prior.semanticRank!) + 1 / (RRF_K + rank + 1);
          prior.score = prior.fusedScore;
          prior.lexicalScore = item.score;
        } else
          fused.set(key, {
            ...item,
            rank,
            lexicalRank: rank + 1,
            score: 1 / (RRF_K + rank + 1),
            fusedScore: 1 / (RRF_K + rank + 1),
            lexicalScore: item.score,
          });
      });
      return [...fused.values()]
        .sort(
          (a, b) =>
            b.fusedScore! - a.fusedScore! ||
            compareCodeUnits(a.path, b.path) ||
            a.ordinal - b.ordinal ||
            compareCodeUnits(a.id, b.id)
        )
        .slice(0, resultLimit);
    }
    const hydrated =
      "c.chunk_id AS id,n.path,n.content_id AS contentId,c.ordinal,c.start_line AS startLine,c.end_line AS endLine,c.body AS text";
    const channel = channels[0];
    const sql = `SELECT ${hydrated},e.score,e.score AS ${channel.includes("semantic") ? "semanticScore" : "lexicalScore"} FROM (${channel}) e JOIN chunks c ON c.chunk_pk=e.chunkPk JOIN notes n ON n.note_pk=c.note_pk ORDER BY e.score DESC,n.path COLLATE BINARY,c.ordinal,c.chunk_id COLLATE BINARY LIMIT ?`;
    binds.push(resultLimit);
    return rows(this.db, `WITH ${ctes.join(",")} ${sql}`, binds).map(hit);
  }
  findRelated(path: string, vector: Float32Array | undefined, limit: number): readonly SqliteHit[] {
    let q = vector;
    if (!q) {
      const rs = rows(
        this.db,
        "SELECT v.vector FROM chunk_vectors v JOIN chunks c ON c.chunk_pk=v.chunk_pk JOIN notes n ON n.note_pk=c.note_pk JOIN index_state s ON s.id=1 WHERE n.path=? AND v.embedding_fingerprint=s.embedding_fingerprint ORDER BY c.ordinal",
        [path]
      );
      if (!rs.length) return [];
      const sum = new Float64Array(this.dimensions);
      for (const r of rs) {
        const x = vectorOf(r.vector);
        if (x.length !== sum.length)
          throw sqliteError("integrity_failed", "Stored vector dimensions mismatch");
        for (let i = 0; i < x.length; i++) sum[i] += x[i];
      }
      let norm = 0;
      for (const x of sum) norm += x * x;
      if (!(norm > 0)) return [];
      q = new Float32Array(sum.length);
      for (let i = 0; i < q.length; i++) q[i] = sum[i] / Math.sqrt(norm);
    }
    return this.retrieve(undefined, q, limit, path, {
      semanticCandidateLimit: Math.min(128, Math.max(limit, 1)),
      resultShape: "notes",
    });
  }

  validateSnapshot(
    corpusFingerprint: string,
    dimensions: number,
    embeddingFingerprint = this.embeddingFingerprint,
    buildIdentity: string = SQLITE_BUILD_IDENTITY
  ): void {
    this.ensureOpen();
    this.dimensions = dimensions;
    this.embeddingFingerprint = embeddingFingerprint;
    const app = Number(rows(this.db, "PRAGMA application_id")[0]?.application_id ?? 0);
    const version = Number(rows(this.db, "PRAGMA user_version")[0]?.user_version ?? 0);
    const state = rows(this.db, "SELECT * FROM index_state WHERE id=1")[0];
    const required = rows(
      this.db,
      "SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') AND name IN ('index_state','notes','chunks','chunk_vectors','chunks_fts')"
    );
    if (
      app !== SQLITE_APPLICATION_ID ||
      version !== SQLITE_SCHEMA_VERSION ||
      required.length !== 5 ||
      !state ||
      Number(state.protocol_version) !== SQLITE_PROTOCOL_VERSION ||
      String(state.build_identity) !== buildIdentity ||
      Number(state.dimensions) !== dimensions ||
      String(state.corpus_fingerprint) !== corpusFingerprint ||
      (embeddingFingerprint !== "" &&
        String(state.embedding_fingerprint) !== embeddingFingerprint) ||
      ![0, 1].includes(Number(state.snapshot_loaded))
    )
      throw sqliteError("incompatible_state", "SQLite publication compatibility check failed");
    if (
      String(rows(this.db, "PRAGMA integrity_check")[0]?.integrity_check ?? "") !== "ok" ||
      rows(this.db, "PRAGMA foreign_key_check").length
    )
      throw sqliteError("integrity_failed", "SQLite publication integrity check failed");
    this.initializeVector();
    try {
      this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES ('integrity-check')");
    } catch {
      throw sqliteError("integrity_failed", "SQLite FTS integrity check failed");
    }
    const vectors = rows(
      this.db,
      "SELECT v.chunk_pk AS vectorChunkPk,v.content_id AS vectorContentId,v.chunk_id AS vectorChunkId,v.vector,c.chunk_pk AS chunkPk,c.content_id AS chunkContentId,c.chunk_id AS chunkId FROM chunk_vectors v LEFT JOIN chunks c ON c.chunk_pk=v.chunk_pk"
    );
    for (const row of vectors) {
      if (
        row.chunkPk == null ||
        String(row.vectorContentId) !== String(row.chunkContentId) ||
        String(row.vectorChunkId) !== String(row.chunkId)
      )
        throw sqliteError(
          "integrity_failed",
          "SQLite vector chunk/content identity does not match its chunk"
        );
      let vector: Float32Array;
      try {
        vector = vectorOf(row.vector);
      } catch {
        throw sqliteError("integrity_failed", "SQLite vector bytes are invalid");
      }
      if (vector.length !== dimensions || !vector.every(Number.isFinite))
        throw sqliteError("integrity_failed", "SQLite vector dimensions or values are invalid");
      let norm = 0;
      for (const value of vector) norm += value * value;
      if (
        !Number.isFinite(norm) ||
        !(norm > 0) ||
        Math.abs(norm - 1) > SQLITE_VECTOR_NORMALIZATION_TOLERANCE
      )
        throw sqliteError("integrity_failed", "SQLite vector is not normalized");
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
  finalizePublication(
    publicationId: string,
    expectedChangeCounter: number
  ): SqliteState | undefined {
    const s = this.getState();
    if (s.changeCounter !== expectedChangeCounter)
      throw sqliteError(
        "busy",
        "Publication is stale; local changes require a new publication.",
        true
      );
    transaction(this.db, () =>
      this.db.exec({
        sql: "UPDATE index_state SET publication_id=? WHERE id=1 AND change_counter=?",
        bind: [publicationId, expectedChangeCounter],
      })
    );
    return this.getState();
  }
  setPublicationId(publicationId: string): SqliteState {
    transaction(this.db, () =>
      this.db.exec({
        sql: "UPDATE index_state SET publication_id=? WHERE id=1",
        bind: [publicationId],
      })
    );
    return this.getState();
  }
  markSnapshotLoaded(): SqliteState {
    this.ensureOpen();
    transaction(this.db, () => this.db.exec("UPDATE index_state SET snapshot_loaded=1 WHERE id=1"));
    return this.getState();
  }
  private noteMatches(pk: number, note: SqliteNoteInput): boolean {
    const current = rows(
      this.db,
      "SELECT chunk_id,ordinal,start_line,end_line,body,content_id FROM chunks WHERE note_pk=? ORDER BY ordinal",
      [pk]
    );
    return (
      current.length === note.chunks.length &&
      current.every((r, i) => {
        const c = note.chunks[i];
        return (
          String(r.chunk_id) === c.id &&
          Number(r.ordinal) === c.ordinal &&
          Number(r.start_line) === c.startLine &&
          Number(r.end_line) === c.endLine &&
          String(r.body) === c.text &&
          String(r.content_id) === note.contentId
        );
      })
    );
  }
  private putVector(
    chunkId: string,
    contentId: string,
    vector: Float32Array,
    embeddingFingerprint: string,
    pkHint?: number
  ): void {
    const pk =
      pkHint ??
      Number(
        rows(this.db, "SELECT chunk_pk FROM chunks WHERE chunk_id=?", [chunkId])[0]?.chunk_pk ?? 0
      );
    if (!pk) return;
    const bytes = normalizedVector(vector, this.dimensions);
    this.db.exec({
      sql: "INSERT INTO chunk_vectors(chunk_pk,content_id,chunk_id,embedding_fingerprint,vector) VALUES(?,?,?,?,?) ON CONFLICT(chunk_pk) DO UPDATE SET content_id=excluded.content_id,chunk_id=excluded.chunk_id,embedding_fingerprint=excluded.embedding_fingerprint,vector=excluded.vector",
      bind: [pk, contentId, chunkId, embeddingFingerprint, bytes],
    });
  }
  private markMutation(incomplete = true): void {
    this.db.exec({
      sql: "UPDATE index_state SET incomplete=CASE WHEN ? THEN 1 ELSE incomplete END,change_counter=change_counter+1 WHERE id=1",
      bind: [incomplete ? 1 : 0],
    });
  }
  private initializeVector(): void {
    this.db.exec({
      sql: "SELECT vector_init('chunk_vectors','vector',?)",
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

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function safeFtsQuery(query: string): string {
  return [...new Set(literalTerms(query))]
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" AND ");
}
