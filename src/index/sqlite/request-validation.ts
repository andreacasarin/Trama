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
function validOptionalText(value: unknown, maxLength = SQLITE_MAX_TEXT): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && value.length <= maxLength && !value.includes("\0"))
  );
}
function validOptionalGeneration(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
}
function validOptionalDimensions(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 4096)
  );
}
function validOptionalResultLimit(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= SQLITE_MAX_RESULTS)
  );
}
function validSnapshotExpectations(value: Record<string, any>): boolean {
  return (
    (value.corpusFingerprint === undefined || validHash(value.corpusFingerprint)) &&
    (value.embeddingFingerprint === undefined || validHash(value.embeddingFingerprint)) &&
    validOptionalText(value.buildIdentity, 256) &&
    validOptionalDimensions(value.dimensions)
  );
}
function assertNever(value: never): never {
  throw sqliteError("invalid_request", `Unsupported SQLite method: ${String(value)}`);
}
function validatePayload(method: SqliteMethod, payload: unknown): void {
  if (!payload || typeof payload !== "object")
    throw sqliteError("invalid_request", "Invalid payload");
  const value = payload as Record<string, any>;
  switch (method) {
    case "boot":
      if (
        !validHash(value.corpusFingerprint) ||
        (value.embeddingFingerprint !== undefined && !validHash(value.embeddingFingerprint)) ||
        !validOptionalText(value.buildIdentity, 256) ||
        !validOptionalDimensions(value.dimensions) ||
        value.dimensions === undefined ||
        (value.identity !== undefined && !validHash(value.identity))
      )
        throw sqliteError("invalid_request", "Invalid boot payload");
      return;
    case "getState":
    case "markIncomplete":
    case "listLexicalSummaries":
    case "clearSemanticCache":
    case "shutdown":
      return;
    case "beginLexicalRun": {
      const summaries = value.summaries;
      const scope = value.scope;
      if (
        (value.runId !== undefined && !validRunId(value.runId)) ||
        !validOptionalGeneration(value.expectedChangeCounter) ||
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
      return;
    }
    case "applyLexicalBatch": {
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
        bytes += new TextEncoder().encode(note.markdown).byteLength;
        const maxBytes =
          notes.length === 1 ? MAX_MARKDOWN_UTF8_BYTES : SQLITE_MAX_LEXICAL_BATCH_MARKDOWN_BYTES;
        if (bytes > maxBytes)
          throw sqliteError("invalid_request", "Lexical batch Markdown exceeds the supported size");
      }
      return;
    }
    case "finishLexicalRun":
    case "abortLexicalRun":
      if (!validRunId(value.runId)) throw sqliteError("invalid_request", "Invalid lexical run ID");
      return;
    case "prepareSemanticWork":
      if (
        !validHash(value.embeddingFingerprint) ||
        !validOptionalText(value.preprocessing, 128) ||
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
      return;
    case "commitSemanticResults": {
      if (
        !validHash(value.embeddingFingerprint) ||
        !validOptionalText(value.preprocessing, 128) ||
        !validOptionalDimensions(value.dimensions) ||
        value.dimensions === undefined ||
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
      return;
    }
    case "retrieve":
      if (
        (value.query !== undefined &&
          (typeof value.query !== "string" || value.query.length > SQLITE_MAX_TEXT)) ||
        (value.vector !== undefined && !validVector(value.vector)) ||
        !Number.isSafeInteger(value.limit) ||
        value.limit < 0 ||
        value.limit > SQLITE_MAX_RESULTS ||
        (value.currentPath !== undefined && !validPath(value.currentPath)) ||
        !validOptionalResultLimit(value.semanticCandidateLimit) ||
        !validOptionalResultLimit(value.lexicalCandidateLimit) ||
        (value.lexicalProfile !== undefined &&
          value.lexicalProfile !== "voce" &&
          value.lexicalProfile !== "lente") ||
        (value.resultShape !== undefined &&
          value.resultShape !== "chunks" &&
          value.resultShape !== "notes")
      )
        throw sqliteError("invalid_request", "Invalid retrieve payload");
      return;
    case "findRelated":
      if (
        !validPath(value.path) ||
        (value.vector !== undefined && !validVector(value.vector)) ||
        !Number.isSafeInteger(value.limit) ||
        value.limit < 0 ||
        value.limit > SQLITE_MAX_RESULTS
      )
        throw sqliteError("invalid_request", "Invalid related payload");
      return;
    case "preparePublication":
      if (!validPublicationId(value.publicationId))
        throw sqliteError("invalid_request", "Invalid publication ID");
      return;
    case "finalizePublication":
      if (
        !validPublicationId(value.publicationId) ||
        !Number.isSafeInteger(value.expectedChangeCounter) ||
        value.expectedChangeCounter < 0 ||
        !validOptionalGeneration(value.expectedLexicalGeneration) ||
        !validOptionalGeneration(value.expectedSemanticGeneration)
      )
        throw sqliteError("invalid_request", "Invalid publication finalization payload");
      return;
    case "inspectPublication":
    case "adoptPublication":
      if (
        !(value.bytes instanceof ArrayBuffer) ||
        value.bytes.byteLength === 0 ||
        value.bytes.byteLength > SQLITE_SNAPSHOT_MAX_BYTES ||
        (value.expectedPublicationId !== undefined &&
          !validPublicationId(value.expectedPublicationId)) ||
        (value.inspection !== undefined &&
          (!value.inspection ||
            typeof value.inspection !== "object" ||
            value.inspection.valid !== true ||
            !validPublicationId(value.inspection.publicationId) ||
            !value.inspection.state ||
            typeof value.inspection.state !== "object" ||
            !Number.isSafeInteger(value.inspection.byteSize) ||
            value.inspection.byteSize < 1 ||
            value.inspection.byteSize > SQLITE_SNAPSHOT_MAX_BYTES)) ||
        !validSnapshotExpectations(value)
      )
        throw sqliteError("invalid_request", "Invalid publication bytes");
      return;
    case "cancelQueued":
      if (
        value.requestId !== undefined &&
        (!Number.isSafeInteger(value.requestId) || value.requestId < 1)
      )
        throw sqliteError("invalid_request", "Invalid cancellation request ID");
      return;
    default:
      return assertNever(method);
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
