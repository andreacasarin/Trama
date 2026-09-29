import type { SqliteState } from "./protocol";
import { sqliteError } from "./protocol";
import { SQLITE_BUILD_IDENTITY } from "../../build/identity";
import { SQLITE_APPLICATION_ID, SQLITE_PROTOCOL_VERSION, SQLITE_SCHEMA_VERSION } from "./schema";
import {
  EMBEDDING_PREPROCESSING_VERSION,
  rows,
  SQLITE_VECTOR_NORMALIZATION_TOLERANCE,
  type SqliteContext,
  transaction,
  vectorOf,
} from "./core";
import type { SqliteStateStore } from "./state";

export class SqlitePublicationStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly state: SqliteStateStore
  ) {}

  validatePointerOwnership(): void {
    this.context.ensureOpen();
    const invalid = rows(
      this.context.db,
      `SELECT n.note_id FROM notes n
       LEFT JOIN note_revisions lr ON lr.revision_id=n.lexical_revision_id
       LEFT JOIN note_revisions sr ON sr.revision_id=n.semantic_revision_id
       WHERE (n.lexical_revision_id IS NOT NULL AND (lr.revision_id IS NULL OR lr.note_id<>n.note_id))
          OR (n.semantic_revision_id IS NOT NULL AND (sr.revision_id IS NULL OR sr.note_id<>n.note_id))
       LIMIT 1`
    );
    if (invalid.length || rows(this.context.db, "PRAGMA foreign_key_check").length)
      throw sqliteError("integrity_failed", "SQLite active revision pointer ownership failed");

    const ftsMismatch = rows(
      this.context.db,
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

    this.context.db.exec({
      sql: `SELECT ec.vector,ec.action_key,ec.embedding_fingerprint,ec.preprocessing,
                   ei.action_key AS input_action_key
            FROM notes n
            JOIN chunk_occurrences o ON o.revision_id=n.semantic_revision_id AND o.note_id=n.note_id
            JOIN embedding_inputs ei ON ei.action_key=o.embedding_input_digest
            LEFT JOIN embedding_cache ec
              ON ec.input_digest=ei.action_key
             AND ec.embedding_fingerprint=? AND ec.preprocessing=?
            WHERE ec.cache_id IS NULL`,
      bind: [this.context.embeddingFingerprint, EMBEDDING_PREPROCESSING_VERSION],
      rowMode: "object",
      callback: () => {
        throw sqliteError("integrity_failed", "SQLite semantic head cache coverage is incomplete");
      },
    });
    this.context.db.exec({
      sql: `SELECT vector FROM embedding_cache WHERE embedding_fingerprint=?`,
      bind: [this.context.embeddingFingerprint],
      rowMode: "object",
      callback: (row) => {
        let vector: Float32Array;
        try {
          vector = vectorOf(row.vector);
        } catch {
          throw sqliteError("integrity_failed", "SQLite cached vector bytes are invalid");
        }
        if (vector.length !== this.context.dimensions || !vector.every(Number.isFinite))
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
    this.context.ensureOpen();
    transaction(this.context.db, () => {
      this.context.db.exec({
        sql: `DELETE FROM note_revisions
              WHERE revision_id NOT IN (
                SELECT lexical_revision_id FROM notes WHERE lexical_revision_id IS NOT NULL
                UNION SELECT semantic_revision_id FROM notes WHERE semantic_revision_id IS NOT NULL
              )`,
      });
      this.context.db.exec({
        sql: `DELETE FROM embedding_inputs
              WHERE NOT EXISTS (SELECT 1 FROM chunk_occurrences o WHERE o.embedding_input_digest=embedding_inputs.action_key)`,
      });
      this.context.db.exec({
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
        bind: [this.context.embeddingFingerprint, EMBEDDING_PREPROCESSING_VERSION],
      });
    });
  }
  validateSnapshot(
    corpusFingerprint: string,
    dimensions: number,
    embeddingFingerprint = this.context.embeddingFingerprint,
    buildIdentity: string = SQLITE_BUILD_IDENTITY
  ): void {
    this.context.ensureOpen();
    this.context.dimensions = dimensions;
    this.context.embeddingFingerprint = embeddingFingerprint;
    const app = Number(rows(this.context.db, "PRAGMA application_id")[0]?.application_id ?? 0);
    const version = Number(rows(this.context.db, "PRAGMA user_version")[0]?.user_version ?? 0);
    if (app === SQLITE_APPLICATION_ID && version > SQLITE_SCHEMA_VERSION)
      throw sqliteError(
        "upgrade_required",
        "This synchronized index requires a newer Trama version. Open Obsidian Settings → Community plugins and select Check for updates."
      );
    const state = rows(this.context.db, "SELECT * FROM index_state WHERE id=1")[0];
    const required = rows(
      this.context.db,
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
      String(rows(this.context.db, "PRAGMA integrity_check")[0]?.integrity_check ?? "") !== "ok" ||
      rows(this.context.db, "PRAGMA foreign_key_check").length
    )
      throw sqliteError("integrity_failed", "SQLite publication integrity check failed");
    this.validatePointerOwnership();
  }
  finalizePublication(
    publicationId: string,
    expectedChangeCounter: number,
    expectedLexicalGeneration: number,
    expectedSemanticGeneration: number
  ): SqliteState | undefined {
    const generation = rows(
      this.context.db,
      "SELECT change_counter AS changeCounter,lexical_generation AS lexicalGeneration,semantic_generation AS semanticGeneration FROM index_state WHERE id=1"
    )[0];
    if (
      !generation ||
      Number(generation.changeCounter) !== expectedChangeCounter ||
      Number(generation.lexicalGeneration) !== expectedLexicalGeneration ||
      Number(generation.semanticGeneration) !== expectedSemanticGeneration
    )
      throw sqliteError(
        "busy",
        "Publication is stale; local changes require a new publication.",
        true
      );
    transaction(this.context.db, () =>
      this.context.db.exec({
        sql: `UPDATE index_state SET publication_id=?
              WHERE id=1 AND change_counter=?
                AND lexical_generation=?
                AND semantic_generation=?`,
        bind: [
          publicationId,
          expectedChangeCounter,
          expectedLexicalGeneration,
          expectedSemanticGeneration,
        ],
      })
    );
    const state = this.state.getState();
    if (
      state.publicationId !== publicationId ||
      state.changeCounter !== expectedChangeCounter ||
      state.lexicalGeneration !== expectedLexicalGeneration ||
      state.semanticGeneration !== expectedSemanticGeneration
    )
      return undefined;
    return state;
  }
  setPublicationId(publicationId: string): SqliteState {
    transaction(this.context.db, () =>
      this.context.db.exec({
        sql: "UPDATE index_state SET publication_id=? WHERE id=1",
        bind: [publicationId],
      })
    );
    return this.state.getState();
  }
  markSnapshotLoaded(): SqliteState {
    this.context.ensureOpen();
    transaction(this.context.db, () =>
      this.context.db.exec("UPDATE index_state SET snapshot_loaded=1 WHERE id=1")
    );
    return this.state.getState();
  }
}
