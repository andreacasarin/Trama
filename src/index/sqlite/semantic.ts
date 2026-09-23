import {
  SQLITE_MAX_SEMANTIC_BATCH_ITEMS,
  SQLITE_MAX_SEMANTIC_INPUT_BYTES,
  type SqliteEmbeddingResult,
  type SqliteSemanticCommitResult,
  type SqliteSemanticWorkBatch,
  type SqliteState,
  sqliteError,
} from "./protocol";
import { createEmbeddingActionKey, EMBEDDING_ACTION_OPTIONS } from "../Identity";
import {
  EMBEDDING_PREPROCESSING_VERSION,
  normalizedVector,
  readGenerationToken,
  rows,
  type SqliteContext,
  transaction,
  vectorBytes,
} from "./core";
import type { SqliteStateStore } from "./state";

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

export class SqliteSemanticStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly state: SqliteStateStore
  ) {}

  private hasMissingEmbeddingInputs(embeddingFingerprint: string, preprocessing: string): boolean {
    return (
      rows(
        this.context.db,
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
    this.context.ensureOpen();
    const boundedInputBytes = Math.max(1, maxInputBytes);
    let promoted = 0;
    if (promoteUnrestricted)
      transaction(this.context.db, () => {
        promoted = this.promoteSemanticHeadsInTransaction(embeddingFingerprint, preprocessing);
        if (promoted)
          this.context.db.exec({
            sql: "UPDATE index_state SET semantic_revision_count=(SELECT count(*) FROM notes WHERE semantic_revision_id IS NOT NULL),semantic_generation=semantic_generation+1,change_counter=change_counter+1 WHERE id=1",
          });
      });
    const first = rows(
      this.context.db,
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
      this.context.db,
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
      generation: readGenerationToken(this.context),
      promoted,
    };
  }

  /** Commit one provider slice without recalculating full index state. */
  commitSemanticResults(
    results: readonly SqliteEmbeddingResult[],
    embeddingFingerprint: string,
    preprocessing = EMBEDDING_PREPROCESSING_VERSION
  ): SqliteSemanticCommitResult {
    this.context.ensureOpen();
    const valid: SqliteEmbeddingResult[] = [];
    let skipped = 0;
    const inputRows = new Map<
      number,
      { readonly actionKey: string; readonly serialization: string }
    >();
    for (const result of results) {
      if (!inputRows.has(result.inputId)) {
        const input = rows(
          this.context.db,
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
        const vector = normalizedVector(result.vector, this.context.dimensions);
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
    transaction(this.context.db, () => {
      this.context.db.exec(
        "CREATE TEMP TABLE semantic_result_inputs(input_digest TEXT PRIMARY KEY,action_key TEXT NOT NULL,serialization TEXT NOT NULL,vector BLOB NOT NULL)"
      );
      try {
        for (const result of accepted) {
          const input = inputRows.get(result.inputId)!;
          this.context.db.exec({
            sql: "INSERT INTO semantic_result_inputs(input_digest,action_key,serialization,vector) VALUES(?,?,?,?)",
            bind: [
              input.actionKey,
              result.actionKey,
              result.serialization,
              vectorBytes(result.vector),
            ],
          });
        }
        this.context.db.exec(
          `CREATE TEMP TABLE semantic_affected_notes(note_id INTEGER PRIMARY KEY)`
        );
        this.context.db.exec({
          sql: `INSERT INTO semantic_affected_notes(note_id)
                SELECT DISTINCT n.note_id
                FROM notes n
                JOIN chunk_occurrences o ON o.note_id=n.note_id AND o.revision_id=n.lexical_revision_id
                JOIN semantic_result_inputs r ON r.input_digest=o.embedding_input_digest
                WHERE n.lexical_revision_id IS NOT NULL`,
        });
        this.context.db.exec({
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
          this.context.db.exec({
            sql: "UPDATE index_state SET semantic_revision_count=(SELECT count(*) FROM notes WHERE semantic_revision_id IS NOT NULL),semantic_generation=semantic_generation+1,change_counter=change_counter+1 WHERE id=1",
          });
      } finally {
        this.context.db.exec("DROP TABLE IF EXISTS semantic_affected_notes");
        this.context.db.exec("DROP TABLE IF EXISTS semantic_result_inputs");
      }
    });
    return {
      stored: accepted.length,
      skipped,
      promoted,
      hasMore: this.hasMissingEmbeddingInputs(embeddingFingerprint, preprocessing),
      generation: readGenerationToken(this.context),
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
    this.context.db.exec({
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
    return Number(rows(this.context.db, "SELECT changes() AS count")[0]?.count ?? 0);
  }

  clearSemanticCache(): SqliteState {
    this.context.ensureOpen();
    const hadVisibleHeads =
      Number(
        rows(
          this.context.db,
          "SELECT count(*) AS count FROM notes WHERE semantic_revision_id IS NOT NULL"
        )[0]?.count ?? 0
      ) > 0;
    transaction(this.context.db, () => {
      this.context.db.exec({
        sql: "UPDATE notes SET semantic_revision_id=NULL WHERE semantic_revision_id IS NOT NULL",
      });
      this.context.db.exec({
        sql: "DELETE FROM embedding_cache WHERE embedding_fingerprint=?",
        bind: [this.context.embeddingFingerprint],
      });
      this.context.db.exec({
        sql: "UPDATE index_state SET semantic_revision_count=0,semantic_generation=semantic_generation+CASE WHEN ? THEN 1 ELSE 0 END,change_counter=change_counter+1 WHERE id=1",
        bind: [hadVisibleHeads ? 1 : 0],
      });
    });
    return this.state.getState();
  }
}
