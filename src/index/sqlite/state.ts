import type { SqliteState } from "./protocol";
import { sqliteError } from "./protocol";
import { SQLITE_BUILD_IDENTITY } from "../../build/identity";
import {
  SQLITE_APPLICATION_ID,
  SQLITE_PROTOCOL_VERSION,
  SQLITE_SCHEMA_VERSION,
  schemaSql,
} from "./schema";
import {
  APP_VERSION,
  CHUNK_ALGORITHM_VERSION,
  EMBEDDING_PREPROCESSING_VERSION,
  EXTRACTION_VERSION,
  rows,
  type SqliteContext,
  transaction,
} from "./core";

export class SqliteStateStore {
  constructor(private readonly context: SqliteContext) {}

  boot(
    corpusFingerprint: string,
    dimensions: number,
    embeddingFingerprint = "",
    buildIdentity: string = SQLITE_BUILD_IDENTITY
  ): SqliteState {
    this.context.ensureOpen();
    this.context.dimensions = dimensions;
    this.context.embeddingFingerprint = embeddingFingerprint;
    const app = Number(rows(this.context.db, "PRAGMA application_id")[0]?.application_id ?? 0);
    const version = Number(rows(this.context.db, "PRAGMA user_version")[0]?.user_version ?? 0);
    if (app === 0 && version === 0) {
      const existing = Number(
        rows(
          this.context.db,
          "SELECT count(*) AS count FROM sqlite_master WHERE name IN ('index_state','notes','note_revisions','embedding_inputs','chunk_occurrences','embedding_cache')"
        )[0]?.count ?? 0
      );
      if (existing) throw sqliteError("integrity_failed", "SQLite database metadata is corrupt");
      this.context.db.exec(schemaSql(dimensions));
      transaction(this.context.db, () =>
        this.context.db.exec({
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
      this.context.db.exec(schemaSql(dimensions));
      const state = rows(this.context.db, "SELECT * FROM index_state WHERE id=1")[0];
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
        transaction(this.context.db, () =>
          this.context.db.exec({
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
      const object = rows(this.context.db, "SELECT type FROM sqlite_master WHERE name=?", [
        table,
      ])[0];
      if (!object || object.type !== "table")
        throw sqliteError("incompatible_state", "SQLite schema layout is incompatible", false);
      const actual = new Set(
        rows(this.context.db, `PRAGMA table_info(${table})`).map((row) => String(row.name))
      );
      if (columns.some((column) => !actual.has(column)))
        throw sqliteError("incompatible_state", "SQLite schema layout is incompatible", false);
    }
    const ftsSql = String(
      rows(this.context.db, "SELECT sql FROM sqlite_master WHERE name='active_lexical_fts'")[0]
        ?.sql ?? ""
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
      const entry = rows(this.context.db, `PRAGMA index_list(${expected.table})`).find(
        (row) => String(row.name) === name
      );
      const columns = entry
        ? rows(this.context.db, `PRAGMA index_info(${name})`).map((row) => String(row.name))
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
    this.context.ensureOpen();
    const s = rows(this.context.db, "SELECT * FROM index_state WHERE id=1")[0];
    if (!s) throw sqliteError("incompatible_state", "SQLite state is not initialized");
    const c = rows(
      this.context.db,
      `SELECT (SELECT count(*) FROM notes WHERE lexical_revision_id IS NOT NULL) AS notes,
              (SELECT count(*) FROM chunk_occurrences o JOIN notes n ON n.note_id=o.note_id AND n.lexical_revision_id=o.revision_id) AS chunks,
              (SELECT count(*) FROM embedding_cache WHERE embedding_fingerprint=?) AS vectors`,
      [String(s.embedding_fingerprint)]
    )[0];
    const heads = rows(
      this.context.db,
      `SELECT count(*) AS eligible,
              sum(CASE WHEN n.semantic_revision_id IS NOT NULL THEN 1 ELSE 0 END) AS semanticHeads,
              sum(CASE WHEN n.semantic_revision_id=n.lexical_revision_id THEN 1 ELSE 0 END) AS currentSemanticHeads,
              sum(CASE WHEN EXISTS (SELECT 1 FROM chunk_occurrences eo WHERE eo.note_id=n.note_id AND eo.revision_id=n.lexical_revision_id) THEN 1 ELSE 0 END) AS nonempty,
              sum(CASE WHEN n.semantic_revision_id=n.lexical_revision_id THEN 0 ELSE 1 END) AS lagging
       FROM notes n WHERE n.lexical_revision_id IS NOT NULL`
    )[0];
    const missing = rows(
      this.context.db,
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
      Number(rows(this.context.db, "SELECT count(*) AS count FROM active_lexical")[0]?.count ?? 0) >
        0;
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
    this.context.ensureOpen();
    const row = rows(this.context.db, "SELECT corpus_fingerprint FROM index_state WHERE id=1")[0];
    if (!row) throw sqliteError("incompatible_state", "SQLite state is not initialized");
    return String(row.corpus_fingerprint);
  }
  /** Validate active head ownership without changing any rows. */
  markIncomplete(): SqliteState {
    this.context.ensureOpen();
    if (!this.readStateFlag("incomplete"))
      transaction(this.context.db, () =>
        this.context.db.exec(
          "UPDATE index_state SET incomplete=1,change_counter=change_counter+1 WHERE id=1"
        )
      );
    return this.getState();
  }

  private readStateFlag(column: "incomplete"): boolean {
    const row = rows(this.context.db, `SELECT ${column} FROM index_state WHERE id=1`)[0];
    if (!row) throw sqliteError("incompatible_state", "SQLite state is not initialized");
    return Number(row[column]) !== 0;
  }
}
