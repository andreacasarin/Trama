import { MAX_MARKDOWN_UTF8_BYTES } from "../Identity";
import {
  SQLITE_MAX_LEXICAL_BATCH_MARKDOWN_BYTES,
  SQLITE_MAX_LEXICAL_BATCH_NOTES,
  SQLITE_MAX_MARKDOWN,
  SQLITE_MAX_NOTES,
  SQLITE_MAX_PATH,
  SQLITE_MAX_RESULTS,
  SQLITE_MAX_SEMANTIC_BATCH_ITEMS,
  SQLITE_MAX_SEMANTIC_INPUT_BYTES,
  SQLITE_MAX_SEMANTIC_VECTOR_BYTES,
  SQLITE_MAX_TEXT,
  SQLITE_PROTOCOL_VERSION,
  SQLITE_SNAPSHOT_MAX_BYTES,
  isSqliteMethod,
  sqliteError,
  type SqliteEmbeddingResult,
  type SqliteLexicalBatchNoteInput,
  type SqliteMethod,
  type SqliteNoteSummary,
  type SqliteRequest,
} from "./protocol";

function validPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= SQLITE_MAX_PATH &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/.test(path) &&
    !path.split("/").some((part) => part === ".." || part === ".")
  );
}
function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}
function validVector(value: unknown, dimensions?: number): value is Float32Array {
  return (
    value instanceof Float32Array &&
    (dimensions === undefined || value.length === dimensions) &&
    value.length > 0 &&
    value.every(Number.isFinite)
  );
}
function validEmbeddingResult(
  value: unknown,
  dimensions: number,
  maxVectorBytes: number
): value is SqliteEmbeddingResult {
  if (!value || typeof value !== "object") return false;
  const result = value as SqliteEmbeddingResult;
  if (
    typeof result.actionKey !== "string" ||
    result.actionKey.length === 0 ||
    result.actionKey.length > SQLITE_MAX_TEXT ||
    result.actionKey.includes("\0") ||
    typeof result.serialization !== "string" ||
    result.serialization.length > SQLITE_MAX_TEXT ||
    new TextEncoder().encode(result.serialization).byteLength > SQLITE_MAX_SEMANTIC_INPUT_BYTES ||
    !Number.isSafeInteger(result.inputId) ||
    result.inputId < 1 ||
    !validVector(result.vector, dimensions) ||
    result.vector.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT
  )
    return false;
  return result.vector.byteLength <= maxVectorBytes;
}
function validSummary(value: unknown): value is SqliteNoteSummary {
  if (!value || typeof value !== "object") return false;
  const s = value as SqliteNoteSummary;
  return (
    validPath(s.path) &&
    validHash(s.contentId) &&
    (s.chunkCount === undefined || (Number.isSafeInteger(s.chunkCount) && s.chunkCount >= 0))
  );
}
function validRunId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function validBatchNote(value: unknown): value is SqliteLexicalBatchNoteInput {
  if (!value || typeof value !== "object") return false;
  const note = value as SqliteLexicalBatchNoteInput;
  return (
    validPath(note.path) &&
    typeof note.markdown === "string" &&
    note.markdown.length <= SQLITE_MAX_MARKDOWN &&
    (note.expectedRevisionDigest === undefined || validHash(note.expectedRevisionDigest)) &&
    (note.size === undefined ||
      (Number.isSafeInteger(note.size) && note.size >= 1 && note.size <= SQLITE_MAX_TEXT))
  );
}
function validPublicationId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0")
  );
}
function validatePayload(method: SqliteMethod, payload: unknown): void {
  if (!payload || typeof payload !== "object")
    throw sqliteError("invalid_request", "Invalid payload");
  const value = payload as Record<string, any>;
  if (method === "boot") {
    if (
      !validHash(value.corpusFingerprint) ||
      (value.embeddingFingerprint !== undefined && !validHash(value.embeddingFingerprint)) ||
      !Number.isSafeInteger(value.dimensions) ||
      value.dimensions < 1 ||
      value.dimensions > 4096 ||
      (value.identity !== undefined && !validHash(value.identity))
    )
      throw sqliteError("invalid_request", "Invalid boot payload");
  } else if (method === "beginLexicalRun") {
    const summaries = value.summaries;
    const scope = value.scope;
    if (
      (value.runId !== undefined && !validRunId(value.runId)) ||
      (value.expectedChangeCounter !== undefined &&
        (!Number.isSafeInteger(value.expectedChangeCounter) || value.expectedChangeCounter < 0)) ||
      (summaries !== undefined &&
        (!Array.isArray(summaries) ||
          summaries.length > SQLITE_MAX_NOTES ||
          !summaries.every(validSummary))) ||
      (scope !== undefined &&
        (!scope ||
          typeof scope !== "object" ||
          typeof scope.mayClearIncomplete !== "boolean" ||
          (scope.renames !== undefined &&
            (!Array.isArray(scope.renames) ||
              scope.renames.length > SQLITE_MAX_NOTES ||
              !scope.renames.every(
                (rename: unknown) =>
                  !!rename &&
                  typeof rename === "object" &&
                  validPath((rename as { from?: unknown }).from) &&
                  validPath((rename as { to?: unknown }).to)
              ))) ||
          (scope.deletes !== undefined &&
            (!Array.isArray(scope.deletes) ||
              scope.deletes.length > SQLITE_MAX_NOTES ||
              !scope.deletes.every(validPath)))))
    )
      throw sqliteError("invalid_request", "Invalid lexical run payload");
  } else if (method === "applyLexicalBatch") {
    const notes = value.notes;
    if (
      !validRunId(value.runId) ||
      !Array.isArray(notes) ||
      notes.length > SQLITE_MAX_LEXICAL_BATCH_NOTES ||
      !notes.every(validBatchNote)
    )
      throw sqliteError("invalid_request", "Invalid lexical batch payload");
    let bytes = 0;
    for (const note of notes as SqliteLexicalBatchNoteInput[]) {
      // Keep this check byte based so multibyte Markdown cannot bypass the aggregate bound.
      bytes += new TextEncoder().encode(note.markdown).byteLength;
      const maxBytes =
        (notes as SqliteLexicalBatchNoteInput[]).length === 1
          ? MAX_MARKDOWN_UTF8_BYTES
          : SQLITE_MAX_LEXICAL_BATCH_MARKDOWN_BYTES;
      if (bytes > maxBytes)
        throw sqliteError("invalid_request", "Lexical batch Markdown exceeds the supported size");
    }
  } else if (method === "finishLexicalRun" || method === "abortLexicalRun") {
    if (!validRunId(value.runId)) throw sqliteError("invalid_request", "Invalid lexical run ID");
  } else if (method === "listLexicalSummaries") {
    // no payload fields
  } else if (method === "prepareSemanticWork") {
    if (
      !validHash(value.embeddingFingerprint) ||
      (value.preprocessing !== undefined &&
        (typeof value.preprocessing !== "string" || value.preprocessing.length > 128)) ||
      !Number.isSafeInteger(value.limit) ||
      value.limit < 0 ||
      value.limit > SQLITE_MAX_SEMANTIC_BATCH_ITEMS ||
      (value.maxInputBytes !== undefined &&
        (!Number.isSafeInteger(value.maxInputBytes) ||
          value.maxInputBytes < 1 ||
          value.maxInputBytes > SQLITE_MAX_SEMANTIC_INPUT_BYTES)) ||
      (value.promoteUnrestricted !== undefined && typeof value.promoteUnrestricted !== "boolean")
    )
      throw sqliteError("invalid_request", "Invalid semantic work request");
  } else if (method === "commitSemanticResults") {
    if (
      !validHash(value.embeddingFingerprint) ||
      (value.preprocessing !== undefined &&
        (typeof value.preprocessing !== "string" || value.preprocessing.length > 128)) ||
      !Number.isSafeInteger(value.dimensions) ||
      value.dimensions < 1 ||
      value.dimensions > 4096 ||
      !Number.isSafeInteger(value.expectedCount) ||
      value.expectedCount < 0 ||
      value.expectedCount > SQLITE_MAX_SEMANTIC_BATCH_ITEMS ||
      !Array.isArray(value.results) ||
      value.results.length !== value.expectedCount ||
      value.results.length > SQLITE_MAX_SEMANTIC_BATCH_ITEMS
    )
      throw sqliteError("invalid_request", "Invalid semantic result batch");
    let inputBytes = 0;
    let vectorBytes = 0;
    for (const result of value.results as SqliteEmbeddingResult[]) {
      if (!validEmbeddingResult(result, value.dimensions, SQLITE_MAX_SEMANTIC_VECTOR_BYTES))
        throw sqliteError("invalid_request", "Invalid semantic result");
      inputBytes += new TextEncoder().encode(result.serialization).byteLength;
      vectorBytes += result.vector.byteLength;
      if (
        inputBytes > SQLITE_MAX_SEMANTIC_INPUT_BYTES ||
        vectorBytes > SQLITE_MAX_SEMANTIC_VECTOR_BYTES
      )
        throw sqliteError("invalid_request", "Semantic result batch exceeds supported bounds");
    }
  } else if (method === "clearSemanticCache") {
    // no payload fields
  } else if (method === "retrieve") {
    if (
      (value.query !== undefined &&
        (typeof value.query !== "string" || value.query.length > SQLITE_MAX_TEXT)) ||
      (value.vector !== undefined && !validVector(value.vector)) ||
      !Number.isSafeInteger(value.limit) ||
      value.limit < 0 ||
      value.limit > SQLITE_MAX_RESULTS ||
      (value.currentPath !== undefined && !validPath(value.currentPath))
    )
      throw sqliteError("invalid_request", "Invalid retrieve payload");
  } else if (method === "findRelated") {
    if (
      !validPath(value.path) ||
      (value.vector !== undefined && !validVector(value.vector)) ||
      !Number.isSafeInteger(value.limit) ||
      value.limit < 0 ||
      value.limit > SQLITE_MAX_RESULTS
    )
      throw sqliteError("invalid_request", "Invalid related payload");
  } else if (method === "preparePublication") {
    if (!validPublicationId(value.publicationId))
      throw sqliteError("invalid_request", "Invalid publication ID");
  } else if (method === "finalizePublication") {
    if (
      !validPublicationId(value.publicationId) ||
      !Number.isSafeInteger(value.expectedChangeCounter) ||
      value.expectedChangeCounter < 0
    )
      throw sqliteError("invalid_request", "Invalid publication finalization payload");
  } else if (method === "inspectPublication" || method === "adoptPublication") {
    if (
      !(value.bytes instanceof ArrayBuffer) ||
      value.bytes.byteLength === 0 ||
      value.bytes.byteLength > SQLITE_SNAPSHOT_MAX_BYTES ||
      (value.expectedPublicationId !== undefined &&
        !validPublicationId(value.expectedPublicationId))
    )
      throw sqliteError("invalid_request", "Invalid publication bytes");
  }
}
export function validateRequest(value: unknown): asserts value is SqliteRequest {
  if (!value || typeof value !== "object")
    throw sqliteError("invalid_request", "Invalid request envelope");
  const request = value as SqliteRequest;
  if (
    request.v !== SQLITE_PROTOCOL_VERSION ||
    !Number.isSafeInteger(request.id) ||
    request.id < 1 ||
    !isSqliteMethod(request.method)
  )
    throw sqliteError("invalid_request", "Invalid request envelope");
  validatePayload(request.method, request.payload);
}
