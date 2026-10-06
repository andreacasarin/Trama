import {
  type SqliteLexicalRunResult,
  type SqliteLexicalScope,
  type SqliteMutationReceipt,
  type SqliteNoteSummary,
  type SqliteReconciliationPlan,
  type SqliteState,
  sqliteError,
  sqliteMutationReceipt,
} from "./protocol";
import { readChangeCounter, rows, type SqliteContext, transaction } from "./core";
import type { LexicalRunRegistry } from "./lexical-context";
import type { SqliteLexicalBatchStore } from "./lexical-batch";
import type { SqliteLexicalStagingStore } from "./lexical-staging";
import type { SqliteStateStore } from "./state";
import { LEXICAL_BOUNDED_DELETE_SQL, LEXICAL_FINISH_EQUALITY_SQL } from "./hot-queries";

function withExpectedNotes<T>(
  context: SqliteContext,
  summaries: readonly SqliteNoteSummary[],
  body: () => T
): T {
  context.db.exec(
    "CREATE TEMP TABLE reconciliation_expected(path TEXT PRIMARY KEY COLLATE BINARY, content_id TEXT NOT NULL, chunk_count INTEGER)"
  );
  try {
    context.db.exec({
      sql: "INSERT INTO reconciliation_expected(path,content_id,chunk_count) SELECT json_extract(value,'$.path'),json_extract(value,'$.contentId'),json_extract(value,'$.chunkCount') FROM json_each(?)",
      bind: [JSON.stringify(summaries)],
    });
    return body();
  } finally {
    context.db.exec("DROP TABLE reconciliation_expected");
  }
}

export class SqliteLexicalRunStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly registry: LexicalRunRegistry,
    private readonly batch: SqliteLexicalBatchStore,
    private readonly staging: SqliteLexicalStagingStore,
    private readonly state: SqliteStateStore
  ) {}

  private planReconciliation(summaries: readonly SqliteNoteSummary[]): SqliteReconciliationPlan {
    this.context.ensureOpen();
    const planned = withExpectedNotes(this.context, summaries, () =>
      rows(
        this.context.db,
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
      state: planned.length ? this.state.markIncomplete() : this.state.getState(),
    };
  }
  /** Return the active digest without loading or parsing the Markdown body. */
  getLexicalRevisionDigest(path: string): string | undefined {
    this.context.ensureOpen();
    const row = rows(
      this.context.db,
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
  } {
    this.context.ensureOpen();
    const current = readChangeCounter(this.context);
    if (options.expectedChangeCounter !== undefined && options.expectedChangeCounter !== current)
      throw sqliteError("busy", "Lexical run generation is stale", true);
    const runId = options.runId ?? this.registry.nextRunId();
    if (this.registry.runs.has(runId))
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
      ? this.state.getState()
      : plannedState && plannedState.incomplete
        ? plannedState
        : this.state.markIncomplete();
    const scopedRenames = options.scope?.renames?.map((rename) => ({
      from: rename.from,
      to: rename.to,
      contentId: "",
    }));
    const scopedDeletes = options.scope?.deletes?.map((path) => ({ path, contentId: "" }));
    this.registry.runs.set(runId, {
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
    };
  }
  finishLexicalRun(runId: string): SqliteLexicalRunResult {
    this.context.ensureOpen();
    const run = this.registry.runs.get(runId);
    if (!run) throw sqliteError("invalid_request", "Lexical run is not active");
    if (this.staging.has(runId))
      throw sqliteError("busy", "Lexical run has unfinished staged revisions", true);
    if (readChangeCounter(this.context) !== run.changeCounter)
      throw sqliteError("busy", "Lexical run generation is stale", true);
    let renamed = 0;
    let deleted = 0;
    let semanticChanged = 0;
    let changed = false;
    let processedDeletes = 0;
    const deleteBatch = run.deletes.slice(0, 16);
    transaction(this.context.db, () => {
      if (!run.renamesApplied) {
        const result = this.batch.applyRunRenamesInTransaction(run.renames);
        renamed = result.changed;
        semanticChanged += result.semanticChanged;
      }
      if (run.expected) {
        const mismatch = withExpectedNotes(
          this.context,
          run.expected,
          () => rows(this.context.db, LEXICAL_FINISH_EQUALITY_SQL, [])[0]
        );
        if (Number(mismatch.count))
          throw sqliteError("busy", "Lexical run has unapplied notes", true);
      }
      if (deleteBatch.length) {
        this.context.db.exec(
          "CREATE TEMP TABLE lexical_delete_paths(path TEXT PRIMARY KEY COLLATE BINARY)"
        );
        try {
          for (const item of deleteBatch)
            this.context.db.exec({
              sql: "INSERT OR IGNORE INTO lexical_delete_paths(path) VALUES(?)",
              bind: [item.path],
            });
          processedDeletes = deleteBatch.length;
          deleted = Number(
            rows(
              this.context.db,
              "SELECT count(*) AS count FROM notes n JOIN lexical_delete_paths d ON d.path=n.path"
            )[0]?.count ?? 0
          );
          semanticChanged += Number(
            rows(
              this.context.db,
              "SELECT count(*) AS count FROM notes n JOIN lexical_delete_paths d ON d.path=n.path WHERE n.semantic_revision_id IS NOT NULL"
            )[0]?.count ?? 0
          );
          if (deleted) {
            this.context.db.exec({
              sql: LEXICAL_BOUNDED_DELETE_SQL,
            });
          }
        } finally {
          this.context.db.exec("DROP TABLE IF EXISTS lexical_delete_paths");
        }
      }
      changed = renamed > 0 || deleted > 0;
      const complete = run.deletes.length <= processedDeletes;
      const converged = complete && (!run.scoped || run.mayClearIncomplete);
      this.context.db.exec({
        sql: `UPDATE index_state
              SET incomplete=CASE WHEN ? THEN 0 ELSE 1 END,
                  reconciliation_summary='',
                  lexical_generation=lexical_generation+?,
                  semantic_generation=semantic_generation+CASE WHEN ? > 0 THEN 1 ELSE 0 END,
                  change_counter=change_counter+CASE WHEN ? THEN 1 ELSE 0 END
              WHERE id=1`,
        bind: [converged ? 1 : 0, changed ? 1 : 0, semanticChanged, changed ? 1 : 0],
      });
    });
    if (processedDeletes) run.deletes.splice(0, processedDeletes);
    run.changeCounter = readChangeCounter(this.context);
    const complete = run.deletes.length === 0;
    if (complete) this.registry.runs.delete(runId);
    const state = this.state.getState();
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
    this.context.ensureOpen();
    const run = this.registry.runs.get(runId);
    if (!run) throw sqliteError("invalid_request", "Lexical run is not active");
    this.staging.discard(runId);
    this.registry.runs.delete(runId);
    const state = this.state.getState();
    return {
      runId,
      state,
      receipt: sqliteMutationReceipt(state, false, "unchanged"),
    };
  }

  listLexicalSummaries(): readonly import("./protocol").SqliteLexicalSummary[] {
    this.context.ensureOpen();
    return rows(
      this.context.db,
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
}
