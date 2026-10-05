import { chunkMarkdownBlocks } from "../chunking";
import {
  createInputDigest,
  deriveNoteContentId,
  MAX_MARKDOWN_UTF8_BYTES,
  utf8ByteLength,
} from "../Identity";
import {
  SQLITE_MAX_LEXICAL_BATCH_MARKDOWN_BYTES,
  SQLITE_MAX_LEXICAL_BATCH_NOTES,
  SQLITE_MAX_LEXICAL_BATCH_OCCURRENCES,
  SQLITE_MAX_CHUNKS,
  sqliteError,
  type SqliteLexicalBatchNoteInput,
  type SqliteLexicalBatchResult,
  type SqliteLexicalRevisionInput,
} from "./protocol";
import type { MutableSqliteDatabase } from "./database";

export type LexicalMarkdownPhase = "lexicalInputPreparation" | "lexicalSqlMutation";
export type LexicalMarkdownPhaseObserver = (
  phase: LexicalMarkdownPhase,
  durationMs: number
) => void;

function fullNoteLexicalText(path: string, markdown: string) {
  const headings: string[] = [];
  const body: string[] = [];
  let title = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  let hasTitle = false;
  let fence: string | undefined;
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fenceLine = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceLine) {
      const marker = fenceLine[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      body.push(line);
      continue;
    }
    const setext = !fence && line.trim() ? lines[index + 1]?.match(/^ {0,3}(=+|-+)[ \t]*$/) : null;
    if (setext) {
      const text = line.trim();
      headings.push(text);
      if (setext[1][0] === "=" && !hasTitle) {
        title = text;
        hasTitle = true;
      }
      index++;
      continue;
    }
    const heading = fence ? null : line.match(/^ {0,3}(#{1,6})[ \t]+(.*?)\s*#*[ \t]*$/);
    if (!heading) {
      body.push(line);
      continue;
    }
    const text = heading[2].trim();
    headings.push(text);
    if (heading[1].length === 1 && !hasTitle) {
      title = text;
      hasTitle = true;
    }
  }
  return { title, headings: headings.join("\n"), body: body.join("\n") };
}

export async function hashMarkdown(
  markdown: string,
  corpusFingerprint: string,
  signal?: AbortSignal
): Promise<string> {
  if (utf8ByteLength(markdown) > MAX_MARKDOWN_UTF8_BYTES)
    throw sqliteError("invalid_request", "Markdown exceeds the supported UTF-8 size");
  let contentId: string;
  try {
    contentId = await deriveNoteContentId(corpusFingerprint, markdown);
  } catch {
    throw sqliteError("storage_unavailable", "SHA-256 hashing is unavailable", true);
  }
  if (signal?.aborted) throw sqliteError("cancelled", "Request cancelled", true);
  return contentId;
}

/**
 * Hash and parse one bounded batch in the Worker, then commit it in one SQLite
 * transaction. The active digest is checked before chunking each note so an
 * unchanged note never enters the parser.
 */
export async function applyLexicalMarkdownBatch(
  database: MutableSqliteDatabase,
  runId: string,
  notes: readonly SqliteLexicalBatchNoteInput[],
  signal?: AbortSignal,
  onPhase?: LexicalMarkdownPhaseObserver
): Promise<SqliteLexicalBatchResult> {
  if (notes.length > SQLITE_MAX_LEXICAL_BATCH_NOTES)
    throw sqliteError("invalid_request", "Lexical batch is too large");
  const paths = new Set<string>();
  let markdownBytes = 0;
  for (const note of notes) {
    if (paths.has(note.path))
      throw sqliteError("invalid_request", "Lexical batch contains duplicate paths");
    paths.add(note.path);
    markdownBytes += utf8ByteLength(note.markdown);
    const maxBytes =
      notes.length === 1 ? MAX_MARKDOWN_UTF8_BYTES : SQLITE_MAX_LEXICAL_BATCH_MARKDOWN_BYTES;
    if (markdownBytes > maxBytes)
      throw sqliteError("invalid_request", "Lexical batch Markdown exceeds the supported size");
  }
  let skipped = 0;
  let inputHashCount = 0;
  let inputHashBytes = 0;
  let changed = false;
  let applied = 0;
  let changedCount = 0;
  let occurrences = 0;
  let receipt: SqliteLexicalBatchResult["receipt"] | undefined;
  let pending: SqliteLexicalRevisionInput[] = [];
  let pendingOccurrences = 0;
  let inputPreparationMs = 0;
  let sqlMutationMs = 0;
  const mutate = <T>(operation: () => T): T => {
    if (!onPhase) return operation();
    const started = performance.now();
    try {
      return operation();
    } finally {
      sqlMutationMs += Math.max(0, performance.now() - started);
    }
  };
  const merge = (result: SqliteLexicalBatchResult): void => {
    changed ||= result.changed;
    applied += result.applied;
    changedCount += result.changedCount;
    skipped += result.skipped;
    occurrences += result.occurrences;
    receipt = result.receipt;
  };
  const flush = (): void => {
    if (!pending.length) return;
    mutate(() => merge(database.applyLexicalBatch(runId, pending)));
    pending = [];
    pendingOccurrences = 0;
  };
  const corpusFingerprint = database.getCorpusFingerprint();
  try {
    for (const note of notes) {
      const preparationStarted = onPhase ? performance.now() : undefined;
      const mutationBeforePreparation = sqlMutationMs;
      try {
        if (signal?.aborted) throw sqliteError("cancelled", "Request cancelled", true);
        const revisionDigest = await hashMarkdown(note.markdown, corpusFingerprint, signal);
        if (note.expectedRevisionDigest && note.expectedRevisionDigest !== revisionDigest)
          throw sqliteError("busy", "Lexical input changed while it was being indexed", true);
        // This read is deliberately before chunkMarkdownBlocks.
        if (database.getLexicalRevisionDigest(note.path) === revisionDigest) {
          skipped++;
          continue;
        }
        let blocks;
        try {
          blocks = chunkMarkdownBlocks(note.markdown, note.size ?? 384, signal);
        } catch (error) {
          if (
            signal?.aborted ||
            (error instanceof Error && error.message === "Operation cancelled")
          )
            throw sqliteError("cancelled", "Request cancelled", true);
          throw error;
        }
        if (blocks.length > SQLITE_MAX_CHUNKS)
          throw sqliteError("invalid_request", "Note has too many blocks");
        const input: SqliteLexicalRevisionInput = {
          path: note.path,
          revisionDigest,
          lexical: fullNoteLexicalText(note.path, note.markdown),
          blocks: await Promise.all(
            blocks.map(async (block, ordinal) => {
              inputHashCount++;
              inputHashBytes += utf8ByteLength(block.embeddingInput);
              return {
                ordinal,
                kind: block.kind,
                startLine: block.startLine,
                endLine: block.endLine,
                displayText: block.body,
                headingContext: block.headingContext,
                embeddingInput: block.embeddingInput,
                embeddingInputDigest: await createInputDigest(block.embeddingInput),
              };
            })
          ),
        };
        if (input.blocks.length > SQLITE_MAX_LEXICAL_BATCH_OCCURRENCES) {
          flush();
          mutate(() => merge(database.stageLexicalRevision(runId, input, signal)));
        } else {
          if (
            pending.length &&
            pendingOccurrences + input.blocks.length > SQLITE_MAX_LEXICAL_BATCH_OCCURRENCES
          )
            flush();
          pending.push(input);
          pendingOccurrences += input.blocks.length;
        }
      } finally {
        if (preparationStarted !== undefined)
          inputPreparationMs += Math.max(
            0,
            performance.now() - preparationStarted - (sqlMutationMs - mutationBeforePreparation)
          );
      }
    }
    flush();
    // An empty apply still performs run renames and returns a receipt.
    if (!receipt) mutate(() => merge(database.applyLexicalBatch(runId, [])));
    return {
      runId,
      changed,
      applied,
      changedCount,
      skipped,
      occurrences,
      receipt: receipt!,
      inputHashCount,
      inputHashBytes,
    };
  } catch (error) {
    database.discardLexicalStaging(runId);
    throw error;
  } finally {
    if (onPhase) {
      for (const [phase, durationMs] of [
        ["lexicalInputPreparation", inputPreparationMs],
        ["lexicalSqlMutation", sqlMutationMs],
      ] as const)
        try {
          onPhase(phase, durationMs);
        } catch {
          // Diagnostic observation cannot change the lexical result.
        }
    }
  }
}
