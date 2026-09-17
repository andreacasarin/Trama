import { chunkMarkdown } from "../chunking";
import { deriveNoteContentId } from "../Identity";
import { SQLITE_MAX_CHUNKS, sqliteError, type SqliteMutationResult } from "./protocol";
import type { MutableSqliteDatabase } from "./database";

export async function hashMarkdown(
  markdown: string,
  corpusFingerprint: string,
  signal?: AbortSignal
): Promise<string> {
  const contentId = await deriveNoteContentId(corpusFingerprint, markdown);
  if (signal?.aborted) throw sqliteError("cancelled", "Request cancelled", true);
  return contentId;
}

export async function upsertMarkdown(
  database: MutableSqliteDatabase,
  path: string,
  markdown: string,
  expectedContentId: string,
  size: number,
  overlap: number,
  signal?: AbortSignal
): Promise<SqliteMutationResult & { readonly chunkCount: number }> {
  const contentId = await hashMarkdown(markdown, database.getState().corpusFingerprint, signal);
  if (contentId !== expectedContentId)
    return {
      changed: false,
      status: "state_changed",
      rescan: true,
      state: database.getState(),
      chunkCount: 0,
    };
  const chunks = chunkMarkdown(markdown, size, overlap, signal);
  if (signal?.aborted) throw sqliteError("cancelled", "Request cancelled", true);
  if (chunks.length > SQLITE_MAX_CHUNKS)
    throw sqliteError("invalid_request", "Note has too many chunks");
  const result = database.upsertNote({
    path,
    contentId,
    chunks: chunks.map((chunk, ordinal) => ({
      id: `${contentId}:${ordinal}`,
      ordinal,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      text: chunk.text,
    })),
  });
  return { ...result, chunkCount: chunks.length };
}
