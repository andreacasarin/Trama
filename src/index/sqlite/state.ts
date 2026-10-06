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

import { pruneUnreferencedRevisions } from "./lexical-full-note";

export class SqliteStateStore {
  constructor(private readonly context: SqliteContext) {}

  boot(
    corpusFingerprint: string,
    dimensions: number,
    embeddingFingerprint = "",
    buildIdentity: string = SQLITE_BUILD_IDENTITY,
    profileMetadata: { readonly modelId?: string; readonly endpointOrigin?: string } = {}
  ): SqliteState {
    this.context.ensureOpen();
    let activeFingerprint = embeddingFingerprint;
    let activeDimensions = dimensions;
    this.context.configuredEmbeddingFingerprint = embeddingFingerprint;
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
          sql: "INSERT INTO index_state(id,app_version,schema_version,protocol_version,build_identity,extraction_version,chunk_algorithm_version,embedding_input_version,dimensions,corpus_fingerprint,embedding_fingerprint,incomplete,change_counter) VALUES(1,?,?,?,?,?,?,?,?,?, ?,1,0)",
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
      if (activeFingerprint)
        this.saveEmbeddingProfile(activeFingerprint, dimensions, profileMetadata);
    } else {
      const currentVersion = Number(
        rows(this.context.db, "PRAGMA user_version")[0]?.user_version ?? 0
      );
      if (app !== SQLITE_APPLICATION_ID || currentVersion !== SQLITE_SCHEMA_VERSION)
        throw sqliteError(
          "incompatible_state",
          `SQLite database schema/build is incompatible (expected schema ${SQLITE_SCHEMA_VERSION}).`,
          false
        );
      this.assertSchemaLayout();
      this.context.db.exec(schemaSql(dimensions));
      const state = rows(this.context.db, "SELECT * FROM index_state WHERE id=1")[0];
      if (!embeddingFingerprint) {
        const profiles = rows(
          this.context.db,
          "SELECT fingerprint,dimensions FROM embedding_profiles ORDER BY fingerprint"
        );
        const saved = profiles.find(
          (profile) => String(profile.fingerprint) === String(state?.embedding_fingerprint ?? "")
        );
        if (saved) {
          activeFingerprint = String(saved.fingerprint);
          activeDimensions = Number(saved.dimensions);
        } else if (profiles.length === 1) {
          activeFingerprint = String(profiles[0].fingerprint);
          activeDimensions = Number(profiles[0].dimensions);
        } else {
          activeFingerprint = "";
        }
      } else {
        this.saveEmbeddingProfile(embeddingFingerprint, dimensions, profileMetadata);
        // Keep the old space fenced off until an explicit semantic rebuild.
        if (
          state?.embedding_fingerprint &&
          String(state.embedding_fingerprint) !== embeddingFingerprint
        ) {
          activeFingerprint = String(state.embedding_fingerprint);
          activeDimensions = Number(state.dimensions);
        }
      }
      this.context.dimensions = activeDimensions;
      this.context.embeddingFingerprint = activeFingerprint;
      if (
        !state ||
        Number(state.protocol_version) !== SQLITE_PROTOCOL_VERSION ||
        String(state.build_identity) !== buildIdentity
      )
        throw sqliteError(
          "incompatible_state",
          "SQLite database build identity is incompatible.",
          false
        );
      const changedCorpus = String(state.corpus_fingerprint) !== corpusFingerprint;
      const changedEmbedding = String(state.embedding_fingerprint) !== activeFingerprint;
      const changedDimensions = Number(state.dimensions) !== activeDimensions;
      if (changedCorpus || changedEmbedding || changedDimensions)
        transaction(this.context.db, () =>
          this.context.db.exec({
            sql: "UPDATE index_state SET corpus_fingerprint=?,embedding_fingerprint=?,dimensions=?,incomplete=CASE WHEN ? THEN 1 ELSE incomplete END,change_counter=change_counter+? WHERE id=1",
            bind: [
              corpusFingerprint,
              activeFingerprint,
              activeDimensions,
              changedCorpus ? 1 : 0,
              changedCorpus || changedEmbedding || changedDimensions ? 1 : 0,
            ],
          })
        );
    }
    this.context.dimensions = activeDimensions;
    this.context.embeddingFingerprint = activeFingerprint;
    return this.getState();
  }

  private saveEmbeddingProfile(
    fingerprint: string,
    dimensions: number,
    metadata: { readonly modelId?: string; readonly endpointOrigin?: string }
  ): void {
    this.context.db.exec({
      sql: `INSERT INTO embedding_profiles(fingerprint,dimensions,model_id,endpoint_origin)
            VALUES(?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET
              dimensions=excluded.dimensions,
              model_id=CASE WHEN excluded.model_id='' THEN embedding_profiles.model_id ELSE excluded.model_id END,
              endpoint_origin=CASE WHEN excluded.endpoint_origin='' THEN embedding_profiles.endpoint_origin ELSE excluded.endpoint_origin END`,
      bind: [fingerprint, dimensions, metadata.modelId ?? "", metadata.endpointOrigin ?? ""],
    });
  }

  selectEmbeddingProfile(fingerprint: string): SqliteState {
    this.context.ensureOpen();
    if (
      !this.context.configuredEmbeddingFingerprint ||
      fingerprint !== this.context.configuredEmbeddingFingerprint
    )
      throw sqliteError(
        "invalid_request",
        "Rebuild using the embedding model configured in settings."
      );
    const profile = rows(
      this.context.db,
      "SELECT dimensions FROM embedding_profiles WHERE fingerprint=?",
      [fingerprint]
    )[0];
    if (!profile) throw sqliteError("invalid_request", "Configured embedding model is unavailable");
    const dimensions = Number(profile.dimensions);
    transaction(this.context.db, () => {
      this.context.db.exec("UPDATE notes SET semantic_revision_id=NULL");
      pruneUnreferencedRevisions(this.context.db);
      this.context.db.exec("DELETE FROM embedding_cache");
      this.context.db.exec({
        sql: "DELETE FROM embedding_profiles WHERE fingerprint<>?",
        bind: [fingerprint],
      });
      this.context.db.exec("DELETE FROM cache_shard_membership");
      this.context.db.exec("DELETE FROM cache_artifact_receipts");
      this.context.db.exec("DELETE FROM cache_compaction_retirements");
      this.context.db.exec("DELETE FROM cache_compaction_replacements");
      this.context.db.exec("UPDATE cache_compaction_state SET last_completed_at=0 WHERE id=1");
      this.context.db.exec({
        sql: "UPDATE index_state SET embedding_fingerprint=?,dimensions=?,semantic_generation=semantic_generation+1,change_counter=change_counter+1 WHERE id=1",
        bind: [fingerprint, dimensions],
      });
    });
    this.context.embeddingFingerprint = fingerprint;
    this.context.dimensions = dimensions;
    return this.getState();
  }
  reconcileImportedEmbeddingProfiles(): void {
    if (this.context.embeddingFingerprint) return;
    const profiles = rows(
      this.context.db,
      "SELECT fingerprint,dimensions FROM embedding_profiles LIMIT 2"
    );
    if (profiles.length !== 1) return;
    const fingerprint = String(profiles[0].fingerprint);
    const dimensions = Number(profiles[0].dimensions);
    this.context.db.exec({
      sql: "UPDATE index_state SET embedding_fingerprint=?,dimensions=?,change_counter=change_counter+1 WHERE id=1",
      bind: [fingerprint, dimensions],
    });
    this.context.embeddingFingerprint = fingerprint;
    this.context.dimensions = dimensions;
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
        "embedding_input_digest",
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
        "task_kind",
        "unused_since",
        "created_at",
      ],
      embedding_profiles: ["fingerprint", "dimensions", "model_id", "endpoint_origin"],
      cache_artifact_receipts: ["digest", "profile", "received_at"],
      cache_shard_membership: ["digest", "action_key", "task_kind", "profile"],
      cache_compaction_state: ["id", "last_completed_at"],
      cache_compaction_retirements: ["source_digest", "replacement_set_id", "retire_after"],
      cache_compaction_replacements: ["replacement_set_id", "digest"],
      lexical_notes: [
        "note_id",
        "revision_id",
        "path_text",
        "filename",
        "title",
        "headings",
        "body",
      ],
      lexical_notes_fts: ["body", "path_text", "filename", "title", "headings"],
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
    const noteFtsSql = String(
      rows(this.context.db, "SELECT sql FROM sqlite_master WHERE name='lexical_notes_fts'")[0]
        ?.sql ?? ""
    ).toLowerCase();
    if (
      !noteFtsSql.includes("using fts5") ||
      !noteFtsSql.includes("content='lexical_notes'") ||
      !noteFtsSql.includes("content_rowid='note_id'") ||
      !noteFtsSql.includes("tokenize='unicode61 remove_diacritics 2'") ||
      Number(
        rows(
          this.context.db,
          "SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name IN ('lexical_notes_ai','lexical_notes_ad','lexical_notes_au')"
        )[0]?.count ?? 0
      ) !== 3
    )
      throw sqliteError("incompatible_state", "SQLite full-note FTS layout is incompatible", false);
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
        columns: ["input_digest", "embedding_fingerprint", "preprocessing", "task_kind"],
      },
      lexical_notes_revision: { table: "lexical_notes", columns: ["revision_id"] },
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
              (SELECT count(*) FROM embedding_cache WHERE embedding_fingerprint=? AND task_kind='document') AS vectors`,
      [String(s.embedding_fingerprint)]
    )[0];
    const heads = rows(
      this.context.db,
      `SELECT count(*) AS eligible,
              sum(CASE WHEN n.semantic_revision_id IS NOT NULL THEN 1 ELSE 0 END) AS semanticHeads,
              count(DISTINCT CASE WHEN n.semantic_revision_id IS NOT NULL AND EXISTS (
                SELECT 1
                FROM chunk_occurrences so
                JOIN embedding_cache sec ON sec.input_digest=so.embedding_input_digest
                  AND sec.embedding_fingerprint=? AND sec.preprocessing=? AND sec.task_kind='document'
                WHERE so.note_id=n.note_id AND so.revision_id=n.semantic_revision_id
              ) THEN n.note_id END) AS usableSemanticHeads,
              sum(CASE WHEN n.semantic_revision_id=n.lexical_revision_id THEN 1 ELSE 0 END) AS currentSemanticHeads,
              sum(CASE WHEN EXISTS (SELECT 1 FROM chunk_occurrences eo WHERE eo.note_id=n.note_id AND eo.revision_id=n.lexical_revision_id) THEN 1 ELSE 0 END) AS nonempty,
              sum(CASE WHEN n.semantic_revision_id=n.lexical_revision_id THEN 0 ELSE 1 END) AS lagging
       FROM notes n
       WHERE n.lexical_revision_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM chunk_occurrences eo
           WHERE eo.note_id=n.note_id AND eo.revision_id=n.lexical_revision_id
         )`,
      [String(s.embedding_fingerprint), EMBEDDING_PREPROCESSING_VERSION]
    )[0];
    const missing = rows(
      this.context.db,
      `SELECT count(DISTINCT ei.action_key) AS missing
       FROM chunk_occurrences o
       JOIN notes n ON n.note_id=o.note_id AND n.lexical_revision_id=o.revision_id
       JOIN embedding_inputs ei ON ei.action_key=o.embedding_input_digest
       LEFT JOIN embedding_cache ec ON ec.input_digest=ei.action_key AND ec.embedding_fingerprint=? AND ec.preprocessing=? AND ec.task_kind='document'
       WHERE ec.cache_id IS NULL`,
      [String(s.embedding_fingerprint), EMBEDDING_PREPROCESSING_VERSION]
    )[0];
    const chunks = Number(c.chunks);
    const rebuildRequired = Boolean(
      this.context.configuredEmbeddingFingerprint &&
      this.context.configuredEmbeddingFingerprint !== String(s.embedding_fingerprint)
    );
    const compatible = rebuildRequired ? 0 : Number(c.vectors);
    const coverage = compatible === 0 ? "none" : compatible === chunks ? "complete" : "partial";
    return {
      schemaVersion: Number(s.schema_version),
      protocolVersion: Number(s.protocol_version),
      buildIdentity: String(s.build_identity),
      dimensions: Number(s.dimensions),
      corpusFingerprint: String(s.corpus_fingerprint),
      embeddingFingerprint: String(s.embedding_fingerprint),
      semanticRebuildRequired: rebuildRequired,
      incomplete: Number(s.incomplete) !== 0,
      changeCounter: Number(s.change_counter),
      lexicalGeneration: Number(s.lexical_generation),
      semanticGeneration: Number(s.semantic_generation),
      noteCount: Number(c.notes),
      chunkCount: chunks,
      compatibleVectorCount: compatible,
      vectorCount: compatible,
      vectorCoverage: coverage,
      semanticReady:
        !rebuildRequired &&
        Number(heads.eligible ?? 0) > 0 &&
        Number(heads.eligible ?? 0) === Number(heads.semanticHeads ?? 0) &&
        Number(heads.eligible ?? 0) === Number(heads.currentSemanticHeads ?? 0) &&
        Number(heads.nonempty ?? 0) > 0 &&
        Number(missing.missing ?? 0) === 0 &&
        !Number(s.incomplete),
      semanticEligibleCount: Number(heads.eligible ?? 0),
      semanticHeadCount: rebuildRequired ? 0 : Number(heads.usableSemanticHeads ?? 0),
      semanticLagCount: Number(heads.lagging ?? 0),
      semanticMissingCount: Number(missing.missing ?? 0),
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
