import {
  SQLITE_MAX_LEXICAL_BATCH_NOTES,
  SQLITE_MAX_LEXICAL_BATCH_OCCURRENCES,
  type SqliteLexicalBatchResult,
  type SqliteLexicalRevisionInput,
  sqliteError,
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
import type { LexicalRunRegistry } from "./lexical-context";
import { LEXICAL_RENAME_LOOKUP_SQL } from "./hot-queries";
import { lexicalNoteText, pruneUnreferencedRevisions } from "./lexical-full-note";

export class SqliteLexicalBatchStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly registry: LexicalRunRegistry
  ) {}

  /** Apply one bounded set of already hashed and parsed revisions atomically. */
  applyLexicalBatch(
    runId: string,
    inputs: readonly SqliteLexicalRevisionInput[]
  ): SqliteLexicalBatchResult {
    this.context.ensureOpen();
    const run = this.registry.runs.get(runId);
    if (!run) throw sqliteError("invalid_request", "Lexical run is not active");
    if (readChangeCounter(this.context) !== run.changeCounter)
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
    this.context.db.exec(
      "CREATE TEMP TABLE lexical_batch_notes(note_id INTEGER PRIMARY KEY,revision_id INTEGER NOT NULL,path_text TEXT NOT NULL,filename TEXT NOT NULL,title TEXT NOT NULL,headings TEXT NOT NULL,body TEXT NOT NULL)"
    );
    try {
      transaction(this.context.db, () => {
        if (!run.renamesApplied) {
          const result = this.applyRunRenamesInTransaction(run.renames);
          renamed = result.changed;
          semanticChanged += result.semanticChanged;
        }
        for (const input of inputs) {
          const note = rows(
            this.context.db,
            "SELECT note_id,lexical_revision_id,semantic_revision_id FROM notes WHERE path=?",
            [input.path]
          )[0];
          const priorRevision =
            note?.lexical_revision_id == null ? undefined : Number(note.lexical_revision_id);
          if (priorRevision !== undefined) {
            const current = rows(
              this.context.db,
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
            this.context.db.exec({
              sql: "INSERT INTO notes(note_id,path,content_id) SELECT COALESCE(MAX(note_id),0)+1,?,? FROM notes",
              bind: [input.path, input.revisionDigest],
            });
            noteId = Number(
              rows(this.context.db, "SELECT note_id FROM notes WHERE path=?", [input.path])[0]
                .note_id
            );
          }
          let revisionId = Number(
            rows(
              this.context.db,
              "SELECT revision_id FROM note_revisions WHERE note_id=? AND content_id=? AND extraction_version=? AND chunk_algorithm_version=?",
              [noteId, input.revisionDigest, EXTRACTION_VERSION, CHUNK_ALGORITHM_VERSION]
            )[0]?.revision_id ?? 0
          );
          if (!revisionId) {
            this.context.db.exec({
              sql: "INSERT INTO note_revisions(note_id,content_id,extraction_version,chunk_algorithm_version,created_change_counter) VALUES(?,?,?,?,(SELECT change_counter+1 FROM index_state WHERE id=1))",
              bind: [noteId, input.revisionDigest, EXTRACTION_VERSION, CHUNK_ALGORITHM_VERSION],
            });
            revisionId = Number(rows(this.context.db, "SELECT last_insert_rowid() AS id")[0].id);
            const occurrenceRows = JSON.stringify(
              input.blocks.map((block) => [
                block.ordinal,
                `${input.revisionDigest}:${block.ordinal}`,
                block.kind,
                block.startLine,
                block.endLine,
                block.displayText,
                JSON.stringify(block.headingContext),
                block.embeddingInput,
                block.embeddingInputDigest,
              ])
            );
            this.context.db.exec({
              sql: `INSERT INTO chunk_occurrences(revision_id,note_id,chunk_id,ordinal,kind,start_line,end_line,display_text,heading_context,embedding_input,embedding_input_digest,body)
                    SELECT ?,?,json_extract(j.value,'$[1]'),CAST(json_extract(j.value,'$[0]') AS INTEGER),
                           json_extract(j.value,'$[2]'),json_extract(j.value,'$[3]'),json_extract(j.value,'$[4]'),
                           json_extract(j.value,'$[5]'),json_extract(j.value,'$[6]'),json_extract(j.value,'$[7]'),
                           json_extract(j.value,'$[8]'),json_extract(j.value,'$[5]')
                    FROM json_each(?) AS j
                    ORDER BY CAST(j.key AS INTEGER)`,
              bind: [revisionId, noteId, occurrenceRows],
            });
            this.context.db.exec({
              sql: `INSERT INTO embedding_inputs(embedding_fingerprint,serialized_input,preprocessing,action_key)
                    SELECT ?,json_extract(j.value,'$[7]'),?,json_extract(j.value,'$[8]')
                    FROM json_each(?) AS j
                    ORDER BY CAST(j.key AS INTEGER)
                    ON CONFLICT(action_key) DO NOTHING`,
              bind: ["input-v1", "serialized-v1", occurrenceRows],
            });
          }
          this.context.db.exec({
            sql: "INSERT INTO lexical_batch_notes(note_id,revision_id,path_text,filename,title,headings,body) VALUES(?,?,?,?,?,?,?)",
            bind: [
              noteId,
              revisionId,
              input.path,
              input.path.slice(input.path.lastIndexOf("/") + 1).replace(/\.md$/i, ""),
              lexicalNoteText(input).title,
              lexicalNoteText(input).headings,
              lexicalNoteText(input).body,
            ],
          });
          changed++;
          changedOccurrences += input.blocks.length;
          if (note?.semantic_revision_id != null) semanticChanged++;
        }
        if (changed || renamed) {
          this.context.db.exec({
            sql: `UPDATE notes
                  SET lexical_revision_id=(SELECT revision_id FROM lexical_batch_notes b WHERE b.note_id=notes.note_id),
                      content_id=(SELECT r.content_id FROM note_revisions r JOIN lexical_batch_notes b ON b.revision_id=r.revision_id WHERE b.note_id=notes.note_id)
                  WHERE note_id IN (SELECT note_id FROM lexical_batch_notes)`,
          });
          this.context.db.exec({
            sql: `UPDATE index_state
                  SET incomplete=1,
                      lexical_generation=lexical_generation+1,
                      semantic_generation=semantic_generation+CASE WHEN ? > 0 THEN 1 ELSE 0 END,
                      change_counter=change_counter+1
                  WHERE id=1`,
            bind: [semanticChanged],
          });
          this.context.db.exec({
            sql: `INSERT INTO lexical_notes(note_id,revision_id,path_text,filename,title,headings,body)
                  SELECT b.note_id,b.revision_id,b.path_text,b.filename,b.title,b.headings,b.body
                  FROM lexical_batch_notes b WHERE 1
                  ON CONFLICT(note_id) DO UPDATE SET
                    revision_id=excluded.revision_id,path_text=excluded.path_text,
                    filename=excluded.filename,title=excluded.title,
                    headings=excluded.headings,body=excluded.body`,
          });
          pruneUnreferencedRevisions(this.context.db);
        }
      });
      run.renamesApplied = true;
      run.changeCounter = readChangeCounter(this.context);
    } finally {
      try {
        this.context.db.exec("DROP TABLE IF EXISTS lexical_batch_notes");
      } catch {
        /* preserve the transaction result */
      }
    }
    const generation = readGenerationToken(this.context);
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
  applyRunRenamesInTransaction(
    renames: readonly { from: string; to: string; contentId: string }[]
  ): { readonly changed: number; readonly semanticChanged: number } {
    if (!renames.length) return { changed: 0, semanticChanged: 0 };
    this.context.db.exec(
      "CREATE TEMP TABLE lexical_run_renames(note_id INTEGER PRIMARY KEY,from_path TEXT NOT NULL,to_path TEXT NOT NULL,filename TEXT NOT NULL)"
    );
    let changed = 0;
    let semanticChanged = 0;
    try {
      for (const rename of renames) {
        const row = rows(this.context.db, LEXICAL_RENAME_LOOKUP_SQL, [rename.from])[0];
        if (!row || rows(this.context.db, "SELECT 1 FROM notes WHERE path=?", [rename.to]).length)
          continue;
        this.context.db.exec({
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
        this.context.db.exec({
          sql: "UPDATE notes SET path=(SELECT to_path FROM lexical_run_renames r WHERE r.note_id=notes.note_id) WHERE note_id IN (SELECT note_id FROM lexical_run_renames)",
        });
        this.context.db.exec({
          sql: `UPDATE lexical_notes
                SET path_text=(SELECT to_path FROM lexical_run_renames r WHERE r.note_id=lexical_notes.note_id),
                    filename=(SELECT filename FROM lexical_run_renames r WHERE r.note_id=lexical_notes.note_id),
                    title=(SELECT filename FROM lexical_run_renames r WHERE r.note_id=lexical_notes.note_id)
                WHERE note_id IN (SELECT note_id FROM lexical_run_renames)`,
        });
      }
    } finally {
      this.context.db.exec("DROP TABLE IF EXISTS lexical_run_renames");
    }
    return { changed, semanticChanged };
  }
}
