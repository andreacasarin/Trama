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
  type SqliteMutationResult,
  type SqliteLexicalRevisionInput,
} from "./protocol";
import type { MutableSqliteDatabase } from "./database";

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

/** Slice 3 API: parse Markdown blocks and activate an immutable lexical revision. */
export async function upsertLexicalMarkdown(
  database: MutableSqliteDatabase,
  path: string,
  markdown: string,
  expectedRevisionDigest: string,
  size = 384,
  signal?: AbortSignal
): Promise<SqliteMutationResult & { readonly blockCount: number }> {
  const corpusFingerprint = database.getCorpusFingerprint();
  const revisionDigest = await hashMarkdown(markdown, corpusFingerprint, signal);
  if (revisionDigest !== expectedRevisionDigest)
    return {
      changed: false,
      status: "state_changed",
      rescan: true,
      state: database.getState(),
      blockCount: 0,
    };
  const blocks = chunkMarkdownBlocks(markdown, size, signal);
  if (blocks.length > SQLITE_MAX_CHUNKS)
    throw sqliteError("invalid_request", "Note has too many blocks");
  let inputHashBytes = 0;
  const input: SqliteLexicalRevisionInput = {
    path,
    revisionDigest,
    blocks: await Promise.all(
      blocks.map(async (block, ordinal) => {
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
  if (signal?.aborted) throw sqliteError("cancelled", "Request cancelled", true);
  const result = database.upsertLexicalRevision(input);
  return {
    ...result,
    blockCount: blocks.length,
    inputHashCount: blocks.length,
    inputHashBytes,
  };
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
  signal?: AbortSignal
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
    merge(database.applyLexicalBatch(runId, pending));
    pending = [];
    pendingOccurrences = 0;
  };
  const corpusFingerprint = database.getCorpusFingerprint();
  try {
    for (const note of notes) {
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
        if (signal?.aborted || (error instanceof Error && error.message === "Operation cancelled"))
          throw sqliteError("cancelled", "Request cancelled", true);
        throw error;
      }
      if (blocks.length > SQLITE_MAX_CHUNKS)
        throw sqliteError("invalid_request", "Note has too many blocks");
      const input: SqliteLexicalRevisionInput = {
        path: note.path,
        revisionDigest,
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
        merge(database.stageLexicalRevision(runId, input, signal));
      } else {
        if (
          pending.length &&
          pendingOccurrences + input.blocks.length > SQLITE_MAX_LEXICAL_BATCH_OCCURRENCES
        )
          flush();
        pending.push(input);
        pendingOccurrences += input.blocks.length;
      }
    }
    flush();
    // An empty apply still performs run renames and returns a receipt.
    if (!receipt) merge(database.applyLexicalBatch(runId, []));
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
  }
}
