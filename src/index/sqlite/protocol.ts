import { MAX_MARKDOWN_UTF8_BYTES } from "../Identity";

/** Closed, versioned protocol for the mutable SQLite index. */
export const SQLITE_PROTOCOL_VERSION = 8 as const;
export const SQLITE_MAX_PATH = 4096;
export const SQLITE_MAX_TEXT = 2_000_000;
// Character bound is conservative; hashMarkdown enforces the exact 16 MiB UTF-8 bound.
export const SQLITE_MAX_MARKDOWN = 16 * 1024 * 1024;
export const SQLITE_MAX_NOTES = 100_000;
export const SQLITE_MAX_CHUNKS = 1_000_000;
export const SQLITE_MAX_RESULTS = 256;
/** Bounds for one set-based semantic executor slice. */
export const SQLITE_MAX_SEMANTIC_BATCH_ITEMS = 128;
export const SQLITE_MAX_SEMANTIC_INPUT_BYTES = 4 * 1024 * 1024;
export const SQLITE_MAX_SEMANTIC_VECTOR_BYTES = 8 * 1024 * 1024;
export const SQLITE_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Bounds for one additive bounded lexical operation. */
export const SQLITE_MAX_LEXICAL_BATCH_NOTES = 16;
export const SQLITE_MAX_LEXICAL_BATCH_MARKDOWN_BYTES = 8 * 1024 * 1024;
export const SQLITE_MAX_LEXICAL_BATCH_OCCURRENCES = 2_000;

export type SqliteMethod =
  | "boot"
  | "getState"
  | "markIncomplete"
  | "beginLexicalRun"
  | "applyLexicalBatch"
  | "finishLexicalRun"
  | "abortLexicalRun"
  | "listLexicalSummaries"
  | "prepareSemanticWork"
  | "commitSemanticResults"
  | "clearSemanticCache"
  | "retrieve"
  | "findRelated"
  | "preparePublication"
  | "finalizePublication"
  | "inspectPublication"
  | "adoptPublication"
  | "cancelQueued"
  | "shutdown";

export interface SqliteLexicalBlockInput {
  readonly ordinal: number;
  readonly kind: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly displayText: string;
  readonly headingContext: readonly string[];
  readonly embeddingInput: string;
  readonly embeddingInputDigest: string;
}
export interface SqliteLexicalRevisionInput {
  readonly path: string;
  readonly revisionDigest: string;
  readonly blocks: readonly SqliteLexicalBlockInput[];
}
/** Markdown supplied to the bounded lexical Worker operation. */
export interface SqliteLexicalBatchNoteInput {
  readonly path: string;
  readonly markdown: string;
  /** Optional caller-observed digest used to fence a stale read. */
  readonly expectedRevisionDigest?: string;
  readonly size?: number;
}
export interface SqliteLexicalBatchResult {
  readonly runId: string;
  readonly changed: boolean;
  readonly applied: number;
  readonly changedCount: number;
  readonly skipped: number;
  readonly occurrences: number;
  readonly inputHashCount?: number;
  readonly inputHashBytes?: number;
  readonly receipt: SqliteMutationReceipt;
}
export interface SqliteLexicalScope {
  readonly renames?: readonly { readonly from: string; readonly to: string }[];
  readonly deletes?: readonly string[];
  /** Complete only when the caller observed a complete database and its fence stayed stable. */
  readonly mayClearIncomplete: boolean;
}
export interface SqliteLexicalRunResult {
  readonly runId: string;
  readonly state: SqliteState;
  readonly receipt: SqliteMutationReceipt;
  readonly complete?: boolean;
  readonly remaining?: number;
  readonly renamed?: number;
  readonly deleted?: number;
}
export interface SqliteLexicalSummary {
  readonly noteId: number;
  readonly path: string;
  readonly revisionDigest?: string;
  readonly lexicalRevisionId?: number;
  readonly semanticRevisionId?: number;
}
export interface SqliteEmbeddingRequest {
  readonly actionKey: string;
  readonly inputId: number;
  readonly serialization: string;
}
export interface SqliteEmbeddingResult {
  readonly actionKey: string;
  readonly inputId: number;
  readonly serialization: string;
  readonly vector: Float32Array;
}
export interface SqliteSemanticWorkBatch {
  readonly requests: readonly SqliteEmbeddingRequest[];
  readonly hasMore: boolean;
  readonly generation: SqliteGenerationToken;
  readonly promoted: number;
}
export interface SqliteSemanticCommitResult {
  readonly stored: number;
  readonly skipped: number;
  readonly promoted: number;
  readonly hasMore: boolean;
  readonly generation: SqliteGenerationToken;
}
export type VectorCoverage = "none" | "partial" | "complete";
export interface SqliteGenerationToken {
  readonly changeCounter: number;
  readonly lexicalGeneration: number;
  readonly semanticGeneration: number;
}
/** Internal receipt metadata carried by later asynchronous slices. */
export interface SqliteMutationReceipt {
  readonly changed: boolean;
  readonly status: SqliteMutationStatus;
  readonly generation: SqliteGenerationToken;
}
export interface SqliteState {
  readonly schemaVersion: number;
  readonly protocolVersion: number;
  readonly buildIdentity: string;
  readonly dimensions: number;
  readonly corpusFingerprint: string;
  readonly embeddingFingerprint: string;
  readonly incomplete: boolean;
  readonly snapshotLoaded: boolean;
  readonly changeCounter: number;
  /** Present in protocol v8; optional for structural compatibility with older adapters. */
  readonly lexicalGeneration?: number;
  readonly semanticGeneration?: number;
  readonly noteCount: number;
  readonly chunkCount: number;
  readonly compatibleVectorCount: number;
  readonly vectorCount: number;
  readonly vectorCoverage: VectorCoverage;
  readonly semanticReady: boolean;
  /** Counts derived from active lexical/semantic revision heads. */
  readonly semanticEligibleCount?: number;
  readonly semanticHeadCount?: number;
  readonly semanticLagCount?: number;
  readonly semanticMissingCount?: number;
  /** @deprecated The v7 O(N) head key is no longer returned. */
  readonly semanticHeadKey?: never;
  readonly publicationId?: string;
}
export interface SqliteNoteSummary {
  readonly path: string;
  readonly contentId: string;
  readonly chunkCount?: number;
}
export interface SqliteReconciliationPlan {
  readonly renames: readonly { from: string; to: string; contentId: string }[];
  readonly upserts: readonly SqliteNoteSummary[];
  readonly deletes: readonly SqliteNoteSummary[];
  readonly state: SqliteState;
}
export type SqliteMutationStatus =
  "changed" | "unchanged" | "absent" | "alreadyApplied" | "state_changed";
export function sqliteGenerationToken(state: SqliteState): SqliteGenerationToken {
  return {
    changeCounter: state.changeCounter,
    lexicalGeneration: state.lexicalGeneration ?? 0,
    semanticGeneration: state.semanticGeneration ?? 0,
  };
}
export function sqliteMutationReceipt(
  state: SqliteState,
  changed: boolean,
  status: SqliteMutationStatus
): SqliteMutationReceipt {
  return { changed, status, generation: sqliteGenerationToken(state) };
}
export interface SqliteHit {
  readonly id: string;
  readonly path: string;
  readonly contentId: string;
  readonly ordinal: number;
  readonly score: number;
  readonly fusedScore?: number;
  readonly semanticScore?: number;
  readonly lexicalScore?: number;
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
}
export interface PublicationPrepared {
  readonly publicationId: string;
  readonly state: SqliteState;
  readonly bytes: ArrayBuffer;
  readonly byteSize: number;
  readonly durationMs: number;
  readonly copyBytes: number;
}
export interface PublicationInspection {
  readonly valid: true;
  readonly publicationId: string;
  readonly state: SqliteState;
  readonly byteSize: number;
}

export interface SqliteRequestPayloads {
  boot: {
    readonly corpusFingerprint: string;
    readonly embeddingFingerprint?: string;
    readonly buildIdentity?: string;
    readonly dimensions: number;
    readonly identity?: string;
  };
  getState: Record<string, never>;
  markIncomplete: Record<string, never>;
  beginLexicalRun: {
    readonly runId?: string;
    readonly summaries?: readonly SqliteNoteSummary[];
    readonly expectedChangeCounter?: number;
    readonly scope?: SqliteLexicalScope;
  };
  applyLexicalBatch: {
    readonly runId: string;
    readonly notes: readonly SqliteLexicalBatchNoteInput[];
  };
  finishLexicalRun: { readonly runId: string };
  abortLexicalRun: { readonly runId: string };
  listLexicalSummaries: Record<string, never>;
  prepareSemanticWork: {
    readonly embeddingFingerprint: string;
    readonly preprocessing?: string;
    readonly limit: number;
    readonly maxInputBytes?: number;
    /** Run the unrestricted cached-head promotion pass before selecting work. */
    readonly promoteUnrestricted?: boolean;
  };
  commitSemanticResults: {
    readonly embeddingFingerprint: string;
    readonly preprocessing?: string;
    readonly dimensions: number;
    readonly expectedCount: number;
    readonly results: readonly SqliteEmbeddingResult[];
  };
  clearSemanticCache: Record<string, never>;
  retrieve: {
    readonly query?: string;
    readonly vector?: Float32Array;
    readonly limit: number;
    readonly currentPath?: string;
    readonly semanticCandidateLimit?: number;
    readonly lexicalCandidateLimit?: number;
    readonly lexicalProfile?: "voce" | "lente";
    readonly resultShape?: "chunks" | "notes";
  };
  findRelated: { readonly path: string; readonly vector?: Float32Array; readonly limit: number };
  preparePublication: { readonly publicationId: string };
  finalizePublication: {
    readonly publicationId: string;
    readonly expectedChangeCounter: number;
    readonly expectedLexicalGeneration?: number;
    readonly expectedSemanticGeneration?: number;
  };
  inspectPublication: {
    readonly bytes: ArrayBuffer;
    readonly corpusFingerprint?: string;
    readonly embeddingFingerprint?: string;
    readonly buildIdentity?: string;
    readonly dimensions?: number;
  };
  adoptPublication: {
    readonly bytes: ArrayBuffer;
    readonly expectedPublicationId?: string;
    /** Candidate was validated by inspectPublication on the same byte buffer. */
    readonly inspection?: PublicationInspection;
    readonly corpusFingerprint?: string;
    readonly embeddingFingerprint?: string;
    readonly buildIdentity?: string;
    readonly dimensions?: number;
  };
  cancelQueued: { readonly requestId?: number };
  shutdown: Record<string, never>;
}
export type SqliteRequest<M extends SqliteMethod = SqliteMethod> = {
  readonly v: typeof SQLITE_PROTOCOL_VERSION;
  readonly id: number;
  readonly method: M;
  readonly payload: SqliteRequestPayloads[M];
};
export interface SqliteErrorShape {
  readonly code:
    | "cancelled"
    | "busy"
    | "invalid_request"
    | "limit_exceeded"
    | "incompatible_state"
    | "integrity_failed"
    | "storage_unavailable"
    | "unsupported"
    | "worker_crashed"
    | "internal";
  readonly message: string;
  readonly retryable: boolean;
  /** Safe worker source token, never a filesystem path. */
  readonly debugLocation?: string;
  /** Safe request context for Worker diagnostics; never includes payload data. */
  readonly method?: string;
  readonly phase?: "validation" | "dispatch" | "open" | "execute";
}
export type SqliteReply =
  | {
      readonly v: typeof SQLITE_PROTOCOL_VERSION;
      readonly id: number;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly v: typeof SQLITE_PROTOCOL_VERSION;
      readonly id: number;
      readonly ok: false;
      readonly error: SqliteErrorShape;
    };
export class SqliteProtocolError extends Error {
  readonly name = "SqliteProtocolError";
  constructor(readonly error: SqliteErrorShape) {
    super(error.message);
  }
}
export function sqliteError(
  code: SqliteErrorShape["code"],
  message: string,
  retryable = false,
  phase?: SqliteErrorShape["phase"]
): SqliteProtocolError {
  return new SqliteProtocolError({
    code,
    message,
    retryable,
    ...(phase ? { phase } : {}),
  });
}

const METHODS: readonly SqliteMethod[] = [
  "boot",
  "getState",
  "markIncomplete",
  "beginLexicalRun",
  "applyLexicalBatch",
  "finishLexicalRun",
  "abortLexicalRun",
  "listLexicalSummaries",
  "prepareSemanticWork",
  "commitSemanticResults",
  "clearSemanticCache",
  "retrieve",
  "findRelated",
  "preparePublication",
  "finalizePublication",
  "inspectPublication",
  "adoptPublication",
  "cancelQueued",
  "shutdown",
];
export function isSqliteMethod(value: unknown): value is SqliteMethod {
  return typeof value === "string" && METHODS.includes(value as SqliteMethod);
}
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
