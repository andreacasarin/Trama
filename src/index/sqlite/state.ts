import type { EmbeddingProfile, SqliteState } from "./protocol";
import { sqliteError } from "./protocol";
import {
  SQLITE_BUILD_IDENTITY,
  SQLITE_SCHEMA_11_BUILD_IDENTITY,
  SQLITE_SCHEMA_12_BUILD_IDENTITY,
  SQLITE_SCHEMA_13_BUILD_IDENTITY,
  SQLITE_SCHEMA_9_BUILD_IDENTITY,
  SQLITE_SCHEMA_10_BUILD_IDENTITY,
} from "../../build/identity";
import {
  SQLITE_APPLICATION_ID,
  SQLITE_PROTOCOL_VERSION,
  SQLITE_LEXICAL_NOTES_MIGRATION_SQL,
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
    buildIdentity: string = SQLITE_BUILD_IDENTITY,
    profileMetadata: { readonly modelId?: string; readonly endpointOrigin?: string } = {}
  ): SqliteState {
    this.context.ensureOpen();
    let activeFingerprint = embeddingFingerprint;
    let activeDimensions = dimensions;
    let selectionKind = embeddingFingerprint ? "configured" : "none";
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
      if (activeFingerprint)
        this.saveEmbeddingProfile(activeFingerprint, dimensions, profileMetadata);
      this.context.db.exec({
        sql: "UPDATE index_state SET embedding_profile_selection=? WHERE id=1",
        bind: [selectionKind],
      });
    } else {
      if (app === SQLITE_APPLICATION_ID && version === 9) {
        this.migrateSchema9(buildIdentity);
      }
      if (app === SQLITE_APPLICATION_ID && version === 10) {
        this.migrateSchema10(buildIdentity);
      }
      if (app === SQLITE_APPLICATION_ID && version === 11) {
        this.migrateSchema11(buildIdentity);
      }
      if (app === SQLITE_APPLICATION_ID && version === 12) {
        this.migrateSchema12(buildIdentity);
      }
      if (app === SQLITE_APPLICATION_ID && version === 13) {
        this.migrateSchema13(buildIdentity);
      }
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
        if (state?.embedding_profile_selection === "user" && saved) {
          activeFingerprint = String(saved.fingerprint);
          activeDimensions = Number(saved.dimensions);
        } else if (profiles.length === 1) {
          activeFingerprint = String(profiles[0].fingerprint);
          activeDimensions = Number(profiles[0].dimensions);
          selectionKind = "automatic";
        } else {
          activeFingerprint = "";
          selectionKind = "none";
        }
      } else {
        this.saveEmbeddingProfile(embeddingFingerprint, dimensions, profileMetadata);
        selectionKind = "configured";
      }
      this.context.dimensions = activeDimensions;
      this.context.embeddingFingerprint = activeFingerprint;
      if (
        !state ||
        Number(state.protocol_version) !== SQLITE_PROTOCOL_VERSION ||
        String(state.build_identity) !== buildIdentity ||
        ![0, 1].includes(Number(state.snapshot_loaded))
      )
        throw sqliteError(
          "incompatible_state",
          "SQLite database build identity is incompatible.",
          false
        );
      const changedCorpus = String(state.corpus_fingerprint) !== corpusFingerprint;
      const changedEmbedding = String(state.embedding_fingerprint) !== activeFingerprint;
      const changedDimensions = Number(state.dimensions) !== activeDimensions;
      const changedSelection = String(state.embedding_profile_selection) !== selectionKind;
      if (changedCorpus || changedEmbedding || changedDimensions || changedSelection)
        transaction(this.context.db, () =>
          this.context.db.exec({
            sql: "UPDATE index_state SET corpus_fingerprint=?,embedding_fingerprint=?,dimensions=?,embedding_profile_selection=?,incomplete=CASE WHEN ? THEN 1 ELSE incomplete END,change_counter=change_counter+? WHERE id=1",
            bind: [
              corpusFingerprint,
              activeFingerprint,
              activeDimensions,
              selectionKind,
              changedCorpus ? 1 : 0,
              changedCorpus || changedEmbedding || changedDimensions || changedSelection ? 1 : 0,
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
    const profile = rows(
      this.context.db,
      `SELECT p.dimensions FROM embedding_profiles p
       WHERE p.fingerprint=? AND EXISTS(SELECT 1 FROM embedding_cache ec
         WHERE ec.embedding_fingerprint=p.fingerprint AND ec.task_kind='document')`,
      [fingerprint]
    )[0];
    if (!profile)
      throw sqliteError("invalid_request", "Embedding profile has no compatible document vectors");
    const dimensions = Number(profile.dimensions);
    transaction(this.context.db, () =>
      this.context.db.exec({
        sql: "UPDATE index_state SET embedding_fingerprint=?,dimensions=?,embedding_profile_selection='user',change_counter=change_counter+1 WHERE id=1",
        bind: [fingerprint, dimensions],
      })
    );
    this.context.embeddingFingerprint = fingerprint;
    this.context.dimensions = dimensions;
    return this.getState();
  }
  reconcileImportedEmbeddingProfiles(): SqliteState {
    const state = rows(
      this.context.db,
      "SELECT embedding_fingerprint,embedding_profile_selection FROM index_state WHERE id=1"
    )[0];
    if (!state) return this.getState();
    const profiles = rows(
      this.context.db,
      `SELECT p.fingerprint,p.dimensions FROM embedding_profiles p
       WHERE EXISTS(SELECT 1 FROM embedding_cache ec WHERE ec.embedding_fingerprint=p.fingerprint AND ec.task_kind='document')
       ORDER BY p.fingerprint`
    );
    const selection = String(state.embedding_profile_selection);
    const active = String(state.embedding_fingerprint);
    let next = active;
    let kind = selection;
    let dimensions = this.context.dimensions;
    if (selection === "automatic" && profiles.length !== 1) {
      next = "";
      kind = "none";
    } else if (selection === "none" && profiles.length === 1) {
      next = String(profiles[0].fingerprint);
      kind = "automatic";
      dimensions = Number(profiles[0].dimensions);
    }
    if (next !== active || kind !== selection) {
      transaction(this.context.db, () =>
        this.context.db.exec({
          sql: "UPDATE index_state SET embedding_fingerprint=?,dimensions=?,embedding_profile_selection=?,change_counter=change_counter+1 WHERE id=1",
          bind: [next, dimensions, kind],
        })
      );
      this.context.embeddingFingerprint = next;
      this.context.dimensions = dimensions;
    }
    return this.getState();
  }
  migrateLegacySnapshotSchema(buildIdentity: string): void {
    const app = Number(rows(this.context.db, "PRAGMA application_id")[0]?.application_id ?? 0);
    const version = Number(rows(this.context.db, "PRAGMA user_version")[0]?.user_version ?? 0);
    if (app === SQLITE_APPLICATION_ID && version === 9) this.migrateSchema9(buildIdentity);
    if (app === SQLITE_APPLICATION_ID && version === 10) this.migrateSchema10(buildIdentity);
    if (app === SQLITE_APPLICATION_ID && version === 11) this.migrateSchema11(buildIdentity);
    if (app === SQLITE_APPLICATION_ID && version === 12) this.migrateSchema12(buildIdentity);
    if (app === SQLITE_APPLICATION_ID && version === 13) this.migrateSchema13(buildIdentity);
  }

  private migrateSchema13(buildIdentity: string): void {
    const legacy = rows(this.context.db, "SELECT * FROM index_state WHERE id=1")[0];
    if (
      !legacy ||
      Number(legacy.schema_version) !== 13 ||
      Number(legacy.protocol_version) !== 12 ||
      String(legacy.build_identity) !== SQLITE_SCHEMA_13_BUILD_IDENTITY
    )
      throw sqliteError("incompatible_state", "Legacy SQLite state is incompatible", false);
    transaction(this.context.db, () => {
      this.dropOccurrenceLexicalIndex();
      this.context.db.exec({
        sql: "UPDATE index_state SET schema_version=?,protocol_version=?,build_identity=? WHERE id=1",
        bind: [SQLITE_SCHEMA_VERSION, SQLITE_PROTOCOL_VERSION, buildIdentity],
      });
      this.context.db.exec(`PRAGMA user_version=${SQLITE_SCHEMA_VERSION}`);
    });
  }

  private dropOccurrenceLexicalIndex(): void {
    this.context.db.exec("DROP TABLE IF EXISTS active_lexical_fts");
    this.context.db.exec("DROP INDEX IF EXISTS active_lexical_note");
    this.context.db.exec("DROP TABLE IF EXISTS active_lexical");
  }

  private migrateSchema10(buildIdentity: string): void {
    const legacy = rows(this.context.db, "SELECT * FROM index_state WHERE id=1")[0];
    if (
      !legacy ||
      Number(legacy.schema_version) !== 10 ||
      Number(legacy.protocol_version) !== 9 ||
      String(legacy.build_identity) !== SQLITE_SCHEMA_10_BUILD_IDENTITY
    )
      throw sqliteError("incompatible_state", "Legacy SQLite state is incompatible", false);
    transaction(this.context.db, () => {
      this.context.db.exec(`CREATE TABLE IF NOT EXISTS cache_artifact_receipts (
        digest TEXT PRIMARY KEY COLLATE BINARY,
        profile TEXT COLLATE BINARY NOT NULL,
        received_at INTEGER NOT NULL
      ) STRICT`);
      this.context.db.exec(
        "CREATE TABLE IF NOT EXISTS cache_legacy_sources (digest TEXT PRIMARY KEY COLLATE BINARY, extracted_at INTEGER NOT NULL) STRICT"
      );
      this.ensureEmbeddingCacheMetadataColumns();
      this.ensureEmbeddingCacheRetentionColumn();
      this.createCacheRetentionTables();
      this.createEmbeddingProfilesTable();
      this.seedCurrentEmbeddingProfile();
      this.ensureProfileSelectionColumn();
      this.context.db.exec("DROP INDEX IF EXISTS embedding_cache_lookup");
      this.context.db.exec(
        "CREATE INDEX embedding_cache_lookup ON embedding_cache(input_digest,embedding_fingerprint,preprocessing,task_kind)"
      );
      this.dropOccurrenceLexicalIndex();
      this.context.db.exec({
        sql: "UPDATE index_state SET schema_version=?,protocol_version=?,build_identity=? WHERE id=1",
        bind: [SQLITE_SCHEMA_VERSION, SQLITE_PROTOCOL_VERSION, buildIdentity],
      });
      this.context.db.exec(`PRAGMA user_version=${SQLITE_SCHEMA_VERSION}`);
    });
  }

  private migrateSchema9(buildIdentity?: string): void {
    const legacy = rows(this.context.db, "SELECT * FROM index_state WHERE id=1")[0];
    if (
      !legacy ||
      Number(legacy.schema_version) !== 9 ||
      Number(legacy.protocol_version) !== 9 ||
      String(legacy.build_identity) !== SQLITE_SCHEMA_9_BUILD_IDENTITY
    )
      throw sqliteError("incompatible_state", "Legacy SQLite state is incompatible", false);
    transaction(this.context.db, () => {
      this.context.db.exec(`CREATE TABLE IF NOT EXISTS cache_artifact_receipts (
        digest TEXT PRIMARY KEY COLLATE BINARY,
        profile TEXT COLLATE BINARY NOT NULL,
        received_at INTEGER NOT NULL
      ) STRICT`);
      this.context.db.exec(
        "CREATE TABLE IF NOT EXISTS cache_legacy_sources (digest TEXT PRIMARY KEY COLLATE BINARY, extracted_at INTEGER NOT NULL) STRICT"
      );
      this.ensureEmbeddingCacheMetadataColumns();
      this.ensureEmbeddingCacheRetentionColumn();
      this.createCacheRetentionTables();
      this.createEmbeddingProfilesTable();
      this.seedCurrentEmbeddingProfile();
      this.ensureProfileSelectionColumn();
      this.context.db.exec("DROP INDEX IF EXISTS embedding_cache_lookup");
      this.context.db.exec(
        "CREATE INDEX embedding_cache_lookup ON embedding_cache(input_digest,embedding_fingerprint,preprocessing,task_kind)"
      );
      this.context.db.exec(SQLITE_LEXICAL_NOTES_MIGRATION_SQL);
      const legacyNotes = rows(
        this.context.db,
        `SELECT n.note_id,n.lexical_revision_id,n.path,
                COALESCE((SELECT group_concat(display_text,char(10)) FROM (
                  SELECT o.display_text FROM chunk_occurrences o
                  WHERE o.note_id=n.note_id AND o.revision_id=n.lexical_revision_id
                    AND o.kind='heading' ORDER BY o.ordinal
                )), '') AS headings,
                COALESCE((SELECT group_concat(display_text,char(10)) FROM (
                  SELECT o.display_text FROM chunk_occurrences o
                  WHERE o.note_id=n.note_id AND o.revision_id=n.lexical_revision_id
                  ORDER BY o.ordinal
                )), '') AS body
         FROM notes n WHERE n.lexical_revision_id IS NOT NULL`
      );
      for (const note of legacyNotes) {
        const path = String(note.path);
        const filename = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
        const firstHeading = String(note.headings)
          .split("\n")
          .map((heading) => heading.match(/^#{1,6}[ \t]+(.+?)\s*#*$/)?.[1])
          .find(Boolean);
        this.context.db.exec({
          sql: "INSERT INTO lexical_notes(note_id,revision_id,path_text,filename,title,headings,body) VALUES(?,?,?,?,?,?,?)",
          bind: [
            Number(note.note_id),
            Number(note.lexical_revision_id),
            path,
            filename,
            firstHeading ?? filename,
            String(note.headings),
            String(note.body),
          ],
        });
      }
      this.context.db.exec(`DELETE FROM note_revisions
        WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.lexical_revision_id=note_revisions.revision_id)
          AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.semantic_revision_id=note_revisions.revision_id)`);
      this.dropOccurrenceLexicalIndex();
      this.context.db.exec({
        sql: "UPDATE index_state SET schema_version=?,protocol_version=?,build_identity=COALESCE(?,build_identity) WHERE id=1",
        bind: [SQLITE_SCHEMA_VERSION, SQLITE_PROTOCOL_VERSION, buildIdentity ?? null],
      });
      this.context.db.exec(`PRAGMA user_version=${SQLITE_SCHEMA_VERSION}`);
    });
  }

  private migrateSchema11(buildIdentity: string): void {
    const legacy = rows(this.context.db, "SELECT * FROM index_state WHERE id=1")[0];
    if (
      !legacy ||
      Number(legacy.schema_version) !== 11 ||
      Number(legacy.protocol_version) !== 10 ||
      String(legacy.build_identity) !== SQLITE_SCHEMA_11_BUILD_IDENTITY
    )
      throw sqliteError("incompatible_state", "Legacy SQLite state is incompatible", false);
    transaction(this.context.db, () => {
      this.createEmbeddingProfilesTable();
      this.seedCurrentEmbeddingProfile();
      this.ensureProfileSelectionColumn();
      this.ensureEmbeddingCacheRetentionColumn();
      this.createCacheRetentionTables();
      this.context.db.exec("DROP INDEX IF EXISTS embedding_cache_lookup");
      this.context.db.exec(
        "CREATE INDEX embedding_cache_lookup ON embedding_cache(input_digest,embedding_fingerprint,preprocessing,task_kind)"
      );
      this.dropOccurrenceLexicalIndex();
      this.context.db.exec({
        sql: "UPDATE index_state SET schema_version=?,protocol_version=?,build_identity=? WHERE id=1",
        bind: [SQLITE_SCHEMA_VERSION, SQLITE_PROTOCOL_VERSION, buildIdentity],
      });
      this.context.db.exec(`PRAGMA user_version=${SQLITE_SCHEMA_VERSION}`);
    });
  }

  private migrateSchema12(buildIdentity: string): void {
    const legacy = rows(this.context.db, "SELECT * FROM index_state WHERE id=1")[0];
    if (
      !legacy ||
      Number(legacy.schema_version) !== 12 ||
      Number(legacy.protocol_version) !== 11 ||
      String(legacy.build_identity) !== SQLITE_SCHEMA_12_BUILD_IDENTITY
    )
      throw sqliteError("incompatible_state", "Legacy SQLite state is incompatible", false);
    transaction(this.context.db, () => {
      this.ensureEmbeddingCacheRetentionColumn();
      this.createCacheRetentionTables();
      this.dropOccurrenceLexicalIndex();
      this.context.db.exec({
        sql: "UPDATE index_state SET schema_version=?,protocol_version=?,build_identity=? WHERE id=1",
        bind: [SQLITE_SCHEMA_VERSION, SQLITE_PROTOCOL_VERSION, buildIdentity],
      });
      this.context.db.exec(`PRAGMA user_version=${SQLITE_SCHEMA_VERSION}`);
    });
  }

  private createEmbeddingProfilesTable(): void {
    this.context.db.exec(`CREATE TABLE IF NOT EXISTS embedding_profiles (
      fingerprint TEXT PRIMARY KEY COLLATE BINARY,
      dimensions INTEGER NOT NULL CHECK(dimensions > 0),
      model_id TEXT NOT NULL DEFAULT '',
      endpoint_origin TEXT NOT NULL DEFAULT ''
    ) STRICT`);
  }

  private seedCurrentEmbeddingProfile(): void {
    this.context.db.exec(`INSERT INTO embedding_profiles(fingerprint,dimensions)
      SELECT embedding_fingerprint,dimensions FROM index_state
      WHERE id=1 AND embedding_fingerprint<>'' ON CONFLICT(fingerprint) DO NOTHING`);
  }

  private ensureProfileSelectionColumn(): void {
    const columns = new Set(
      rows(this.context.db, "PRAGMA table_info(index_state)").map((row) => String(row.name))
    );
    if (!columns.has("embedding_profile_selection")) {
      this.context.db.exec(
        "ALTER TABLE index_state ADD COLUMN embedding_profile_selection TEXT NOT NULL DEFAULT 'configured' CHECK(embedding_profile_selection IN ('none','automatic','configured','user'))"
      );
      this.context.db.exec(
        "UPDATE index_state SET embedding_profile_selection=CASE WHEN embedding_fingerprint='' THEN 'none' ELSE 'configured' END WHERE id=1"
      );
    }
  }
  private ensureEmbeddingCacheMetadataColumns(): void {
    const columns = new Set(
      rows(this.context.db, "PRAGMA table_info(embedding_cache)").map((row) => String(row.name))
    );
    if (!columns.has("task_kind"))
      this.context.db.exec(
        "ALTER TABLE embedding_cache ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'document'"
      );
    if (!columns.has("created_at"))
      this.context.db.exec(
        "ALTER TABLE embedding_cache ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0"
      );
  }

  private ensureEmbeddingCacheRetentionColumn(): void {
    const columns = new Set(
      rows(this.context.db, "PRAGMA table_info(embedding_cache)").map((row) => String(row.name))
    );
    if (!columns.has("unused_since"))
      this.context.db.exec("ALTER TABLE embedding_cache ADD COLUMN unused_since INTEGER");
    this.context.db.exec(
      "CREATE INDEX IF NOT EXISTS embedding_cache_unused ON embedding_cache(task_kind,unused_since,created_at)"
    );
  }

  private createCacheRetentionTables(): void {
    this.context.db.exec(`CREATE TABLE IF NOT EXISTS cache_shard_membership (
      digest TEXT NOT NULL COLLATE BINARY,
      action_key TEXT NOT NULL COLLATE BINARY,
      task_kind TEXT NOT NULL CHECK(task_kind IN ('document','query')),
      profile TEXT NOT NULL COLLATE BINARY,
      PRIMARY KEY(digest,action_key,task_kind)
    ) STRICT`);
    this.context.db.exec(
      "CREATE INDEX IF NOT EXISTS cache_shard_membership_key ON cache_shard_membership(action_key,task_kind)"
    );
    this.context.db.exec(`CREATE TABLE IF NOT EXISTS cache_compaction_state (
      id INTEGER PRIMARY KEY CHECK(id=1),last_completed_at INTEGER NOT NULL DEFAULT 0
    ) STRICT`);
    this.context.db.exec(
      "INSERT OR IGNORE INTO cache_compaction_state(id,last_completed_at) VALUES(1,0)"
    );
    this.context.db.exec(`CREATE TABLE IF NOT EXISTS cache_compaction_retirements (
      source_digest TEXT PRIMARY KEY COLLATE BINARY,
      replacement_set_id TEXT NOT NULL COLLATE BINARY,
      retire_after INTEGER NOT NULL
    ) STRICT`);
    this.context.db.exec(`CREATE TABLE IF NOT EXISTS cache_compaction_replacements (
      replacement_set_id TEXT NOT NULL COLLATE BINARY,digest TEXT NOT NULL COLLATE BINARY,
      PRIMARY KEY(replacement_set_id,digest)
    ) STRICT`);
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
        "embedding_profile_selection",
        "incomplete",
        "change_counter",
        "lexical_generation",
        "semantic_generation",
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
        "task_kind",
        "unused_since",
        "created_at",
      ],
      embedding_profiles: ["fingerprint", "dimensions", "model_id", "endpoint_origin"],
      cache_artifact_receipts: ["digest", "profile", "received_at"],
      cache_legacy_sources: ["digest", "extracted_at"],
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
    const compatible = Number(c.vectors);
    const embeddingProfiles = rows(
      this.context.db,
      `SELECT p.fingerprint,p.dimensions,p.model_id,p.endpoint_origin,
              count(ec.cache_id) AS vector_count
       FROM embedding_profiles p LEFT JOIN embedding_cache ec
         ON ec.embedding_fingerprint=p.fingerprint AND ec.task_kind='document'
       GROUP BY p.fingerprint ORDER BY p.fingerprint`
    ).map((profile): EmbeddingProfile => ({
      fingerprint: String(profile.fingerprint),
      dimensions: Number(profile.dimensions),
      modelId: String(profile.model_id),
      endpointOrigin: String(profile.endpoint_origin),
      vectorCount: Number(profile.vector_count),
    }));
    const coverage = compatible === 0 ? "none" : compatible === chunks ? "complete" : "partial";
    return {
      schemaVersion: Number(s.schema_version),
      protocolVersion: Number(s.protocol_version),
      buildIdentity: String(s.build_identity),
      dimensions: Number(s.dimensions),
      corpusFingerprint: String(s.corpus_fingerprint),
      embeddingFingerprint: String(s.embedding_fingerprint),
      embeddingProfiles,
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
      semanticReady:
        Number(heads.eligible ?? 0) > 0 &&
        Number(heads.eligible ?? 0) === Number(heads.semanticHeads ?? 0) &&
        Number(heads.eligible ?? 0) === Number(heads.currentSemanticHeads ?? 0) &&
        Number(heads.nonempty ?? 0) > 0 &&
        Number(missing.missing ?? 0) === 0 &&
        !Number(s.incomplete),
      semanticEligibleCount: Number(heads.eligible ?? 0),
      semanticHeadCount: Number(heads.usableSemanticHeads ?? 0),
      semanticLagCount: Number(heads.lagging ?? 0),
      semanticMissingCount: Number(missing.missing ?? 0),
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
