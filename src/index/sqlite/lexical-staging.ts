import {
  SQLITE_MAX_LEXICAL_BATCH_OCCURRENCES,
  type SqliteLexicalBatchResult,
  type SqliteLexicalRevisionInput,
  sqliteError,
  sqliteMutationReceipt,
} from "./protocol";
import {
  CHUNK_ALGORITHM_VERSION,
  EXTRACTION_VERSION,
  readChangeCounter,
  readGenerationToken,
  rows,
  type SqliteContext,
  transaction,
} from "./core";
import type { LexicalRevisionApplyResult, LexicalRunRegistry } from "./lexical-context";
import type { SqliteLexicalBatchStore } from "./lexical-batch";
import type { SqliteStateStore } from "./state";
import { lexicalNoteText, pruneUnreferencedRevisions } from "./lexical-full-note";

export class SqliteLexicalStagingStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly registry: LexicalRunRegistry,
    private readonly batch: SqliteLexicalBatchStore,
    private readonly state: SqliteStateStore
  ) {}

  has(runId: string): boolean {
    try {
      return (
        Number(
          rows(
            this.context.db,
            "SELECT count(*) AS count FROM lexical_stage_notes WHERE run_id=?",
            [runId]
          )[0]?.count ?? 0
        ) > 0
      );
    } catch {
      return false;
    }
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
    this.context.ensureOpen();
    const run = this.registry.runs.get(runId);
    if (!run) throw sqliteError("invalid_request", "Lexical run is not active");
    if (readChangeCounter(this.context) !== run.changeCounter)
      throw sqliteError("busy", "Lexical run generation is stale", true);
    const note = rows(
      this.context.db,
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
        receipt: sqliteMutationReceipt(this.state.getState(), false, "unchanged"),
      };
    }
    if (input.blocks.length <= SQLITE_MAX_LEXICAL_BATCH_OCCURRENCES)
      throw sqliteError("invalid_request", "Staged lexical revision is not oversized");

    try {
      this.ensureStageTables();
      transaction(this.context.db, () => {
        const existing = rows(
          this.context.db,
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
          this.context.db.exec({
            sql: "INSERT INTO lexical_stage_notes(run_id,path_text,revision_digest,expected_count,title,headings,body) VALUES(?,?,?,?,?,?,?)",
            bind: [
              runId,
              input.path,
              input.revisionDigest,
              input.blocks.length,
              lexicalNoteText(input).title,
              lexicalNoteText(input).headings,
              lexicalNoteText(input).body,
            ],
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
        transaction(this.context.db, () => {
          for (const block of slice) {
            this.context.db.exec({
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
          this.context.db.exec({
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
      transaction(this.context.db, () => {
        const metadata = rows(
          this.context.db,
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
          this.context.db,
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
          const renameResult = this.batch.applyRunRenamesInTransaction(run.renames);
          renamed = renameResult.changed;
          semanticChanged = renameResult.semanticChanged;
        }
        result = this.activateStagedRevisionInTransaction(runId, input.path, input.revisionDigest);
        result = {
          ...result,
          renamed,
          semanticChanged: result.semanticChanged + semanticChanged,
        };
        this.context.db.exec({
          sql: `UPDATE index_state
                SET incomplete=1,
                    lexical_generation=lexical_generation+1,
                    semantic_generation=semantic_generation+CASE WHEN ? > 0 THEN 1 ELSE 0 END,
                    change_counter=change_counter+1
                WHERE id=1`,
          bind: [result.semanticChanged],
        });
        this.context.db.exec({
          sql: "DELETE FROM lexical_stage_occurrences WHERE run_id=? AND path_text=?",
          bind: [runId, input.path],
        });
        this.context.db.exec({
          sql: "DELETE FROM lexical_stage_notes WHERE run_id=? AND path_text=?",
          bind: [runId, input.path],
        });
      });
      run.renamesApplied = true;
      run.changeCounter = readChangeCounter(this.context);
      const generation = readGenerationToken(this.context);
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
      this.discard(runId);
      throw error;
    }
  }

  /** Remove operation-local staged rows while preserving earlier committed notes. */
  discard(runId: string): void {
    this.context.ensureOpen();
    try {
      this.context.db.exec({
        sql: "DELETE FROM lexical_stage_occurrences WHERE run_id=?",
        bind: [runId],
      });
      this.context.db.exec({
        sql: "DELETE FROM lexical_stage_notes WHERE run_id=?",
        bind: [runId],
      });
    } catch {
      // The temp tables may not exist yet, or the connection may be unwinding.
    }
  }

  private ensureStageTables(): void {
    this.context.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS lexical_stage_notes(
        run_id TEXT NOT NULL,
        path_text TEXT NOT NULL,
        revision_digest TEXT NOT NULL,
        expected_count INTEGER NOT NULL CHECK(expected_count >= 0),
        received_count INTEGER NOT NULL DEFAULT 0 CHECK(received_count >= 0),
        title TEXT NOT NULL,
        headings TEXT NOT NULL,
        body TEXT NOT NULL,
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
      this.context.db,
      "SELECT note_id,lexical_revision_id,semantic_revision_id FROM notes WHERE path=?",
      [path]
    )[0];
    const priorRevision =
      note?.lexical_revision_id == null ? undefined : Number(note.lexical_revision_id);
    if (priorRevision !== undefined) {
      const current = rows(
        this.context.db,
        "SELECT content_id FROM note_revisions WHERE revision_id=?",
        [priorRevision]
      )[0];
      if (current && String(current.content_id) === revisionDigest)
        return { changed: 0, skipped: 1, occurrences: 0, renamed: 0, semanticChanged: 0 };
    }
    let noteId: number;
    if (note) noteId = Number(note.note_id);
    else {
      this.context.db.exec({
        sql: "INSERT INTO notes(note_id,path,content_id) SELECT COALESCE(MAX(note_id),0)+1,?,? FROM notes",
        bind: [path, revisionDigest],
      });
      noteId = Number(
        rows(this.context.db, "SELECT note_id FROM notes WHERE path=?", [path])[0].note_id
      );
    }
    let revisionId = Number(
      rows(
        this.context.db,
        "SELECT revision_id FROM note_revisions WHERE note_id=? AND content_id=? AND extraction_version=? AND chunk_algorithm_version=?",
        [noteId, revisionDigest, EXTRACTION_VERSION, CHUNK_ALGORITHM_VERSION]
      )[0]?.revision_id ?? 0
    );
    const staged = rows(
      this.context.db,
      "SELECT expected_count,title,headings,body FROM lexical_stage_notes WHERE run_id=? AND path_text=?",
      [runId, path]
    )[0];
    const expectedCount = Number(
      rows(
        this.context.db,
        "SELECT expected_count FROM lexical_stage_notes WHERE run_id=? AND path_text=?",
        [runId, path]
      )[0]?.expected_count ?? -1
    );
    if (!revisionId) {
      this.context.db.exec({
        sql: "INSERT INTO note_revisions(note_id,content_id,extraction_version,chunk_algorithm_version,created_change_counter) VALUES(?,?,?,?,(SELECT change_counter+1 FROM index_state WHERE id=1))",
        bind: [noteId, revisionDigest, EXTRACTION_VERSION, CHUNK_ALGORITHM_VERSION],
      });
      revisionId = Number(rows(this.context.db, "SELECT last_insert_rowid() AS id")[0].id);
      this.context.db.exec({
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
      this.context.db.exec({
        sql: `INSERT INTO embedding_inputs(embedding_fingerprint,serialized_input,preprocessing,action_key)
              SELECT 'input-v1',embedding_input,'serialized-v1',embedding_input_digest
              FROM lexical_stage_occurrences WHERE run_id=? AND path_text=?
              ON CONFLICT(action_key) DO NOTHING`,
        bind: [runId, path],
      });
    } else {
      const existingCount = Number(
        rows(
          this.context.db,
          "SELECT count(*) AS count FROM chunk_occurrences WHERE revision_id=?",
          [revisionId]
        )[0].count
      );
      if (existingCount !== expectedCount)
        throw sqliteError("integrity_failed", "Durable lexical revision has an unexpected count");
    }
    const filename = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
    this.context.db.exec({
      sql: "UPDATE notes SET lexical_revision_id=?,content_id=? WHERE note_id=?",
      bind: [revisionId, revisionDigest, noteId],
    });
    this.context.db.exec({
      sql: `INSERT INTO lexical_notes(note_id,revision_id,path_text,filename,title,headings,body)
            VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(note_id) DO UPDATE SET revision_id=excluded.revision_id,
              path_text=excluded.path_text,filename=excluded.filename,title=excluded.title,
              headings=excluded.headings,body=excluded.body`,
      bind: [
        noteId,
        revisionId,
        path,
        filename,
        String(staged.title),
        String(staged.headings),
        String(staged.body),
      ],
    });
    pruneUnreferencedRevisions(this.context.db);
    return {
      changed: 1,
      skipped: 0,
      occurrences: expectedCount,
      renamed: 0,
      semanticChanged: note?.semantic_revision_id == null ? 0 : 1,
    };
  }
}
