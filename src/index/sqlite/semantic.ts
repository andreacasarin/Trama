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
  type SqliteConnection,
  transaction,
  vectorBytes,
} from "./core";
import type { SqliteStateStore } from "./state";
import {
  SEMANTIC_AFFECTED_PROMOTION_SQL,
  SEMANTIC_MISSING_INPUTS_SQL,
  SEMANTIC_PROMOTION_SQL,
} from "./hot-queries";
import {
  emitTramaDiagnostic,
  diagnosticsEnabled,
  NOOP_TRAMA_DIAGNOSTICS,
  type PerformancePhase,
  type TramaDiagnostics,
} from "@/diagnostics/TramaDiagnostics";

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
  private activePhase?: {
    operation: "prepare" | "commit";
    phase: PerformancePhase;
    sqlMs: number;
    sqlCalls: number;
    callbackRows: number;
  };
  private observedDb?: SqliteConnection;

  constructor(
    private readonly context: SqliteContext,
    private readonly state: SqliteStateStore,
    private readonly diagnostics: TramaDiagnostics = NOOP_TRAMA_DIAGNOSTICS
  ) {}

  private get db(): SqliteConnection {
    if (!diagnosticsEnabled(this.diagnostics, "performance")) return this.context.db;
    return (this.observedDb ??= {
      exec: (options) => {
        const phase = this.activePhase;
        if (!phase) return this.context.db.exec(options);
        phase.sqlCalls++;
        const started = performance.now();
        try {
          if (typeof options === "string" || !options.callback)
            return this.context.db.exec(options);
          return this.context.db.exec({
            ...options,
            callback: (row) => {
              phase.callbackRows++;
              options.callback!(row);
            },
          });
        } finally {
          phase.sqlMs += performance.now() - started;
        }
      },
      close: () => this.context.db.close(),
    });
  }

  private phase<T>(operation: "prepare" | "commit", phase: PerformancePhase, body: () => T): T {
    if (!diagnosticsEnabled(this.diagnostics, "performance")) return body();
    const previous = this.activePhase;
    const current = { operation, phase, sqlMs: 0, sqlCalls: 0, callbackRows: 0 };
    this.activePhase = current;
    const started = performance.now();
    let copiedBytes = 0;
    try {
      const result = body();
      if (phase === "knownBlobCopy" && result instanceof Uint8Array)
        copiedBytes = result.byteLength;
      return result;
    } finally {
      this.activePhase = previous;
      const wallMs = performance.now() - started;
      if (previous) {
        previous.sqlMs += current.sqlMs;
        previous.sqlCalls += current.sqlCalls;
        previous.callbackRows += current.callbackRows;
      }
      emitTramaDiagnostic(this.diagnostics, {
        tier: "performance",
        facets: ["index", "semantic", "worker"],
        area: "index",
        event: "phase",
        operation: "semantic",
        semanticStep: operation,
        phase,
        durationMs: wallMs,
        sqlMs: current.sqlMs,
        sqlCalls: current.sqlCalls,
        callbackRows: current.callbackRows,
        copiedBytes,
        nested: Boolean(previous),
      });
    }
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
    this.context.ensureOpen();
    const measured = diagnosticsEnabled(this.diagnostics, "performance");
    const boundedInputBytes = Math.max(1, maxInputBytes);
    let promoted = 0;
    if (promoteUnrestricted)
      promoted = measured
        ? this.phase("prepare", "unrestrictedPromotion", () =>
            this.promoteUnrestricted(embeddingFingerprint, preprocessing)
          )
        : this.promoteUnrestricted(embeddingFingerprint, preprocessing);
    const selectBind = [
      embeddingFingerprint,
      preprocessing,
      Math.max(0, limit),
      Math.max(0, limit),
      boundedInputBytes,
    ];
    const selected = measured
      ? this.phase("prepare", "boundedMissingSelection", () =>
          rows(this.db, SEMANTIC_MISSING_INPUTS_SQL, selectBind)
        )
      : rows(this.db, SEMANTIC_MISSING_INPUTS_SQL, selectBind);
    const firstInputBytes = Number(selected[0]?.inputBytes ?? 0);
    if (limit > 0 && firstInputBytes > boundedInputBytes)
      throw sqliteError(
        "limit_exceeded",
        `Semantic input is ${firstInputBytes} bytes; maximum is ${boundedInputBytes} bytes.`
      );
    const requests = measured
      ? this.phase("prepare", "resultAssembly", () =>
          selected.map((row) => ({
            actionKey: embeddingActionKey(
              String(row.inputDigest),
              embeddingFingerprint,
              preprocessing
            ),
            inputId: Number(row.inputId),
            serialization: String(row.serialization),
          }))
        )
      : selected.map((row) => ({
          actionKey: embeddingActionKey(
            String(row.inputDigest),
            embeddingFingerprint,
            preprocessing
          ),
          inputId: Number(row.inputId),
          serialization: String(row.serialization),
        }));
    const hasMore = measured
      ? this.phase("prepare", "remainingWorkCheck", () =>
          this.hasMissingEmbeddingInputs(embeddingFingerprint, preprocessing)
        )
      : this.hasMissingEmbeddingInputs(embeddingFingerprint, preprocessing);
    const generation = measured
      ? this.phase("prepare", "generationLookup", () => readGenerationToken(this.context, this.db))
      : readGenerationToken(this.context, this.db);
    return {
      requests,
      hasMore,
      generation,
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
    const measured = diagnosticsEnabled(this.diagnostics, "performance");
    const valid: SqliteEmbeddingResult[] = [];
    let skipped = 0;
    const inputRows = new Map<
      number,
      { readonly actionKey: string; readonly serialization: string }
    >();
    for (const result of results) {
      if (!inputRows.has(result.inputId)) {
        const input = measured
          ? this.phase(
              "commit",
              "inputRereadValidation",
              () =>
                rows(
                  this.db,
                  "SELECT action_key,serialized_input FROM embedding_inputs WHERE input_id=?",
                  [result.inputId]
                )[0]
            )
          : rows(
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
        const vector = measured
          ? this.phase("commit", "vectorNormalizationDedup", () =>
              normalizedVector(result.vector, this.context.dimensions)
            )
          : normalizedVector(result.vector, this.context.dimensions);
        valid.push({ ...result, vector });
      } catch (error) {
        if (error instanceof Error && "error" in error) throw error;
        skipped++;
      }
    }
    // Duplicate results cannot inflate stored counts or trigger duplicate work.
    const accepted = measured
      ? this.phase("commit", "vectorNormalizationDedup", () => this.deduplicate(valid))
      : this.deduplicate(valid);
    let promoted = 0;
    const transactionBody = () => {
      const createSql =
        "CREATE TEMP TABLE semantic_result_inputs(input_digest TEXT PRIMARY KEY,action_key TEXT NOT NULL,serialization TEXT NOT NULL,vector BLOB NOT NULL)";
      if (measured)
        this.phase("commit", "transactionSetupResultInserts", () => this.db.exec(createSql));
      else this.db.exec(createSql);
      try {
        for (const result of accepted) {
          const input = inputRows.get(result.inputId)!;
          const bytes = measured
            ? this.phase("commit", "knownBlobCopy", () => vectorBytes(result.vector))
            : vectorBytes(result.vector);
          const insert = {
            sql: "INSERT INTO semantic_result_inputs(input_digest,action_key,serialization,vector) VALUES(?,?,?,?)",
            bind: [input.actionKey, result.actionKey, result.serialization, bytes],
          };
          if (measured)
            this.phase("commit", "transactionSetupResultInserts", () => this.db.exec(insert));
          else this.db.exec(insert);
        }
        if (measured)
          this.phase("commit", "affectedNoteCacheUpsert", () =>
            this.upsertAffectedNotes(embeddingFingerprint, preprocessing)
          );
        else this.upsertAffectedNotes(embeddingFingerprint, preprocessing);
        promoted = measured
          ? this.phase("commit", "promotion", () =>
              this.promoteSemanticHeadsInTransaction(
                embeddingFingerprint,
                preprocessing,
                "semantic_affected_notes"
              )
            )
          : this.promoteSemanticHeadsInTransaction(
              embeddingFingerprint,
              preprocessing,
              "semantic_affected_notes"
            );
        if (promoted) {
          if (measured)
            this.phase("commit", "promotion", () =>
              this.db.exec({
                sql: "UPDATE index_state SET semantic_generation=semantic_generation+1,change_counter=change_counter+1 WHERE id=1",
              })
            );
          else
            this.db.exec({
              sql: "UPDATE index_state SET semantic_generation=semantic_generation+1,change_counter=change_counter+1 WHERE id=1",
            });
        }
      } finally {
        if (measured) this.phase("commit", "cleanup", () => this.cleanupSemanticResults());
        else this.cleanupSemanticResults();
      }
    };
    if (measured) this.phase("commit", "transaction", () => transaction(this.db, transactionBody));
    else transaction(this.db, transactionBody);
    const hasMore = measured
      ? this.phase("commit", "remainingWorkCheck", () =>
          this.hasMissingEmbeddingInputs(embeddingFingerprint, preprocessing)
        )
      : this.hasMissingEmbeddingInputs(embeddingFingerprint, preprocessing);
    const generation = measured
      ? this.phase("commit", "generationLookup", () => readGenerationToken(this.context, this.db))
      : readGenerationToken(this.context, this.db);
    return {
      stored: accepted.length,
      skipped,
      promoted,
      hasMore,
      generation,
    };
  }
  private deduplicate(valid: readonly SqliteEmbeddingResult[]): SqliteEmbeddingResult[] {
    const unique = new Map<string, SqliteEmbeddingResult>();
    for (const result of valid) unique.set(result.actionKey, result);
    return [...unique.values()];
  }

  private promoteUnrestricted(embeddingFingerprint: string, preprocessing: string): number {
    let promoted = 0;
    transaction(this.db, () => {
      promoted = this.promoteSemanticHeadsInTransaction(embeddingFingerprint, preprocessing);
      if (promoted)
        this.db.exec({
          sql: "UPDATE index_state SET semantic_generation=semantic_generation+1,change_counter=change_counter+1 WHERE id=1",
        });
    });
    return promoted;
  }

  private upsertAffectedNotes(embeddingFingerprint: string, preprocessing: string): void {
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
  }

  private cleanupSemanticResults(): void {
    this.db.exec("DROP TABLE IF EXISTS semantic_affected_notes");
    this.db.exec("DROP TABLE IF EXISTS semantic_result_inputs");
  }
  private promoteSemanticHeadsInTransaction(
    embeddingFingerprint: string,
    preprocessing: string,
    affectedTable?: string
  ): number {
    const sql = affectedTable ? SEMANTIC_AFFECTED_PROMOTION_SQL : SEMANTIC_PROMOTION_SQL;
    this.db.exec({
      sql,
      bind: [embeddingFingerprint, preprocessing],
    });
    return Number(rows(this.db, "SELECT changes() AS count")[0]?.count ?? 0);
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
        sql: "UPDATE index_state SET semantic_generation=semantic_generation+CASE WHEN ? THEN 1 ELSE 0 END,change_counter=change_counter+1 WHERE id=1",
        bind: [hadVisibleHeads ? 1 : 0],
      });
    });
    return this.state.getState();
  }
}
