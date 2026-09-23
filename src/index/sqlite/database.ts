import {
  SQLITE_MAX_RESULTS,
  type SqliteHit,
  type SqliteState,
  type SqliteMutationResult,
  type SqliteNoteSummary,
  type SqliteLexicalRevisionInput,
  type SqliteReconciliationPlan,
  type SqliteSemanticMutationResult,
  type SqliteLexicalBatchResult,
  type SqliteLexicalRunResult,
  type SqliteLexicalScope,
  type SqliteGenerationToken,
  type SqliteMutationReceipt,
  type SqliteEmbeddingResult,
  type SqliteSemanticWorkBatch,
  type SqliteSemanticCommitResult,
  SQLITE_MAX_SEMANTIC_BATCH_ITEMS,
  SQLITE_MAX_SEMANTIC_INPUT_BYTES,
  SQLITE_MAX_LEXICAL_BATCH_OCCURRENCES,
  SQLITE_MAX_LEXICAL_BATCH_NOTES,
  sqliteMutationReceipt,
  sqliteError,
} from "./protocol";
import {
  SQLITE_APPLICATION_ID,
  SQLITE_PROTOCOL_VERSION,
  SQLITE_SCHEMA_VERSION,
  schemaSql,
} from "./schema";
import { SQLITE_BUILD_IDENTITY } from "../../build/identity";
import { createEmbeddingActionKey, EMBEDDING_ACTION_OPTIONS } from "../Identity";

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
interface LexicalRunState {
  readonly runId: string;
  readonly expected?: readonly SqliteNoteSummary[];
  readonly renames: readonly { from: string; to: string; contentId: string }[];
  readonly deletes: SqliteNoteSummary[];
  readonly scoped: boolean;
  readonly mayClearIncomplete: boolean;
  changeCounter: number;
  renamesApplied: boolean;
}
interface LexicalRevisionApplyResult {
  readonly changed: number;
  readonly skipped: number;
  readonly occurrences: number;
  readonly renamed: number;
  readonly semanticChanged: number;
}
const EMBEDDING_PREPROCESSING_VERSION = "normalized-float32-v1";
function embeddingActionKey(
  inputDigest: string,
  fingerprint: string,
  preprocessing: string
): string {
  return createEmbeddingActionKey(
    inputDigest,
    fingerprint,
    preprocessing,
    EMBEDDING_ACTION_OPTIONS
  );
}
function withExpectedNotes<T>(
  db: SqliteConnection,
  summaries: readonly SqliteNoteSummary[],
  body: () => T
): T {
  db.exec(
    "CREATE TEMP TABLE reconciliation_expected(path TEXT PRIMARY KEY COLLATE BINARY, content_id TEXT NOT NULL, chunk_count INTEGER)"
  );
  try {
    db.exec({
      sql: "INSERT INTO reconciliation_expected(path,content_id,chunk_count) SELECT json_extract(value,'$.path'),json_extract(value,'$.contentId'),json_extract(value,'$.chunkCount') FROM json_each(?)",
      bind: [JSON.stringify(summaries)],
    });
    return body();
  } finally {
    db.exec("DROP TABLE reconciliation_expected");
  }
}
function normalizedVector(vector: Float32Array, dimensions: number): Float32Array {
  if (vector.length !== dimensions || !vector.every(Number.isFinite))
    throw sqliteError("invalid_request", "Vector dimensions or values are invalid");
  let norm = 0;
  for (const x of vector) norm += x * x;
  if (!(norm > 0) || !Number.isFinite(norm))
    throw sqliteError("invalid_request", "Vector must have non-zero magnitude");
  const out = new Float32Array(dimensions);
  const scale = 1 / Math.sqrt(norm);
  for (let i = 0; i < dimensions; i++) out[i] = vector[i] * scale;
  return out;
}
function vectorBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength)
  );
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
/** SQLite statements and invariants for one mutable, eventually-consistent index. */
export class MutableSqliteDatabase {
  private dimensions = 0;
  private embeddingFingerprint = "";
  private closed = false;
  private lexicalRunSequence = 0;
  /** Worker-owned operation state; no lexical staging is persisted in SQLite. */
  private readonly lexicalRuns = new Map<string, LexicalRunState>();
  constructor(private readonly db: SqliteConnection) {}

  /** Lexical runs live only in this worker instance and are the maintenance fence. */
  hasActiveLexicalRuns(): boolean {
    return this.lexicalRuns.size > 0;
  }

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
      const existing = Number(
        rows(
          this.db,
          "SELECT count(*) AS count FROM sqlite_master WHERE name IN ('index_state','notes','note_revisions','embedding_inputs','chunk_occurrences','embedding_cache')"
        )[0]?.count ?? 0
      );
      if (existing) throw sqliteError("integrity_failed", "SQLite database metadata is corrupt");
      this.db.exec(schemaSql(dimensions));
      transaction(this.db, () =>
        this.db.exec({
          sql: "INSERT INTO index_state(id,app_version,schema_version,protocol_version,build_identity,extraction_version,chunk_algorithm_version,embedding_input_version,dimensions,corpus_fingerprint,embedding_fingerprint,incomplete,change_counter,snapshot_loaded) VALUES(1,?,?,?,?,?,?,?,?,?, ?,1,0,0)",
          bind: [
            APP_VERSION,
            SQLITE_SCHEMA_VERSION,
            SQLITE_PROTOCOL_VERSION,
            buildIdentity,
            EXTRACTION_VERSION,
            CHUNK_ALGORITHM_VERSION,
            1,
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
          "SQLite database schema/build is incompatible (expected schema 8).",
          false
        );
      this.assertSchemaLayout();
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
    return this.getState();
  }
  private assertSchemaLayout(): void {
    const required: Record<string, readonly string[]> = {
      index_state: [
        "id",
        "app_version",
        "schema_version",
        "protocol_version",
        "build_identity",
        "extraction_version",
        "chunk_algorithm_version",
        "embedding_input_version",
        "dimensions",
        "corpus_fingerprint",
        "embedding_fingerprint",
        "incomplete",
        "change_counter",
        "lexical_generation",
        "semantic_generation",
        "lexical_revision_count",
        "semantic_revision_count",
        "embedding_input_count",
        "publication_id",
        "snapshot_loaded",
        "reconciliation_summary",
      ],
      notes: [
        "note_pk",
        "note_id",
        "path",
        "content_id",
        "lexical_revision_id",
        "semantic_revision_id",
      ],
      note_revisions: [
        "revision_id",
        "note_id",
        "content_id",
        "extraction_version",
        "chunk_algorithm_version",
        "created_change_counter",
      ],
      chunk_occurrences: [
        "occurrence_id",
        "revision_id",
        "note_id",
        "chunk_id",
        "ordinal",
        "kind",
        "start_line",
        "end_line",
        "display_text",
        "heading_context",
        "embedding_input",
        "embedding_input_digest",
        "body",
      ],
      embedding_inputs: [
        "input_id",
        "embedding_fingerprint",
        "serialized_input",
        "preprocessing",
        "action_key",
      ],
      embedding_cache: [
        "cache_id",
        "input_digest",
        "action_key",
        "embedding_fingerprint",
        "preprocessing",
        "vector",
      ],
      active_lexical: ["occurrence_id", "note_id", "revision_id", "path_text", "filename", "body"],
      active_lexical_fts: ["body", "path_text", "filename"],
    };
    for (const [table, columns] of Object.entries(required)) {
      const object = rows(this.db, "SELECT type FROM sqlite_master WHERE name=?", [table])[0];
      if (!object || object.type !== "table")
        throw sqliteError("incompatible_state", "SQLite schema layout is incompatible", false);
      const actual = new Set(
        rows(this.db, `PRAGMA table_info(${table})`).map((row) => String(row.name))
      );
      if (columns.some((column) => !actual.has(column)))
        throw sqliteError("incompatible_state", "SQLite schema layout is incompatible", false);
    }
    const ftsSql = String(
      rows(this.db, "SELECT sql FROM sqlite_master WHERE name='active_lexical_fts'")[0]?.sql ?? ""
    ).toLowerCase();
    if (
      !ftsSql.includes("using fts5") ||
      !ftsSql.includes("content='active_lexical'") ||
      !ftsSql.includes("content_rowid='occurrence_id'") ||
      !ftsSql.includes("tokenize='unicode61 remove_diacritics 2'")
    )
      throw sqliteError("incompatible_state", "SQLite FTS layout is incompatible", false);
    const indexes: Record<string, { table: string; columns: readonly string[] }> = {
      notes_content_id: { table: "notes", columns: ["content_id"] },
      note_revisions_note: { table: "note_revisions", columns: ["note_id", "revision_id"] },
      chunk_occurrences_note: {
        table: "chunk_occurrences",
        columns: ["note_id", "revision_id", "ordinal"],
      },
      chunk_occurrences_embedding_input: {
        table: "chunk_occurrences",
        columns: ["embedding_input_digest", "note_id", "revision_id"],
      },
      embedding_inputs_fingerprint: {
        table: "embedding_inputs",
        columns: ["embedding_fingerprint"],
      },
      embedding_cache_fingerprint: { table: "embedding_cache", columns: ["embedding_fingerprint"] },
      embedding_cache_lookup: {
        table: "embedding_cache",
        columns: ["input_digest", "embedding_fingerprint", "preprocessing"],
      },
      active_lexical_note: { table: "active_lexical", columns: ["note_id", "revision_id"] },
    };
    for (const [name, expected] of Object.entries(indexes)) {
      const entry = rows(this.db, `PRAGMA index_list(${expected.table})`).find(
        (row) => String(row.name) === name
      );
      const columns = entry
        ? rows(this.db, `PRAGMA index_info(${name})`).map((row) => String(row.name))
        : [];
      if (
        !entry ||
        Number(entry.unique) !== 0 ||
        Number(entry.partial) !== 0 ||
        columns.join("\0") !== expected.columns.join("\0")
      )
        throw sqliteError("incompatible_state", "SQLite schema indexes are incompatible", false);
    }
  }
  getState(): SqliteState {
    this.ensureOpen();
    const s = rows(this.db, "SELECT * FROM index_state WHERE id=1")[0];
    if (!s) throw sqliteError("incompatible_state", "SQLite state is not initialized");
    const c = rows(
      this.db,
      `SELECT (SELECT count(*) FROM notes WHERE lexical_revision_id IS NOT NULL) AS notes,
              (SELECT count(*) FROM chunk_occurrences o JOIN notes n ON n.note_id=o.note_id AND n.lexical_revision_id=o.revision_id) AS chunks,
              (SELECT count(*) FROM embedding_cache WHERE embedding_fingerprint=?) AS vectors`,
      [String(s.embedding_fingerprint)]
    )[0];
    const heads = rows(
      this.db,
      `SELECT count(*) AS eligible,
              sum(CASE WHEN n.semantic_revision_id IS NOT NULL THEN 1 ELSE 0 END) AS semanticHeads,
              sum(CASE WHEN n.semantic_revision_id=n.lexical_revision_id THEN 1 ELSE 0 END) AS currentSemanticHeads,
              sum(CASE WHEN EXISTS (SELECT 1 FROM chunk_occurrences eo WHERE eo.note_id=n.note_id AND eo.revision_id=n.lexical_revision_id) THEN 1 ELSE 0 END) AS nonempty,
              sum(CASE WHEN n.semantic_revision_id=n.lexical_revision_id THEN 0 ELSE 1 END) AS lagging
       FROM notes n WHERE n.lexical_revision_id IS NOT NULL`
    )[0];
    const missing = rows(
      this.db,
      `SELECT count(DISTINCT ei.action_key) AS missing
       FROM chunk_occurrences o
       JOIN notes n ON n.note_id=o.note_id AND n.lexical_revision_id=o.revision_id
       JOIN embedding_inputs ei ON ei.action_key=o.embedding_input_digest
       LEFT JOIN embedding_cache ec ON ec.input_digest=ei.action_key AND ec.embedding_fingerprint=? AND ec.preprocessing=?
       WHERE ec.cache_id IS NULL`,
      [String(s.embedding_fingerprint), EMBEDDING_PREPROCESSING_VERSION]
    )[0];
    const revisionMode =
      Number(heads.eligible ?? 0) > 0 ||
      Number(rows(this.db, "SELECT count(*) AS count FROM active_lexical")[0]?.count ?? 0) > 0;
    const chunks = Number(c.chunks);
    const compatible = Number(c.vectors);
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
      lexicalGeneration: Number(s.lexical_generation),
      semanticGeneration: Number(s.semantic_generation),
      noteCount: Number(c.notes),
      chunkCount: chunks,
      compatibleVectorCount: compatible,
      vectorCount: Number(c.vectors),
      vectorCoverage: coverage,
      semanticReady: revisionMode
        ? Number(heads.eligible ?? 0) > 0 &&
          Number(heads.eligible ?? 0) === Number(heads.semanticHeads ?? 0) &&
          Number(heads.eligible ?? 0) === Number(heads.currentSemanticHeads ?? 0) &&
          Number(heads.nonempty ?? 0) > 0 &&
          Number(missing.missing ?? 0) === 0 &&
          !Number(s.incomplete)
        : coverage === "complete" && !Number(s.incomplete),
      ...(revisionMode
        ? {
            semanticEligibleCount: Number(heads.eligible ?? 0),
            semanticHeadCount: Number(heads.semanticHeads ?? 0),
            semanticLagCount: Number(heads.lagging ?? 0),
            semanticMissingCount: Number(missing.missing ?? 0),
          }
        : {}),
      ...(s.publication_id == null ? {} : { publicationId: String(s.publication_id) }),
    };
  }
  /** Read the immutable corpus identity without calculating index status. */
  getCorpusFingerprint(): string {
    this.ensureOpen();
    const row = rows(this.db, "SELECT corpus_fingerprint FROM index_state WHERE id=1")[0];
    if (!row) throw sqliteError("incompatible_state", "SQLite state is not initialized");
    return String(row.corpus_fingerprint);
  }
  /** Validate active head ownership without changing any rows. */
  validatePointerOwnership(): void {
    this.ensureOpen();
    const invalid = rows(
      this.db,
      `SELECT n.note_id FROM notes n
       LEFT JOIN note_revisions lr ON lr.revision_id=n.lexical_revision_id
       LEFT JOIN note_revisions sr ON sr.revision_id=n.semantic_revision_id
       WHERE (n.lexical_revision_id IS NOT NULL AND (lr.revision_id IS NULL OR lr.note_id<>n.note_id))
          OR (n.semantic_revision_id IS NOT NULL AND (sr.revision_id IS NULL OR sr.note_id<>n.note_id))
       LIMIT 1`
    );
    if (invalid.length || rows(this.db, "PRAGMA foreign_key_check").length)
      throw sqliteError("integrity_failed", "SQLite active revision pointer ownership failed");

    const ftsMismatch = rows(
      this.db,
      `SELECT 1 FROM active_lexical a
       LEFT JOIN active_lexical_fts f ON f.rowid=a.occurrence_id
       WHERE f.rowid IS NULL OR f.body<>a.body OR f.path_text<>a.path_text OR f.filename<>a.filename
       UNION ALL
       SELECT 1 FROM active_lexical_fts f
       LEFT JOIN active_lexical a ON a.occurrence_id=f.rowid
       WHERE a.occurrence_id IS NULL
       LIMIT 1`
    );
    if (ftsMismatch.length)
      throw sqliteError("integrity_failed", "SQLite active lexical FTS materialization is stale");

    this.db.exec({
      sql: `SELECT ec.vector,ec.action_key,ec.embedding_fingerprint,ec.preprocessing,
                   ei.action_key AS input_action_key
            FROM notes n
            JOIN chunk_occurrences o ON o.revision_id=n.semantic_revision_id AND o.note_id=n.note_id
            JOIN embedding_inputs ei ON ei.action_key=o.embedding_input_digest
            LEFT JOIN embedding_cache ec
              ON ec.input_digest=ei.action_key
             AND ec.embedding_fingerprint=? AND ec.preprocessing=?
            WHERE ec.cache_id IS NULL`,
      bind: [this.embeddingFingerprint, EMBEDDING_PREPROCESSING_VERSION],
      rowMode: "object",
      callback: () => {
        throw sqliteError("integrity_failed", "SQLite semantic head cache coverage is incomplete");
      },
    });
    this.db.exec({
      sql: `SELECT vector FROM embedding_cache WHERE embedding_fingerprint=?`,
      bind: [this.embeddingFingerprint],
      rowMode: "object",
      callback: (row) => {
        let vector: Float32Array;
        try {
          vector = vectorOf(row.vector);
        } catch {
          throw sqliteError("integrity_failed", "SQLite cached vector bytes are invalid");
        }
        if (vector.length !== this.dimensions || !vector.every(Number.isFinite))
          throw sqliteError("integrity_failed", "SQLite cached vector dimensions are invalid");
        let norm = 0;
        for (const value of vector) norm += value * value;
        if (
          !Number.isFinite(norm) ||
          !(norm > 0) ||
          Math.abs(norm - 1) > SQLITE_VECTOR_NORMALIZATION_TOLERANCE
        )
          throw sqliteError("integrity_failed", "SQLite cached vector is not normalized");
      },
    });
  }

  /** Remove obsolete revision material and cache rows from a publication copy. */
  pruneForPublication(): void {
    this.ensureOpen();
    transaction(this.db, () => {
      this.db.exec({
        sql: `DELETE FROM note_revisions
              WHERE revision_id NOT IN (
                SELECT lexical_revision_id FROM notes WHERE lexical_revision_id IS NOT NULL
                UNION SELECT semantic_revision_id FROM notes WHERE semantic_revision_id IS NOT NULL
              )`,
      });
      this.db.exec({
        sql: `DELETE FROM embedding_inputs
              WHERE NOT EXISTS (SELECT 1 FROM chunk_occurrences o WHERE o.embedding_input_digest=embedding_inputs.action_key)`,
      });
      this.db.exec({
        sql: `DELETE FROM embedding_cache
              WHERE NOT EXISTS (
                SELECT 1
                FROM notes n
                JOIN chunk_occurrences o ON o.revision_id=n.semantic_revision_id AND o.note_id=n.note_id
                JOIN embedding_inputs ei ON ei.action_key=o.embedding_input_digest
                WHERE embedding_cache.embedding_fingerprint=?
                  AND embedding_cache.input_digest=ei.action_key
                  AND embedding_cache.preprocessing=?
              )`,
        bind: [this.embeddingFingerprint, EMBEDDING_PREPROCESSING_VERSION],
      });
      this.db.exec(
        "UPDATE index_state SET lexical_revision_count=(SELECT count(*) FROM notes WHERE lexical_revision_id IS NOT NULL),semantic_revision_count=(SELECT count(*) FROM notes WHERE semantic_revision_id IS NOT NULL),embedding_input_count=(SELECT count(*) FROM embedding_inputs) WHERE id=1"
      );
    });
  }
  planReconciliation(summaries: readonly SqliteNoteSummary[]): SqliteReconciliationPlan {
    this.ensureOpen();
    const planned = withExpectedNotes(this.db, summaries, () =>
      rows(
        this.db,
        `WITH missing AS MATERIALIZED (
         SELECT n.path,n.content_id FROM notes n LEFT JOIN reconciliation_expected e ON e.path=n.path WHERE e.path IS NULL
       ), added AS MATERIALIZED (
         SELECT e.path,e.content_id FROM reconciliation_expected e LEFT JOIN notes n ON n.path=e.path WHERE n.path IS NULL
       ), old_ranked AS MATERIALIZED (
         SELECT *,ROW_NUMBER() OVER(PARTITION BY content_id ORDER BY path COLLATE BINARY) AS rank FROM missing
       ), new_ranked AS MATERIALIZED (
         SELECT *,ROW_NUMBER() OVER(PARTITION BY content_id ORDER BY path COLLATE BINARY) AS rank FROM added
       ), renames AS MATERIALIZED (
         SELECT o.path,n.path AS target,o.content_id FROM old_ranked o JOIN new_ranked n
           ON n.content_id=o.content_id AND n.rank=o.rank
       ), upserts AS MATERIALIZED (
         SELECT e.path,NULL AS target,e.content_id FROM reconciliation_expected e LEFT JOIN notes n ON n.path=e.path
          WHERE (n.path IS NULL OR n.content_id<>e.content_id)
            AND NOT EXISTS(SELECT 1 FROM renames r WHERE r.target=e.path)
       ), deletes AS MATERIALIZED (
         SELECT m.path,NULL AS target,m.content_id FROM missing m
          WHERE NOT EXISTS(SELECT 1 FROM renames r WHERE r.path=m.path)
       )
       SELECT 'rename' AS kind,path,target,content_id AS contentId FROM renames
       UNION ALL SELECT 'upsert',path,target,content_id FROM upserts
       UNION ALL SELECT 'delete',path,target,content_id FROM deletes
       ORDER BY kind COLLATE BINARY,path COLLATE BINARY`
      )
    );
    return {
      renames: planned
        .filter((r) => r.kind === "rename")
        .map((r) => ({
          from: String(r.path),
          to: String(r.target),
          contentId: String(r.contentId),
        })),
      upserts: planned
        .filter((r) => r.kind === "upsert")
        .map((r) => ({
          path: String(r.path),
          contentId: String(r.contentId),
        })),
      deletes: planned
        .filter((r) => r.kind === "delete")
        .map((r) => ({
          path: String(r.path),
          contentId: String(r.contentId),
        })),
      state: planned.length ? this.markIncomplete() : this.getState(),
    };
  }
  markIncomplete(): SqliteState {
    this.ensureOpen();
    if (!this.readStateFlag("incomplete"))
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

  /** Activate one immutable Markdown revision and its lexical occurrences atomically. */
  upsertLexicalRevision(input: SqliteLexicalRevisionInput): SqliteMutationResult {
    this.ensureOpen();
    if (input.blocks.length > SQLITE_MAX_LEXICAL_BATCH_OCCURRENCES) {
      const runId = `legacy-${++this.lexicalRunSequence}`;
      this.lexicalRuns.set(runId, {
        runId,
        expected: undefined,
        renames: [],
        deletes: [],
        scoped: false,
        mayClearIncomplete: true,
        changeCounter: this.readChangeCounter(),
        renamesApplied: true,
      });
      try {
        const result = this.stageLexicalRevision(runId, input);
        this.lexicalRuns.delete(runId);
        const state = this.getState();
        return {
          changed: result.changed,
          status: result.changed ? "changed" : "unchanged",
          state,
          receipt: result.receipt,
        };
      } catch (error) {
        this.lexicalRuns.delete(runId);
        throw error;
      }
    }
    const note = rows(this.db, "SELECT note_id,lexical_revision_id FROM notes WHERE path=?", [
      input.path,
    ])[0];
    if (note && note.lexical_revision_id != null) {
      const current = rows(this.db, "SELECT content_id FROM note_revisions WHERE revision_id=?", [
        note.lexical_revision_id,
      ])[0];
      if (current && String(current.content_id) === input.revisionDigest) {
        const state = this.getState();
        return {
          changed: false,
          status: "unchanged" as const,
          state,
          receipt: sqliteMutationReceipt(state, false, "unchanged"),
        };
      }
    }
    transaction(this.db, () => {
      let noteId: number;
      if (note) noteId = Number(note.note_id);
      else {
        this.db.exec({
          sql: "INSERT INTO notes(note_id,path,content_id) SELECT COALESCE(MAX(note_id),0)+1,?,? FROM notes",
          bind: [input.path, input.revisionDigest],
        });
        noteId = Number(
          rows(this.db, "SELECT note_id FROM notes WHERE path=?", [input.path])[0].note_id
        );
      }
      const prior =
        note?.lexical_revision_id == null ? undefined : Number(note.lexical_revision_id);
      let revisionId = Number(
        rows(
          this.db,
          "SELECT revision_id FROM note_revisions WHERE note_id=? AND content_id=? AND extraction_version=? AND chunk_algorithm_version=?",
          [noteId, input.revisionDigest, EXTRACTION_VERSION, CHUNK_ALGORITHM_VERSION]
        )[0]?.revision_id ?? 0
      );
      if (!revisionId) {
        this.db.exec({
          sql: "INSERT INTO note_revisions(note_id,content_id,extraction_version,chunk_algorithm_version,created_change_counter) VALUES(?,?,?,?,(SELECT change_counter+1 FROM index_state WHERE id=1))",
          bind: [noteId, input.revisionDigest, EXTRACTION_VERSION, CHUNK_ALGORITHM_VERSION],
        });
        revisionId = Number(rows(this.db, "SELECT last_insert_rowid() AS id")[0].id);
        for (const block of input.blocks) {
          this.db.exec({
            sql: "INSERT INTO chunk_occurrences(revision_id,note_id,chunk_id,ordinal,kind,start_line,end_line,display_text,heading_context,embedding_input,embedding_input_digest,body) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            bind: [
              revisionId,
              noteId,
              `${input.revisionDigest}:${block.ordinal}`,
              block.ordinal,
              block.kind,
              block.startLine,
              block.endLine,
              block.displayText,
              JSON.stringify(block.headingContext),
              block.embeddingInput,
              block.embeddingInputDigest,
              block.displayText,
            ],
          });
          this.db.exec({
            sql: "INSERT INTO embedding_inputs(embedding_fingerprint,serialized_input,preprocessing,action_key) VALUES(?,?,?,?) ON CONFLICT(action_key) DO NOTHING",
            bind: ["input-v1", block.embeddingInput, "serialized-v1", block.embeddingInputDigest],
          });
        }
      }
      if (prior && prior !== revisionId) {
        for (const item of rows(
          this.db,
          "SELECT occurrence_id,body,path_text,filename FROM active_lexical WHERE note_id=?",
          [noteId]
        ))
          this.db.exec({
            sql: "INSERT INTO active_lexical_fts(active_lexical_fts,rowid,body,path_text,filename) VALUES('delete',?,?,?,?)",
            bind: [item.occurrence_id, item.body, item.path_text, item.filename],
          });
        this.db.exec({
          sql: "DELETE FROM active_lexical WHERE revision_id=? AND note_id=?",
          bind: [prior, noteId],
        });
      }
      const filename = input.path.slice(input.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
      this.db.exec({
        sql: "INSERT INTO active_lexical(occurrence_id,note_id,revision_id,path_text,filename,body) SELECT occurrence_id,note_id,revision_id,?, ?,display_text FROM chunk_occurrences WHERE revision_id=? ON CONFLICT(occurrence_id) DO UPDATE SET path_text=excluded.path_text,filename=excluded.filename,body=excluded.body",
        bind: [input.path, filename, revisionId],
      });
      for (const occurrence of rows(
        this.db,
        "SELECT occurrence_id,display_text FROM chunk_occurrences WHERE revision_id=?",
        [revisionId]
      )) {
        this.db.exec({
          sql: "INSERT INTO active_lexical_fts(rowid,body,path_text,filename) VALUES(?,?,?,?)",
          bind: [occurrence.occurrence_id, occurrence.display_text, input.path, filename],
        });
      }
      this.db.exec({
        sql: "UPDATE notes SET lexical_revision_id=?,content_id=? WHERE note_id=?",
        bind: [revisionId, input.revisionDigest, noteId],
      });
      this.db.exec(
        "UPDATE index_state SET incomplete=1,lexical_generation=lexical_generation+1,lexical_revision_count=(SELECT count(*) FROM notes WHERE lexical_revision_id IS NOT NULL),embedding_input_count=(SELECT count(*) FROM embedding_inputs),change_counter=change_counter+1 WHERE id=1"
      );
    });
    const state = this.getState();
    return {
      changed: true,
      status: "changed",
      state,
      receipt: sqliteMutationReceipt(state, true, "changed"),
    };
  }

  /** Return the active digest without loading or parsing the Markdown body. */
  getLexicalRevisionDigest(path: string): string | undefined {
    this.ensureOpen();
    const row = rows(
      this.db,
      `SELECT r.content_id AS contentId
       FROM notes n LEFT JOIN note_revisions r ON r.revision_id=n.lexical_revision_id
       WHERE n.path=?`,
      [path]
    )[0];
    return row?.contentId == null ? undefined : String(row.contentId);
  }

  /**
   * Start a bounded lexical operation. The manifest is held in Worker memory;
   * SQLite receives only committed revisions and the final deletion drain.
   */
  beginLexicalRun(
    options: {
      readonly runId?: string;
      readonly summaries?: readonly SqliteNoteSummary[];
      readonly expectedChangeCounter?: number;
      readonly scope?: SqliteLexicalScope;
    } = {}
  ): {
    readonly runId: string;
    readonly state: SqliteState;
    readonly receipt: SqliteMutationReceipt;
    readonly plan?: SqliteReconciliationPlan;
  } {
    this.ensureOpen();
    const current = this.readChangeCounter();
    if (options.expectedChangeCounter !== undefined && options.expectedChangeCounter !== current)
      throw sqliteError("busy", "Lexical run generation is stale", true);
    const runId = options.runId ?? `lexical-${++this.lexicalRunSequence}`;
    if (this.lexicalRuns.has(runId))
      throw sqliteError("invalid_request", "Lexical run is already active");
    const plan =
      options.scope || options.summaries === undefined
        ? undefined
        : this.planReconciliation(options.summaries);
    const plannedState = plan?.state;
    // A scoped run keeps a previously complete index complete until a touched
    // row actually changes. Full runs mark the index incomplete up front so a
    // cancellation cannot publish a partial manifest as complete.
    const state = options.scope
      ? this.getState()
      : plannedState && plannedState.incomplete
        ? plannedState
        : this.markIncomplete();
    const scopedRenames = options.scope?.renames?.map((rename) => ({
      from: rename.from,
      to: rename.to,
      contentId: "",
    }));
    const scopedDeletes = options.scope?.deletes?.map((path) => ({ path, contentId: "" }));
    this.lexicalRuns.set(runId, {
      runId,
      expected: options.scope ? undefined : options.summaries,
      renames: scopedRenames ?? plan?.renames ?? [],
      deletes: [...(scopedDeletes ?? plan?.deletes ?? [])],
      scoped: options.scope !== undefined,
      mayClearIncomplete: options.scope?.mayClearIncomplete ?? true,
      changeCounter: state.changeCounter,
      renamesApplied: false,
    });
    return {
      runId,
      state,
      receipt: sqliteMutationReceipt(state, false, "unchanged"),
      ...(plan ? { plan } : {}),
    };
  }

  /** Apply one bounded set of already hashed and parsed revisions atomically. */
  applyLexicalBatch(
    runId: string,
    inputs: readonly SqliteLexicalRevisionInput[]
  ): SqliteLexicalBatchResult {
    this.ensureOpen();
    const run = this.lexicalRuns.get(runId);
    if (!run) throw sqliteError("invalid_request", "Lexical run is not active");
    if (this.readChangeCounter() !== run.changeCounter)
      throw sqliteError("busy", "Lexical run generation is stale", true);
    if (inputs.length > SQLITE_MAX_LEXICAL_BATCH_NOTES)
      throw sqliteError("invalid_request", "Lexical batch is too large");
    const paths = new Set<string>();
    let occurrences = 0;
    for (const input of inputs) {
      if (paths.has(input.path))
        throw sqliteError("invalid_request", "Lexical batch contains duplicate paths");
      paths.add(input.path);
      occurrences += input.blocks.length;
      if (occurrences > SQLITE_MAX_LEXICAL_BATCH_OCCURRENCES)
        throw sqliteError("invalid_request", "Lexical batch has too many occurrences");
    }
    let changed = 0;
    let skipped = 0;
    let changedOccurrences = 0;
    let renamed = 0;
    let semanticChanged = 0;
    // This TEMP table is operation-local and is dropped after the transaction.
    this.db.exec(
      "CREATE TEMP TABLE lexical_batch_notes(note_id INTEGER PRIMARY KEY,revision_id INTEGER NOT NULL,path_text TEXT NOT NULL,filename TEXT NOT NULL)"
    );
    try {
      transaction(this.db, () => {
        if (!run.renamesApplied) {
          const result = this.applyRunRenamesInTransaction(run.renames);
          renamed = result.changed;
          semanticChanged += result.semanticChanged;
        }
        for (const input of inputs) {
          const note = rows(
            this.db,
            "SELECT note_id,lexical_revision_id,semantic_revision_id FROM notes WHERE path=?",
            [input.path]
          )[0];
          const priorRevision =
            note?.lexical_revision_id == null ? undefined : Number(note.lexical_revision_id);
          if (priorRevision !== undefined) {
            const current = rows(
              this.db,
              "SELECT content_id FROM note_revisions WHERE revision_id=?",
              [priorRevision]
            )[0];
            if (current && String(current.content_id) === input.revisionDigest) {
              skipped++;
              continue;
            }
          }
          let noteId: number;
          if (note) noteId = Number(note.note_id);
          else {
            this.db.exec({
              sql: "INSERT INTO notes(note_id,path,content_id) SELECT COALESCE(MAX(note_id),0)+1,?,? FROM notes",
              bind: [input.path, input.revisionDigest],
            });
            noteId = Number(
              rows(this.db, "SELECT note_id FROM notes WHERE path=?", [input.path])[0].note_id
            );
          }
          let revisionId = Number(
            rows(
              this.db,
              "SELECT revision_id FROM note_revisions WHERE note_id=? AND content_id=? AND extraction_version=? AND chunk_algorithm_version=?",
              [noteId, input.revisionDigest, EXTRACTION_VERSION, CHUNK_ALGORITHM_VERSION]
            )[0]?.revision_id ?? 0
          );
          if (!revisionId) {
            this.db.exec({
              sql: "INSERT INTO note_revisions(note_id,content_id,extraction_version,chunk_algorithm_version,created_change_counter) VALUES(?,?,?,?,(SELECT change_counter+1 FROM index_state WHERE id=1))",
              bind: [noteId, input.revisionDigest, EXTRACTION_VERSION, CHUNK_ALGORITHM_VERSION],
            });
            revisionId = Number(rows(this.db, "SELECT last_insert_rowid() AS id")[0].id);
            for (const block of input.blocks) {
              this.db.exec({
                sql: "INSERT INTO chunk_occurrences(revision_id,note_id,chunk_id,ordinal,kind,start_line,end_line,display_text,heading_context,embedding_input,embedding_input_digest,body) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                bind: [
                  revisionId,
                  noteId,
                  `${input.revisionDigest}:${block.ordinal}`,
                  block.ordinal,
                  block.kind,
                  block.startLine,
                  block.endLine,
                  block.displayText,
                  JSON.stringify(block.headingContext),
                  block.embeddingInput,
                  block.embeddingInputDigest,
                  block.displayText,
                ],
              });
              this.db.exec({
                sql: "INSERT INTO embedding_inputs(embedding_fingerprint,serialized_input,preprocessing,action_key) VALUES(?,?,?,?) ON CONFLICT(action_key) DO NOTHING",
                bind: [
                  "input-v1",
                  block.embeddingInput,
                  "serialized-v1",
                  block.embeddingInputDigest,
                ],
              });
            }
          }
          this.db.exec({
            sql: "INSERT INTO lexical_batch_notes(note_id,revision_id,path_text,filename) VALUES(?,?,?,?)",
            bind: [
              noteId,
              revisionId,
              input.path,
              input.path.slice(input.path.lastIndexOf("/") + 1).replace(/\.md$/i, ""),
            ],
          });
          changed++;
          changedOccurrences += input.blocks.length;
          if (note?.semantic_revision_id != null) semanticChanged++;
        }
        if (changed || renamed) {
          this.db.exec({
            sql: `INSERT INTO active_lexical_fts(active_lexical_fts,rowid,body,path_text,filename)
                  SELECT 'delete',a.occurrence_id,a.body,a.path_text,a.filename
                  FROM active_lexical a JOIN lexical_batch_notes b ON b.note_id=a.note_id`,
          });
          this.db.exec({
            sql: "DELETE FROM active_lexical WHERE note_id IN (SELECT note_id FROM lexical_batch_notes)",
          });
          this.db.exec({
            sql: `INSERT INTO active_lexical(occurrence_id,note_id,revision_id,path_text,filename,body)
                  SELECT o.occurrence_id,o.note_id,o.revision_id,b.path_text,b.filename,o.display_text
                  FROM chunk_occurrences o JOIN lexical_batch_notes b
                    ON b.note_id=o.note_id AND b.revision_id=o.revision_id`,
          });
          this.db.exec({
            sql: `INSERT INTO active_lexical_fts(rowid,body,path_text,filename)
                  SELECT a.occurrence_id,a.body,a.path_text,a.filename
                  FROM active_lexical a JOIN lexical_batch_notes b ON b.note_id=a.note_id`,
          });
          this.db.exec({
            sql: `UPDATE notes
                  SET lexical_revision_id=(SELECT revision_id FROM lexical_batch_notes b WHERE b.note_id=notes.note_id),
                      content_id=(SELECT r.content_id FROM note_revisions r JOIN lexical_batch_notes b ON b.revision_id=r.revision_id WHERE b.note_id=notes.note_id)
                  WHERE note_id IN (SELECT note_id FROM lexical_batch_notes)`,
          });
          this.db.exec({
            sql: `UPDATE index_state
                  SET incomplete=1,
                      lexical_generation=lexical_generation+1,
                      semantic_generation=semantic_generation+CASE WHEN ? > 0 THEN 1 ELSE 0 END,
                      lexical_revision_count=(SELECT count(*) FROM notes WHERE lexical_revision_id IS NOT NULL),
                      embedding_input_count=(SELECT count(*) FROM embedding_inputs),
                      change_counter=change_counter+1
                  WHERE id=1`,
            bind: [semanticChanged],
          });
        }
      });
      run.renamesApplied = true;
      run.changeCounter = this.readChangeCounter();
    } finally {
      try {
        this.db.exec("DROP TABLE IF EXISTS lexical_batch_notes");
      } catch {
        /* preserve the transaction result */
      }
    }
    const generation = this.readGenerationToken();
    const changedTotal = changed + renamed;
    return {
      runId,
      changed: changedTotal > 0,
      applied: changed,
      changedCount: changedTotal,
      skipped,
      occurrences: changedOccurrences,
      receipt: {
        changed: changedTotal > 0,
        status: changedTotal > 0 ? "changed" : "unchanged",
        generation,
      },
    };
  }

  /**
   * Stage a single revision whose occurrence count exceeds the relational
   * slice bound. TEMP rows are appended in bounded transactions and remain
   * invisible to durable heads, FTS, counters, and generations until the
   * final promotion transaction succeeds.
   */
  stageLexicalRevision(
    runId: string,
    input: SqliteLexicalRevisionInput,
    signal?: AbortSignal
  ): SqliteLexicalBatchResult {
    this.ensureOpen();
    const run = this.lexicalRuns.get(runId);
    if (!run) throw sqliteError("invalid_request", "Lexical run is not active");
    if (this.readChangeCounter() !== run.changeCounter)
      throw sqliteError("busy", "Lexical run generation is stale", true);
    const note = rows(
      this.db,
      `SELECT n.note_id,r.content_id
       FROM notes n LEFT JOIN note_revisions r ON r.revision_id=n.lexical_revision_id
       WHERE n.path=?`,
      [input.path]
    )[0];
    if (note && String(note.content_id ?? "") === input.revisionDigest) {
      return {
        runId,
        changed: false,
        applied: 0,
        changedCount: 0,
        skipped: 1,
        occurrences: 0,
        receipt: sqliteMutationReceipt(this.getState(), false, "unchanged"),
      };
    }
    if (input.blocks.length <= SQLITE_MAX_LEXICAL_BATCH_OCCURRENCES)
      throw sqliteError("invalid_request", "Staged lexical revision is not oversized");

    try {
      this.ensureLexicalStageTables();
      transaction(this.db, () => {
        const existing = rows(
          this.db,
          "SELECT revision_digest,expected_count FROM lexical_stage_notes WHERE run_id=? AND path_text=?",
          [runId, input.path]
        )[0];
        if (existing) {
          if (
            String(existing.revision_digest) !== input.revisionDigest ||
            Number(existing.expected_count) !== input.blocks.length
          )
            throw sqliteError("busy", "A different lexical revision is already staged", true);
        } else {
          this.db.exec({
            sql: "INSERT INTO lexical_stage_notes(run_id,path_text,revision_digest,expected_count) VALUES(?,?,?,?)",
            bind: [runId, input.path, input.revisionDigest, input.blocks.length],
          });
        }
      });
      for (
        let offset = 0;
        offset < input.blocks.length;
        offset += SQLITE_MAX_LEXICAL_BATCH_OCCURRENCES
      ) {
        if (signal?.aborted) throw sqliteError("cancelled", "Request cancelled", true);
        const slice = input.blocks.slice(offset, offset + SQLITE_MAX_LEXICAL_BATCH_OCCURRENCES);
        transaction(this.db, () => {
          for (const block of slice) {
            this.db.exec({
              sql: `INSERT INTO lexical_stage_occurrences(
                     run_id,path_text,ordinal,kind,start_line,end_line,display_text,
                     heading_context,embedding_input,embedding_input_digest
                   ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
              bind: [
                runId,
                input.path,
                block.ordinal,
                block.kind,
                block.startLine,
                block.endLine,
                block.displayText,
                JSON.stringify(block.headingContext),
                block.embeddingInput,
                block.embeddingInputDigest,
              ],
            });
          }
          this.db.exec({
            sql: `UPDATE lexical_stage_notes
                  SET received_count=(
                    SELECT count(*) FROM lexical_stage_occurrences
                    WHERE run_id=? AND path_text=?
                  )
                  WHERE run_id=? AND path_text=?`,
            bind: [runId, input.path, runId, input.path],
          });
        });
      }
      if (signal?.aborted) throw sqliteError("cancelled", "Request cancelled", true);
      let result: LexicalRevisionApplyResult;
      transaction(this.db, () => {
        const metadata = rows(
          this.db,
          `SELECT revision_digest,expected_count,received_count
           FROM lexical_stage_notes WHERE run_id=? AND path_text=?`,
          [runId, input.path]
        )[0];
        if (
          !metadata ||
          String(metadata.revision_digest) !== input.revisionDigest ||
          Number(metadata.expected_count) !== input.blocks.length ||
          Number(metadata.received_count) !== input.blocks.length
        )
          throw sqliteError("integrity_failed", "Staged lexical revision is incomplete");
        const ordinalCheck = rows(
          this.db,
          `SELECT count(*) AS count,min(ordinal) AS firstOrdinal,max(ordinal) AS lastOrdinal,
                  count(DISTINCT ordinal) AS distinctOrdinals
           FROM lexical_stage_occurrences WHERE run_id=? AND path_text=?`,
          [runId, input.path]
        )[0];
        if (
          Number(ordinalCheck.count) !== input.blocks.length ||
          Number(ordinalCheck.firstOrdinal) !== 0 ||
          Number(ordinalCheck.lastOrdinal) !== input.blocks.length - 1 ||
          Number(ordinalCheck.distinctOrdinals) !== input.blocks.length
        )
          throw sqliteError("integrity_failed", "Staged lexical ordinals are not contiguous");
        let renamed = 0;
        let semanticChanged = 0;
        if (!run.renamesApplied) {
          const renameResult = this.applyRunRenamesInTransaction(run.renames);
          renamed = renameResult.changed;
          semanticChanged = renameResult.semanticChanged;
        }
        result = this.activateStagedRevisionInTransaction(runId, input.path, input.revisionDigest);
        result = {
          ...result,
          renamed,
          semanticChanged: result.semanticChanged + semanticChanged,
        };
        this.db.exec({
          sql: `UPDATE index_state
                SET incomplete=1,
                    lexical_generation=lexical_generation+1,
                    semantic_generation=semantic_generation+CASE WHEN ? > 0 THEN 1 ELSE 0 END,
                    lexical_revision_count=(SELECT count(*) FROM notes WHERE lexical_revision_id IS NOT NULL),
                    semantic_revision_count=(SELECT count(*) FROM notes WHERE semantic_revision_id IS NOT NULL),
                    embedding_input_count=(SELECT count(*) FROM embedding_inputs),
                    change_counter=change_counter+1
                WHERE id=1`,
          bind: [result.semanticChanged],
        });
        this.db.exec({
          sql: "DELETE FROM lexical_stage_occurrences WHERE run_id=? AND path_text=?",
          bind: [runId, input.path],
        });
        this.db.exec({
          sql: "DELETE FROM lexical_stage_notes WHERE run_id=? AND path_text=?",
          bind: [runId, input.path],
        });
      });
      run.renamesApplied = true;
      run.changeCounter = this.readChangeCounter();
      const generation = this.readGenerationToken();
      const changedTotal = result!.changed + result!.renamed;
      return {
        runId,
        changed: changedTotal > 0,
        applied: result!.changed,
        changedCount: changedTotal,
        skipped: result!.skipped,
        occurrences: result!.occurrences,
        receipt: {
          changed: changedTotal > 0,
          status: changedTotal > 0 ? "changed" : "unchanged",
          generation,
        },
      };
    } catch (error) {
      this.discardLexicalStaging(runId);
      throw error;
    }
  }

  /** Remove operation-local staged rows while preserving earlier committed notes. */
  discardLexicalStaging(runId: string): void {
    this.ensureOpen();
    try {
      this.db.exec({
        sql: "DELETE FROM lexical_stage_occurrences WHERE run_id=?",
        bind: [runId],
      });
      this.db.exec({
        sql: "DELETE FROM lexical_stage_notes WHERE run_id=?",
        bind: [runId],
      });
    } catch {
      // The temp tables may not exist yet, or the connection may be unwinding.
    }
  }

  private ensureLexicalStageTables(): void {
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS lexical_stage_notes(
        run_id TEXT NOT NULL,
        path_text TEXT NOT NULL,
        revision_digest TEXT NOT NULL,
        expected_count INTEGER NOT NULL CHECK(expected_count >= 0),
        received_count INTEGER NOT NULL DEFAULT 0 CHECK(received_count >= 0),
        PRIMARY KEY(run_id,path_text)
      );
      CREATE TEMP TABLE IF NOT EXISTS lexical_stage_occurrences(
        run_id TEXT NOT NULL,
        path_text TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        kind TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        display_text TEXT NOT NULL,
        heading_context TEXT NOT NULL,
        embedding_input TEXT NOT NULL,
        embedding_input_digest TEXT NOT NULL,
        PRIMARY KEY(run_id,path_text,ordinal)
      );
    `);
  }

  private activateStagedRevisionInTransaction(
    runId: string,
    path: string,
    revisionDigest: string
  ): LexicalRevisionApplyResult {
    const note = rows(
      this.db,
      "SELECT note_id,lexical_revision_id,semantic_revision_id FROM notes WHERE path=?",
      [path]
    )[0];
    const priorRevision =
      note?.lexical_revision_id == null ? undefined : Number(note.lexical_revision_id);
    if (priorRevision !== undefined) {
      const current = rows(this.db, "SELECT content_id FROM note_revisions WHERE revision_id=?", [
        priorRevision,
      ])[0];
      if (current && String(current.content_id) === revisionDigest)
        return { changed: 0, skipped: 1, occurrences: 0, renamed: 0, semanticChanged: 0 };
    }
    let noteId: number;
    if (note) noteId = Number(note.note_id);
    else {
      this.db.exec({
        sql: "INSERT INTO notes(note_id,path,content_id) SELECT COALESCE(MAX(note_id),0)+1,?,? FROM notes",
        bind: [path, revisionDigest],
      });
      noteId = Number(rows(this.db, "SELECT note_id FROM notes WHERE path=?", [path])[0].note_id);
    }
    let revisionId = Number(
      rows(
        this.db,
        "SELECT revision_id FROM note_revisions WHERE note_id=? AND content_id=? AND extraction_version=? AND chunk_algorithm_version=?",
        [noteId, revisionDigest, EXTRACTION_VERSION, CHUNK_ALGORITHM_VERSION]
      )[0]?.revision_id ?? 0
    );
    const expectedCount = Number(
      rows(
        this.db,
        "SELECT expected_count FROM lexical_stage_notes WHERE run_id=? AND path_text=?",
        [runId, path]
      )[0]?.expected_count ?? -1
    );
    if (!revisionId) {
      this.db.exec({
        sql: "INSERT INTO note_revisions(note_id,content_id,extraction_version,chunk_algorithm_version,created_change_counter) VALUES(?,?,?,?,(SELECT change_counter+1 FROM index_state WHERE id=1))",
        bind: [noteId, revisionDigest, EXTRACTION_VERSION, CHUNK_ALGORITHM_VERSION],
      });
      revisionId = Number(rows(this.db, "SELECT last_insert_rowid() AS id")[0].id);
      this.db.exec({
        sql: `INSERT INTO chunk_occurrences(
                revision_id,note_id,chunk_id,ordinal,kind,start_line,end_line,display_text,
                heading_context,embedding_input,embedding_input_digest,body
              )
              SELECT ?,?,? || ordinal,ordinal,kind,start_line,end_line,display_text,heading_context,
                     embedding_input,embedding_input_digest,display_text
              FROM lexical_stage_occurrences
              WHERE run_id=? AND path_text=? ORDER BY ordinal`,
        bind: [revisionId, noteId, `${revisionDigest}:`, runId, path],
      });
      this.db.exec({
        sql: `INSERT INTO embedding_inputs(embedding_fingerprint,serialized_input,preprocessing,action_key)
              SELECT 'input-v1',embedding_input,'serialized-v1',embedding_input_digest
              FROM lexical_stage_occurrences WHERE run_id=? AND path_text=?
              ON CONFLICT(action_key) DO NOTHING`,
        bind: [runId, path],
      });
    } else {
      const existingCount = Number(
        rows(this.db, "SELECT count(*) AS count FROM chunk_occurrences WHERE revision_id=?", [
          revisionId,
        ])[0].count
      );
      if (existingCount !== expectedCount)
        throw sqliteError("integrity_failed", "Durable lexical revision has an unexpected count");
    }
    if (priorRevision !== undefined && priorRevision !== revisionId) {
      this.db.exec({
        sql: `INSERT INTO active_lexical_fts(active_lexical_fts,rowid,body,path_text,filename)
              SELECT 'delete',occurrence_id,body,path_text,filename FROM active_lexical WHERE note_id=?`,
        bind: [noteId],
      });
      this.db.exec({ sql: "DELETE FROM active_lexical WHERE note_id=?", bind: [noteId] });
    }
    const filename = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
    this.db.exec({
      sql: `INSERT INTO active_lexical(occurrence_id,note_id,revision_id,path_text,filename,body)
            SELECT occurrence_id,note_id,revision_id,?,?,display_text
            FROM chunk_occurrences WHERE revision_id=?`,
      bind: [path, filename, revisionId],
    });
    this.db.exec({
      sql: `INSERT INTO active_lexical_fts(rowid,body,path_text,filename)
            SELECT occurrence_id,display_text,?,? FROM chunk_occurrences WHERE revision_id=?`,
      bind: [path, filename, revisionId],
    });
    this.db.exec({
      sql: "UPDATE notes SET lexical_revision_id=?,content_id=? WHERE note_id=?",
      bind: [revisionId, revisionDigest, noteId],
    });
    return {
      changed: 1,
      skipped: 0,
      occurrences: expectedCount,
      renamed: 0,
      semanticChanged: note?.semantic_revision_id == null ? 0 : 1,
    };
  }

  finishLexicalRun(runId: string): SqliteLexicalRunResult {
    this.ensureOpen();
    const run = this.lexicalRuns.get(runId);
    if (!run) throw sqliteError("invalid_request", "Lexical run is not active");
    if (this.hasLexicalStaging(runId))
      throw sqliteError("busy", "Lexical run has unfinished staged revisions", true);
    if (this.readChangeCounter() !== run.changeCounter)
      throw sqliteError("busy", "Lexical run generation is stale", true);
    let renamed = 0;
    let deleted = 0;
    let semanticChanged = 0;
    let changed = false;
    let processedDeletes = 0;
    const deleteBatch = run.deletes.slice(0, 16);
    transaction(this.db, () => {
      if (!run.renamesApplied) {
        const result = this.applyRunRenamesInTransaction(run.renames);
        renamed = result.changed;
        semanticChanged += result.semanticChanged;
      }
      if (run.expected) {
        const mismatch = withExpectedNotes(
          this.db,
          run.expected,
          () =>
            rows(
              this.db,
              `SELECT count(*) AS count
             FROM reconciliation_expected e LEFT JOIN notes n ON n.path=e.path
             LEFT JOIN note_revisions r ON r.revision_id=n.lexical_revision_id
             WHERE n.note_pk IS NULL OR r.content_id<>e.content_id OR
                   (e.chunk_count IS NOT NULL AND e.chunk_count<>(
                     SELECT count(*) FROM chunk_occurrences c
                     WHERE c.note_id=n.note_id AND c.revision_id=n.lexical_revision_id
                   ))`,
              []
            )[0]
        );
        if (Number(mismatch.count))
          throw sqliteError("busy", "Lexical run has unapplied notes", true);
      }
      if (deleteBatch.length) {
        this.db.exec(
          "CREATE TEMP TABLE lexical_delete_paths(path TEXT PRIMARY KEY COLLATE BINARY)"
        );
        try {
          for (const item of deleteBatch)
            this.db.exec({
              sql: "INSERT OR IGNORE INTO lexical_delete_paths(path) VALUES(?)",
              bind: [item.path],
            });
          processedDeletes = deleteBatch.length;
          deleted = Number(
            rows(
              this.db,
              "SELECT count(*) AS count FROM notes n JOIN lexical_delete_paths d ON d.path=n.path"
            )[0]?.count ?? 0
          );
          semanticChanged += Number(
            rows(
              this.db,
              "SELECT count(*) AS count FROM notes n JOIN lexical_delete_paths d ON d.path=n.path WHERE n.semantic_revision_id IS NOT NULL"
            )[0]?.count ?? 0
          );
          if (deleted) {
            this.db.exec({
              sql: `INSERT INTO active_lexical_fts(active_lexical_fts,rowid,body,path_text,filename)
                    SELECT 'delete',a.occurrence_id,a.body,a.path_text,a.filename
                    FROM active_lexical a JOIN notes n ON n.note_id=a.note_id
                    JOIN lexical_delete_paths d ON d.path=n.path`,
            });
            this.db.exec({
              sql: "DELETE FROM notes WHERE path IN (SELECT path FROM lexical_delete_paths)",
            });
          }
        } finally {
          this.db.exec("DROP TABLE IF EXISTS lexical_delete_paths");
        }
      }
      changed = renamed > 0 || deleted > 0;
      const complete = run.deletes.length <= processedDeletes;
      const converged = complete && (!run.scoped || run.mayClearIncomplete);
      this.db.exec({
        sql: `UPDATE index_state
              SET incomplete=CASE WHEN ? THEN 0 ELSE 1 END,
                  snapshot_loaded=0,reconciliation_summary='',
                  lexical_generation=lexical_generation+?,
                  semantic_generation=semantic_generation+CASE WHEN ? > 0 THEN 1 ELSE 0 END,
                  lexical_revision_count=(SELECT count(*) FROM notes WHERE lexical_revision_id IS NOT NULL),
                  semantic_revision_count=(SELECT count(*) FROM notes WHERE semantic_revision_id IS NOT NULL),
                  embedding_input_count=(SELECT count(*) FROM embedding_inputs),
                  change_counter=change_counter+CASE WHEN ? THEN 1 ELSE 0 END
              WHERE id=1`,
        bind: [converged ? 1 : 0, changed ? 1 : 0, semanticChanged, changed ? 1 : 0],
      });
    });
    if (processedDeletes) run.deletes.splice(0, processedDeletes);
    run.changeCounter = this.readChangeCounter();
    const complete = run.deletes.length === 0;
    if (complete) this.lexicalRuns.delete(runId);
    const state = this.getState();
    return {
      runId,
      state,
      complete,
      ...(complete ? {} : { remaining: run.deletes.length }),
      ...(renamed ? { renamed } : {}),
      ...(deleted ? { deleted } : {}),
      receipt: sqliteMutationReceipt(state, changed, changed ? "changed" : "unchanged"),
    };
  }

  abortLexicalRun(runId: string): SqliteLexicalRunResult {
    this.ensureOpen();
    const run = this.lexicalRuns.get(runId);
    if (!run) throw sqliteError("invalid_request", "Lexical run is not active");
    this.discardLexicalStaging(runId);
    this.lexicalRuns.delete(runId);
    const state = this.getState();
    return {
      runId,
      state,
      receipt: sqliteMutationReceipt(state, false, "unchanged"),
    };
  }

  private hasLexicalStaging(runId: string): boolean {
    try {
      return (
        Number(
          rows(this.db, "SELECT count(*) AS count FROM lexical_stage_notes WHERE run_id=?", [
            runId,
          ])[0]?.count ?? 0
        ) > 0
      );
    } catch {
      return false;
    }
  }

  private readGenerationToken(): SqliteGenerationToken {
    const row = rows(
      this.db,
      "SELECT change_counter AS changeCounter,lexical_generation AS lexicalGeneration,semantic_generation AS semanticGeneration FROM index_state WHERE id=1"
    )[0];
    if (!row) throw sqliteError("incompatible_state", "SQLite state is not initialized");
    return {
      changeCounter: Number(row.changeCounter),
      lexicalGeneration: Number(row.lexicalGeneration),
      semanticGeneration: Number(row.semanticGeneration),
    };
  }

  private hasMissingEmbeddingInputs(embeddingFingerprint: string, preprocessing: string): boolean {
    return (
      rows(
        this.db,
        `SELECT 1
         FROM embedding_inputs ei
         JOIN chunk_occurrences o ON o.embedding_input_digest=ei.action_key
         JOIN notes n ON n.note_id=o.note_id AND n.lexical_revision_id=o.revision_id
         LEFT JOIN embedding_cache ec
           ON ec.input_digest=ei.action_key
          AND ec.embedding_fingerprint=?
          AND ec.preprocessing=?
         WHERE ec.cache_id IS NULL
         LIMIT 1`,
        [embeddingFingerprint, preprocessing]
      ).length > 0
    );
  }

  /** Prepare one bounded semantic slice. Promotion and input selection are one SQL pass. */
  prepareSemanticWork(
    embeddingFingerprint: string,
    preprocessing = EMBEDDING_PREPROCESSING_VERSION,
    limit = SQLITE_MAX_SEMANTIC_BATCH_ITEMS,
    maxInputBytes = SQLITE_MAX_SEMANTIC_INPUT_BYTES,
    promoteUnrestricted = true
  ): SqliteSemanticWorkBatch {
    this.ensureOpen();
    const boundedInputBytes = Math.max(1, maxInputBytes);
    let promoted = 0;
    if (promoteUnrestricted)
      transaction(this.db, () => {
        promoted = this.promoteSemanticHeadsInTransaction(embeddingFingerprint, preprocessing);
        if (promoted)
          this.db.exec({
            sql: "UPDATE index_state SET semantic_revision_count=(SELECT count(*) FROM notes WHERE semantic_revision_id IS NOT NULL),semantic_generation=semantic_generation+1,change_counter=change_counter+1 WHERE id=1",
          });
      });
    const first = rows(
      this.db,
      `SELECT length(CAST(ei.serialized_input AS BLOB)) AS inputBytes
       FROM embedding_inputs ei
       WHERE EXISTS (
         SELECT 1
         FROM chunk_occurrences o
         JOIN notes n ON n.note_id=o.note_id AND n.lexical_revision_id=o.revision_id
         WHERE o.embedding_input_digest=ei.action_key
       )
         AND NOT EXISTS (
           SELECT 1
           FROM embedding_cache ec
           WHERE ec.input_digest=ei.action_key
             AND ec.embedding_fingerprint=?
             AND ec.preprocessing=?
         )
       ORDER BY ei.input_id
       LIMIT 1`,
      [embeddingFingerprint, preprocessing]
    )[0];
    const firstInputBytes = Number(first?.inputBytes ?? 0);
    if (limit > 0 && firstInputBytes > boundedInputBytes)
      throw sqliteError(
        "limit_exceeded",
        `Semantic input is ${firstInputBytes} bytes; maximum is ${boundedInputBytes} bytes.`
      );
    const requests = rows(
      this.db,
      `WITH candidates AS MATERIALIZED (
         SELECT ei.input_id AS inputId,ei.serialized_input AS serialization,ei.action_key AS inputDigest
         FROM embedding_inputs ei
         WHERE EXISTS (
           SELECT 1
           FROM chunk_occurrences o
           JOIN notes n ON n.note_id=o.note_id AND n.lexical_revision_id=o.revision_id
           WHERE o.embedding_input_digest=ei.action_key
         )
           AND NOT EXISTS (
             SELECT 1
             FROM embedding_cache ec
             WHERE ec.input_digest=ei.action_key
               AND ec.embedding_fingerprint=?
               AND ec.preprocessing=?
           )
         ORDER BY ei.input_id
         LIMIT ?
       ), bounded AS (
         SELECT *,
           sum(length(CAST(serialization AS BLOB))) OVER (
             ORDER BY inputId ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS inputBytes,
           row_number() OVER (ORDER BY inputId) AS itemNumber
         FROM candidates
       )
       SELECT inputId,serialization,inputDigest
       FROM bounded
       WHERE itemNumber<=? AND inputBytes<=?
       ORDER BY inputId`,
      [
        embeddingFingerprint,
        preprocessing,
        Math.max(0, limit),
        Math.max(0, limit),
        boundedInputBytes,
      ]
    ).map((row) => ({
      actionKey: embeddingActionKey(String(row.inputDigest), embeddingFingerprint, preprocessing),
      inputId: Number(row.inputId),
      serialization: String(row.serialization),
    }));
    return {
      requests,
      hasMore: this.hasMissingEmbeddingInputs(embeddingFingerprint, preprocessing),
      generation: this.readGenerationToken(),
      promoted,
    };
  }

  /** Commit one provider slice without recalculating full index state. */
  commitSemanticResults(
    results: readonly SqliteEmbeddingResult[],
    embeddingFingerprint: string,
    preprocessing = EMBEDDING_PREPROCESSING_VERSION
  ): SqliteSemanticCommitResult {
    this.ensureOpen();
    const valid: SqliteEmbeddingResult[] = [];
    let skipped = 0;
    const inputRows = new Map<
      number,
      { readonly actionKey: string; readonly serialization: string }
    >();
    for (const result of results) {
      if (!inputRows.has(result.inputId)) {
        const input = rows(
          this.db,
          "SELECT action_key,serialized_input FROM embedding_inputs WHERE input_id=?",
          [result.inputId]
        )[0];
        if (input)
          inputRows.set(result.inputId, {
            actionKey: String(input.action_key),
            serialization: String(input.serialized_input),
          });
      }
      const input = inputRows.get(result.inputId);
      const expected =
        input && embeddingActionKey(input.actionKey, embeddingFingerprint, preprocessing);
      if (!input || input.serialization !== result.serialization || expected !== result.actionKey) {
        skipped++;
        continue;
      }
      try {
        // Normalize before opening the write transaction so malformed provider
        // data cannot leave a partially staged batch behind.
        const vector = normalizedVector(result.vector, this.dimensions);
        valid.push({ ...result, vector });
      } catch (error) {
        if (error instanceof Error && "error" in error) throw error;
        skipped++;
      }
    }
    // Duplicate results cannot inflate stored counts or trigger duplicate work.
    const unique = new Map<string, SqliteEmbeddingResult>();
    for (const result of valid) unique.set(result.actionKey, result);
    const accepted = [...unique.values()];
    let promoted = 0;
    transaction(this.db, () => {
      this.db.exec(
        "CREATE TEMP TABLE semantic_result_inputs(input_digest TEXT PRIMARY KEY,action_key TEXT NOT NULL,serialization TEXT NOT NULL,vector BLOB NOT NULL)"
      );
      try {
        for (const result of accepted) {
          const input = inputRows.get(result.inputId)!;
          this.db.exec({
            sql: "INSERT INTO semantic_result_inputs(input_digest,action_key,serialization,vector) VALUES(?,?,?,?)",
            bind: [
              input.actionKey,
              result.actionKey,
              result.serialization,
              vectorBytes(result.vector),
            ],
          });
        }
        this.db.exec(`CREATE TEMP TABLE semantic_affected_notes(note_id INTEGER PRIMARY KEY)`);
        this.db.exec({
          sql: `INSERT INTO semantic_affected_notes(note_id)
                SELECT DISTINCT n.note_id
                FROM notes n
                JOIN chunk_occurrences o ON o.note_id=n.note_id AND o.revision_id=n.lexical_revision_id
                JOIN semantic_result_inputs r ON r.input_digest=o.embedding_input_digest
                WHERE n.lexical_revision_id IS NOT NULL`,
        });
        this.db.exec({
          sql: `INSERT INTO embedding_cache(input_digest,action_key,embedding_fingerprint,preprocessing,vector)
                SELECT input_digest,action_key,?, ?,vector
                FROM semantic_result_inputs
                WHERE 1
                ON CONFLICT(action_key) DO UPDATE SET
                  input_digest=excluded.input_digest,
                  embedding_fingerprint=excluded.embedding_fingerprint,
                  preprocessing=excluded.preprocessing,
                  vector=excluded.vector`,
          bind: [embeddingFingerprint, preprocessing],
        });
        promoted = this.promoteSemanticHeadsInTransaction(
          embeddingFingerprint,
          preprocessing,
          "semantic_affected_notes"
        );
        if (promoted)
          this.db.exec({
            sql: "UPDATE index_state SET semantic_revision_count=(SELECT count(*) FROM notes WHERE semantic_revision_id IS NOT NULL),semantic_generation=semantic_generation+1,change_counter=change_counter+1 WHERE id=1",
          });
      } finally {
        this.db.exec("DROP TABLE IF EXISTS semantic_affected_notes");
        this.db.exec("DROP TABLE IF EXISTS semantic_result_inputs");
      }
    });
    return {
      stored: accepted.length,
      skipped,
      promoted,
      hasMore: this.hasMissingEmbeddingInputs(embeddingFingerprint, preprocessing),
      generation: this.readGenerationToken(),
    };
  }

  private applyRunRenamesInTransaction(
    renames: readonly { from: string; to: string; contentId: string }[]
  ): { readonly changed: number; readonly semanticChanged: number } {
    if (!renames.length) return { changed: 0, semanticChanged: 0 };
    this.db.exec(
      "CREATE TEMP TABLE lexical_run_renames(note_id INTEGER PRIMARY KEY,from_path TEXT NOT NULL,to_path TEXT NOT NULL,filename TEXT NOT NULL)"
    );
    let changed = 0;
    let semanticChanged = 0;
    try {
      for (const rename of renames) {
        const row = rows(this.db, "SELECT note_id,semantic_revision_id FROM notes WHERE path=?", [
          rename.from,
        ])[0];
        if (!row || rows(this.db, "SELECT 1 FROM notes WHERE path=?", [rename.to]).length) continue;
        this.db.exec({
          sql: "INSERT INTO lexical_run_renames(note_id,from_path,to_path,filename) VALUES(?,?,?,?)",
          bind: [
            Number(row.note_id),
            rename.from,
            rename.to,
            rename.to.slice(rename.to.lastIndexOf("/") + 1).replace(/\.md$/i, ""),
          ],
        });
        changed++;
        if (row.semantic_revision_id != null) semanticChanged++;
      }
      if (changed) {
        this.db.exec({
          sql: `INSERT INTO active_lexical_fts(active_lexical_fts,rowid,body,path_text,filename)
                SELECT 'delete',a.occurrence_id,a.body,a.path_text,a.filename
                FROM active_lexical a JOIN lexical_run_renames r ON r.note_id=a.note_id`,
        });
        this.db.exec({
          sql: "UPDATE notes SET path=(SELECT to_path FROM lexical_run_renames r WHERE r.note_id=notes.note_id) WHERE note_id IN (SELECT note_id FROM lexical_run_renames)",
        });
        this.db.exec({
          sql: `UPDATE active_lexical
                SET path_text=(SELECT to_path FROM lexical_run_renames r WHERE r.note_id=active_lexical.note_id),
                    filename=(SELECT filename FROM lexical_run_renames r WHERE r.note_id=active_lexical.note_id)
                WHERE note_id IN (SELECT note_id FROM lexical_run_renames)`,
        });
        this.db.exec({
          sql: `INSERT INTO active_lexical_fts(rowid,body,path_text,filename)
                SELECT a.occurrence_id,a.body,a.path_text,a.filename
                FROM active_lexical a JOIN lexical_run_renames r ON r.note_id=a.note_id`,
        });
      }
    } finally {
      this.db.exec("DROP TABLE IF EXISTS lexical_run_renames");
    }
    return { changed, semanticChanged };
  }

  listLexicalSummaries(): readonly import("./protocol").SqliteLexicalSummary[] {
    this.ensureOpen();
    return rows(
      this.db,
      `SELECT n.note_id AS noteId,n.path,
              lr.content_id AS revisionDigest,
              n.lexical_revision_id AS lexicalRevisionId,
              n.semantic_revision_id AS semanticRevisionId
       FROM notes n LEFT JOIN note_revisions lr ON lr.revision_id=n.lexical_revision_id
       ORDER BY n.path COLLATE BINARY`
    ).map((row) => ({
      noteId: Number(row.noteId),
      path: String(row.path),
      ...(row.revisionDigest == null ? {} : { revisionDigest: String(row.revisionDigest) }),
      ...(row.lexicalRevisionId == null
        ? {}
        : { lexicalRevisionId: Number(row.lexicalRevisionId) }),
      ...(row.semanticRevisionId == null
        ? {}
        : { semanticRevisionId: Number(row.semanticRevisionId) }),
    }));
  }

  listMissingEmbeddingInputs(
    embeddingFingerprint: string,
    preprocessing = EMBEDDING_PREPROCESSING_VERSION,
    limit = 128
  ): readonly import("./protocol").SqliteEmbeddingRequest[] {
    this.ensureOpen();
    return rows(
      this.db,
      `SELECT ei.input_id AS inputId,ei.serialized_input AS serialization,ei.action_key AS inputDigest
       FROM embedding_inputs ei
       JOIN chunk_occurrences o ON o.embedding_input_digest=ei.action_key
       JOIN notes n ON n.note_id=o.note_id AND n.lexical_revision_id=o.revision_id
       LEFT JOIN embedding_cache ec ON ec.input_digest=ei.action_key
          AND ec.embedding_fingerprint=? AND ec.preprocessing=?
       WHERE ec.cache_id IS NULL
       GROUP BY ei.input_id,ei.serialized_input,ei.action_key
       ORDER BY ei.input_id
       LIMIT ?`,
      [embeddingFingerprint, preprocessing, Math.max(0, limit)]
    ).map((row) => ({
      actionKey: embeddingActionKey(String(row.inputDigest), embeddingFingerprint, preprocessing),
      inputId: Number(row.inputId),
      serialization: String(row.serialization),
    }));
  }

  storeEmbeddingResults(
    results: readonly import("./protocol").SqliteEmbeddingResult[],
    embeddingFingerprint: string,
    preprocessing = EMBEDDING_PREPROCESSING_VERSION
  ): SqliteSemanticMutationResult {
    this.ensureOpen();
    let stored = 0;
    let skipped = 0;
    let promoted = 0;
    transaction(this.db, () => {
      for (const result of results) {
        const input = rows(
          this.db,
          "SELECT action_key,serialized_input FROM embedding_inputs WHERE input_id=?",
          [result.inputId]
        )[0];
        const expected =
          input &&
          embeddingActionKey(String(input.action_key), embeddingFingerprint, preprocessing);
        if (
          !input ||
          String(input.serialized_input) !== result.serialization ||
          expected !== result.actionKey
        ) {
          skipped++;
          continue;
        }
        let bytes: Uint8Array;
        try {
          bytes = vectorBytes(normalizedVector(result.vector, this.dimensions));
        } catch (error) {
          if (error instanceof Error && "error" in error) throw error;
          skipped++;
          continue;
        }
        this.db.exec({
          sql: "INSERT INTO embedding_cache(input_digest,action_key,embedding_fingerprint,preprocessing,vector) VALUES(?,?,?,?,?) ON CONFLICT(action_key) DO UPDATE SET embedding_fingerprint=excluded.embedding_fingerprint,preprocessing=excluded.preprocessing,vector=excluded.vector",
          bind: [
            String(input.action_key),
            result.actionKey,
            embeddingFingerprint,
            preprocessing,
            bytes,
          ],
        });
        stored++;
      }
      promoted = this.promoteSemanticHeadsInTransaction(embeddingFingerprint, preprocessing);
      if (stored || promoted)
        this.db.exec({
          sql: "UPDATE index_state SET semantic_revision_count=semantic_revision_count+?,semantic_generation=semantic_generation+CASE WHEN ? > 0 THEN 1 ELSE 0 END,change_counter=change_counter+? WHERE id=1",
          bind: [promoted, promoted, stored || promoted ? 1 : 0],
        });
    });
    const state = this.getState();
    const changed = stored > 0 || promoted > 0;
    const status = changed ? "changed" : "unchanged";
    return {
      stored,
      skipped,
      promoted,
      state,
      receipt: sqliteMutationReceipt(state, changed, status),
    };
  }

  promoteSemanticHeads(
    embeddingFingerprint: string,
    preprocessing = EMBEDDING_PREPROCESSING_VERSION
  ): SqliteSemanticMutationResult {
    this.ensureOpen();
    let promoted = 0;
    transaction(this.db, () => {
      promoted = this.promoteSemanticHeadsInTransaction(embeddingFingerprint, preprocessing);
      if (promoted)
        this.db.exec({
          sql: "UPDATE index_state SET semantic_revision_count=(SELECT count(*) FROM notes WHERE semantic_revision_id IS NOT NULL),semantic_generation=semantic_generation+1,change_counter=change_counter+1 WHERE id=1",
        });
    });
    const state = this.getState();
    return {
      promoted,
      state,
      receipt: sqliteMutationReceipt(state, promoted > 0, promoted > 0 ? "changed" : "unchanged"),
    };
  }

  private promoteSemanticHeadsInTransaction(
    embeddingFingerprint: string,
    preprocessing: string,
    affectedTable?: string
  ): number {
    const affected = affectedTable
      ? `AND EXISTS (SELECT 1 FROM ${affectedTable} a WHERE a.note_id=n.note_id)`
      : "";
    this.db.exec({
      sql: `UPDATE notes AS n
            SET semantic_revision_id=n.lexical_revision_id
            WHERE n.lexical_revision_id IS NOT NULL
              AND n.semantic_revision_id IS NOT n.lexical_revision_id
              ${affected}
              AND NOT EXISTS (
                SELECT 1
                FROM chunk_occurrences o
                JOIN embedding_inputs ei ON ei.action_key=o.embedding_input_digest
                LEFT JOIN embedding_cache ec
                  ON ec.input_digest=ei.action_key
                 AND ec.embedding_fingerprint=?
                 AND ec.preprocessing=?
                WHERE o.note_id=n.note_id
                  AND o.revision_id=n.lexical_revision_id
                  AND ec.cache_id IS NULL
              )`,
      bind: [embeddingFingerprint, preprocessing],
    });
    return Number(rows(this.db, "SELECT changes() AS count")[0]?.count ?? 0);
  }

  clearSemanticCache(): SqliteState {
    this.ensureOpen();
    const hadVisibleHeads =
      Number(
        rows(
          this.db,
          "SELECT count(*) AS count FROM notes WHERE semantic_revision_id IS NOT NULL"
        )[0]?.count ?? 0
      ) > 0;
    transaction(this.db, () => {
      this.db.exec({
        sql: "UPDATE notes SET semantic_revision_id=NULL WHERE semantic_revision_id IS NOT NULL",
      });
      this.db.exec({
        sql: "DELETE FROM embedding_cache WHERE embedding_fingerprint=?",
        bind: [this.embeddingFingerprint],
      });
      this.db.exec({
        sql: "UPDATE index_state SET semantic_revision_count=0,semantic_generation=semantic_generation+CASE WHEN ? THEN 1 ELSE 0 END,change_counter=change_counter+1 WHERE id=1",
        bind: [hadVisibleHeads ? 1 : 0],
      });
    });
    return this.getState();
  }

  renameLexicalNote(from: string, to: string): SqliteMutationResult {
    this.ensureOpen();
    if (from === to) {
      const state = this.getState();
      return {
        changed: false,
        status: "unchanged",
        state,
        receipt: sqliteMutationReceipt(state, false, "unchanged"),
      };
    }
    const row = rows(this.db, "SELECT note_id,semantic_revision_id FROM notes WHERE path=?", [
      from,
    ])[0];
    if (!row) {
      const state = this.getState();
      return {
        changed: false,
        status: "absent",
        state,
        receipt: sqliteMutationReceipt(state, false, "absent"),
      };
    }
    if (rows(this.db, "SELECT 1 FROM notes WHERE path=?", [to]).length) {
      const state = this.getState();
      return {
        changed: false,
        status: "state_changed",
        rescan: true,
        state,
        receipt: sqliteMutationReceipt(state, false, "state_changed"),
      };
    }
    transaction(this.db, () => {
      const oldFtsRows = rows(
        this.db,
        "SELECT occurrence_id,body,path_text,filename FROM active_lexical WHERE note_id=?",
        [row.note_id]
      );
      for (const item of oldFtsRows)
        this.db.exec({
          sql: "INSERT INTO active_lexical_fts(active_lexical_fts,rowid,body,path_text,filename) VALUES('delete',?,?,?,?)",
          bind: [item.occurrence_id, item.body, item.path_text, item.filename],
        });
      this.db.exec({ sql: "UPDATE notes SET path=? WHERE note_id=?", bind: [to, row.note_id] });
      this.db.exec({
        sql: "UPDATE active_lexical SET path_text=?,filename=? WHERE note_id=?",
        bind: [to, to.slice(to.lastIndexOf("/") + 1).replace(/\.md$/i, ""), row.note_id],
      });
      this.db.exec({
        sql: "UPDATE index_state SET lexical_generation=lexical_generation+1,semantic_generation=semantic_generation+CASE WHEN ? IS NOT NULL THEN 1 ELSE 0 END,change_counter=change_counter+1,incomplete=1 WHERE id=1",
        bind: [row.semantic_revision_id ?? null],
      });
      for (const item of rows(
        this.db,
        "SELECT occurrence_id,body,filename FROM active_lexical WHERE note_id=?",
        [row.note_id]
      ))
        this.db.exec({
          sql: "INSERT INTO active_lexical_fts(rowid,body,path_text,filename) VALUES(?,?,?,?)",
          bind: [item.occurrence_id, item.body, to, item.filename],
        });
    });
    const state = this.getState();
    return {
      changed: true,
      status: "changed",
      state,
      receipt: sqliteMutationReceipt(state, true, "changed"),
    };
  }

  deleteLexicalNote(path: string): SqliteMutationResult {
    this.ensureOpen();
    const row = rows(this.db, "SELECT note_id,semantic_revision_id FROM notes WHERE path=?", [
      path,
    ])[0];
    if (!row) {
      const state = this.getState();
      return {
        changed: false,
        status: "absent",
        state,
        receipt: sqliteMutationReceipt(state, false, "absent"),
      };
    }
    transaction(this.db, () => {
      for (const item of rows(
        this.db,
        "SELECT occurrence_id,body,path_text,filename FROM active_lexical WHERE note_id=?",
        [row.note_id]
      ))
        this.db.exec({
          sql: "INSERT INTO active_lexical_fts(active_lexical_fts,rowid,body,path_text,filename) VALUES('delete',?,?,?,?)",
          bind: [item.occurrence_id, item.body, item.path_text, item.filename],
        });
      this.db.exec({ sql: "DELETE FROM notes WHERE note_id=?", bind: [row.note_id] });
      this.db.exec({
        sql: "UPDATE index_state SET lexical_generation=lexical_generation+1,semantic_generation=semantic_generation+CASE WHEN ? IS NOT NULL THEN 1 ELSE 0 END,change_counter=change_counter+1,incomplete=1 WHERE id=1",
        bind: [row.semantic_revision_id ?? null],
      });
    });
    const state = this.getState();
    return {
      changed: true,
      status: "changed",
      state,
      receipt: sqliteMutationReceipt(state, true, "changed"),
    };
  }
  finishReconciliation(
    summaries: readonly SqliteNoteSummary[],
    observedChangeCounter: number
  ): SqliteState {
    if (this.readChangeCounter() !== observedChangeCounter) return this.getState();
    transaction(this.db, () => {
      withExpectedNotes(this.db, summaries, () => {
        const mismatch = rows(
          this.db,
          `SELECT count(*) AS count FROM reconciliation_expected e LEFT JOIN notes n ON n.path=e.path
          WHERE n.note_pk IS NULL OR n.content_id<>e.content_id OR
                (e.chunk_count IS NOT NULL AND e.chunk_count<>(SELECT count(*) FROM chunk_occurrences c JOIN notes nn ON nn.note_id=c.note_id AND nn.lexical_revision_id=c.revision_id WHERE nn.note_id=n.note_id))`,
          []
        )[0];
        if (Number(mismatch.count)) return;
        const extrasRow = rows(
          this.db,
          "SELECT count(*) AS count,sum(CASE WHEN semantic_revision_id IS NOT NULL THEN 1 ELSE 0 END) AS semanticCount FROM notes n LEFT JOIN reconciliation_expected e ON e.path=n.path WHERE e.path IS NULL"
        )[0];
        const extras = Number(extrasRow.count);
        const semanticExtras = Number(extrasRow.semanticCount ?? 0);
        this.db.exec({
          sql: "DELETE FROM notes WHERE NOT EXISTS(SELECT 1 FROM reconciliation_expected e WHERE e.path=notes.path)",
        });
        this.db.exec({
          sql: "UPDATE index_state SET incomplete=0,snapshot_loaded=0,reconciliation_summary='',lexical_generation=lexical_generation+?,semantic_generation=semantic_generation+CASE WHEN ? > 0 THEN 1 ELSE 0 END,change_counter=change_counter+? WHERE id=1 AND change_counter=?",
          bind: [extras, semanticExtras, extras ? 1 : 0, observedChangeCounter],
        });
      });
    });
    return this.getState();
  }

  finishScopedReconciliation(
    observedChangeCounter: number,
    mayClearIncomplete: boolean
  ): SqliteState {
    this.ensureOpen();
    if (this.readChangeCounter() !== observedChangeCounter || !mayClearIncomplete)
      return this.getState();
    this.db.exec({
      sql: "UPDATE index_state SET incomplete=0,snapshot_loaded=0,reconciliation_summary='' WHERE id=1 AND change_counter=?",
      bind: [observedChangeCounter],
    });
    return this.getState();
  }

  /** Revision-head retrieval. Vectors are read only for active semantic heads.
   * This deliberately uses a scalar cosine pass: vector_full_scan applies its
   * LIMIT before a join can exclude inactive cache rows on some packaged builds.
   */
  private retrieveRevisionHeads(
    query: string | undefined,
    vector: Float32Array | undefined,
    limit: number,
    currentPath: string | undefined,
    options: {
      readonly semanticCandidateLimit?: number;
      readonly lexicalCandidateLimit?: number;
      readonly lexicalProfile?: "voce" | "lente";
      readonly resultShape?: "chunks" | "notes";
    }
  ): readonly SqliteHit[] {
    const noteShape = options.resultShape === "notes" || options.lexicalProfile === "lente";
    const semanticLimit = Math.min(
      SQLITE_MAX_RESULTS,
      Math.max(0, options.semanticCandidateLimit ?? limit)
    );
    const lexicalLimit = Math.min(
      SQLITE_MAX_RESULTS,
      Math.max(0, options.lexicalCandidateLimit ?? limit)
    );
    const semantic: SqliteHit[] = [];
    if (vector && semanticLimit) {
      const q = normalizedVector(vector, this.dimensions);
      const current = currentPath
        ? rows(this.db, "SELECT note_id FROM notes WHERE path=?", [currentPath])[0]
        : undefined;
      const bind: unknown[] = [];
      let sql = `SELECT o.occurrence_id AS occurrenceId,o.chunk_id AS id,o.ordinal,o.start_line AS startLine,o.end_line AS endLine,
                        o.display_text AS text,r.content_id AS contentId,n.note_id AS noteId,n.path,ec.vector
                 FROM chunk_occurrences o JOIN notes n ON n.note_id=o.note_id AND n.semantic_revision_id=o.revision_id
                 JOIN note_revisions r ON r.revision_id=o.revision_id
                 JOIN embedding_inputs ei ON ei.action_key=o.embedding_input_digest
                 JOIN embedding_cache ec ON ec.input_digest=ei.action_key
                    AND ec.embedding_fingerprint=? AND ec.preprocessing=?`;
      bind.push(this.embeddingFingerprint, EMBEDDING_PREPROCESSING_VERSION);
      if (current) {
        sql += " WHERE n.note_id<>?";
        bind.push(Number(current.note_id));
      }
      const candidates = rows(this.db, sql, bind).map((row) => {
        const x = vectorOf(row.vector);
        let score = 0;
        for (let i = 0; i < q.length; i++) score += q[i] * x[i];
        return { row, score };
      });
      candidates.sort(
        (a, b) =>
          b.score - a.score ||
          compareCodeUnits(String(a.row.path), String(b.row.path)) ||
          Number(a.row.ordinal) - Number(b.row.ordinal) ||
          compareCodeUnits(String(a.row.id), String(b.row.id))
      );
      const seen = new Set<string>();
      for (const item of candidates) {
        const path = String(item.row.path);
        if (noteShape && seen.has(path)) continue;
        seen.add(path);
        semantic.push({
          id: String(item.row.id),
          path,
          contentId: String(item.row.contentId),
          ordinal: Number(item.row.ordinal),
          score: item.score,
          semanticScore: item.score,
          text: String(item.row.text),
          startLine: Number(item.row.startLine),
          endLine: Number(item.row.endLine),
        });
        if (semantic.length >= semanticLimit) break;
      }
    }
    const lexical: SqliteHit[] = [];
    const expression = query
      ? [...new Set(literalTerms(query))]
          .slice(0, 64)
          .map((term) => `"${term.replace(/"/g, '""')}"`)
          .join(" OR ")
      : "";
    if (expression && lexicalLimit) {
      const scoped = options.lexicalProfile === "voce" ? `body:(${expression})` : expression;
      const bind: unknown[] = [scoped];
      let sql = `SELECT o.chunk_id AS id,o.ordinal,o.start_line AS startLine,o.end_line AS endLine,o.display_text AS text,
                        r.content_id AS contentId,n.path,n.note_id,bm25(active_lexical_fts,1,2,3) AS rank
                 FROM active_lexical_fts f JOIN active_lexical a ON a.occurrence_id=f.rowid
                 JOIN chunk_occurrences o ON o.occurrence_id=a.occurrence_id JOIN notes n ON n.note_id=a.note_id
                 JOIN note_revisions r ON r.revision_id=a.revision_id
                 WHERE active_lexical_fts MATCH ?`;
      if (currentPath) {
        sql += " AND n.path<>?";
        bind.push(currentPath);
      }
      const raw = rows(this.db, sql, bind);
      raw.sort(
        (a, b) =>
          Number(a.rank) - Number(b.rank) ||
          compareCodeUnits(String(a.path), String(b.path)) ||
          Number(a.ordinal) - Number(b.ordinal) ||
          compareCodeUnits(String(a.id), String(b.id))
      );
      const minRank = Number(raw[0]?.rank ?? 0);
      const seen = new Set<string>();
      for (const row of raw) {
        const path = String(row.path);
        if (noteShape && seen.has(path)) continue;
        seen.add(path);
        const rank = Number(row.rank);
        const score = minRank < 0 ? rank / minRank : (1 + minRank) / (1 + rank);
        lexical.push({
          id: String(row.id),
          path,
          contentId: String(row.contentId),
          ordinal: Number(row.ordinal),
          score,
          lexicalScore: score,
          text: String(row.text),
          startLine: Number(row.startLine),
          endLine: Number(row.endLine),
        });
        if (lexical.length >= lexicalLimit) break;
      }
    }
    if (!semantic.length) return lexical.slice(0, limit);
    if (!lexical.length) return semantic.slice(0, limit);
    const fused = new Map<string, SqliteHit & { fused: number; rank: number }>();
    semantic.forEach((h, i) => {
      const fusedScore = 1 / (RRF_K + i + 1);
      fused.set(noteShape ? h.path : h.id, { ...h, fused: fusedScore, fusedScore, rank: i });
    });
    lexical.forEach((h, i) => {
      const key = noteShape ? h.path : h.id;
      const prior = fused.get(key);
      const add = 1 / (RRF_K + i + 1);
      if (prior)
        fused.set(key, {
          ...prior,
          fused: prior.fused + add,
          fusedScore: prior.fused + add,
          lexicalScore: h.lexicalScore,
        });
      else fused.set(key, { ...h, fused: add, rank: i, fusedScore: add });
    });
    return [...fused.values()]
      .sort(
        (a, b) =>
          b.fused - a.fused ||
          compareCodeUnits(a.path, b.path) ||
          a.ordinal - b.ordinal ||
          compareCodeUnits(a.id, b.id)
      )
      .slice(0, limit);
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
    return this.retrieveRevisionHeads(query, vector, resultLimit, currentPath, options);
  }
  findRelated(path: string, vector: Float32Array | undefined, limit: number): readonly SqliteHit[] {
    let q = vector;
    if (!q) {
      const sum = new Float64Array(this.dimensions);
      let count = 0;
      this.db.exec({
        sql: `SELECT ec.vector FROM chunk_occurrences o JOIN notes n ON n.note_id=o.note_id AND n.semantic_revision_id=o.revision_id
              JOIN embedding_inputs ei ON ei.action_key=o.embedding_input_digest
              JOIN embedding_cache ec ON ec.input_digest=ei.action_key AND ec.embedding_fingerprint=? AND ec.preprocessing=?
              WHERE n.path=? ORDER BY o.ordinal,o.occurrence_id`,
        bind: [this.embeddingFingerprint, EMBEDDING_PREPROCESSING_VERSION, path],
        rowMode: "object",
        callback: (row) => {
          const x = vectorOf(row.vector);
          if (x.length !== sum.length)
            throw sqliteError("integrity_failed", "Stored vector dimensions mismatch");
          for (let i = 0; i < x.length; i++) sum[i] += x[i];
          count++;
        },
      });
      if (!count) return [];
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
      "SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') AND name IN ('index_state','notes','note_revisions','chunk_occurrences','embedding_inputs','embedding_cache','active_lexical','active_lexical_fts')"
    );
    if (
      app !== SQLITE_APPLICATION_ID ||
      version !== SQLITE_SCHEMA_VERSION ||
      required.length !== 8 ||
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
    this.validatePointerOwnership();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lexicalRuns.clear();
    this.db.close();
  }
  finalizePublication(
    publicationId: string,
    expectedChangeCounter: number,
    expectedLexicalGeneration?: number,
    expectedSemanticGeneration?: number
  ): SqliteState | undefined {
    const generation = rows(
      this.db,
      "SELECT change_counter AS changeCounter,lexical_generation AS lexicalGeneration,semantic_generation AS semanticGeneration FROM index_state WHERE id=1"
    )[0];
    if (
      !generation ||
      Number(generation.changeCounter) !== expectedChangeCounter ||
      (expectedLexicalGeneration !== undefined &&
        Number(generation.lexicalGeneration) !== expectedLexicalGeneration) ||
      (expectedSemanticGeneration !== undefined &&
        Number(generation.semanticGeneration) !== expectedSemanticGeneration)
    )
      throw sqliteError(
        "busy",
        "Publication is stale; local changes require a new publication.",
        true
      );
    transaction(this.db, () =>
      this.db.exec({
        sql: `UPDATE index_state SET publication_id=?
              WHERE id=1 AND change_counter=?
                AND (? IS NULL OR lexical_generation=?)
                AND (? IS NULL OR semantic_generation=?)`,
        bind: [
          publicationId,
          expectedChangeCounter,
          expectedLexicalGeneration ?? null,
          expectedLexicalGeneration ?? null,
          expectedSemanticGeneration ?? null,
          expectedSemanticGeneration ?? null,
        ],
      })
    );
    const state = this.getState();
    if (
      state.publicationId !== publicationId ||
      state.changeCounter !== expectedChangeCounter ||
      (expectedLexicalGeneration !== undefined &&
        state.lexicalGeneration !== expectedLexicalGeneration) ||
      (expectedSemanticGeneration !== undefined &&
        state.semanticGeneration !== expectedSemanticGeneration)
    )
      return undefined;
    return state;
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
  private markMutation(incomplete = true): void {
    this.db.exec({
      sql: "UPDATE index_state SET incomplete=CASE WHEN ? THEN 1 ELSE incomplete END,change_counter=change_counter+1 WHERE id=1",
      bind: [incomplete ? 1 : 0],
    });
  }
  private readChangeCounter(): number {
    const row = rows(this.db, "SELECT change_counter FROM index_state WHERE id=1")[0];
    if (!row) throw sqliteError("incompatible_state", "SQLite state is not initialized");
    return Number(row.change_counter);
  }
  private readStateFlag(column: "incomplete"): boolean {
    const row = rows(this.db, `SELECT ${column} FROM index_state WHERE id=1`)[0];
    if (!row) throw sqliteError("incompatible_state", "SQLite state is not initialized");
    return Number(row[column]) !== 0;
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
