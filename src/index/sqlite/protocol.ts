/** Closed, versioned protocol for the mutable SQLite index. */
export const SQLITE_PROTOCOL_VERSION = 4 as const;
export const SQLITE_MAX_PATH = 4096;
export const SQLITE_MAX_TEXT = 2_000_000;
export const SQLITE_MAX_MARKDOWN = 256 * 1024 * 1024;
export const SQLITE_MAX_NOTES = 100_000;
export const SQLITE_MAX_CHUNKS = 1_000_000;
export const SQLITE_MAX_RESULTS = 256;
export const SQLITE_MAX_VECTOR_BATCH = 512;
export const SQLITE_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export type SqliteMethod =
  | "boot"
  | "getState"
  | "listNotes"
  | "planReconciliation"
  | "markIncomplete"
  | "beginRebuild"
  | "clearVectors"
  | "hashMarkdown"
  | "upsertMarkdown"
  | "renameNote"
  | "deleteNote"
  | "finishReconciliation"
  | "listMissingVectors"
  | "storeVectors"
  | "retrieve"
  | "findRelated"
  | "preparePublication"
  | "finalizePublication"
  | "inspectPublication"
  | "adoptPublication"
  | "cancelQueued"
  | "shutdown";

export interface SqliteChunkInput {
  readonly id: string;
  readonly ordinal: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}
export interface SqliteNoteInput {
  readonly path: string;
  readonly contentId: string;
  readonly chunks: readonly SqliteChunkInput[];
}
export type VectorCoverage = "none" | "partial" | "complete";
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
  readonly noteCount: number;
  readonly chunkCount: number;
  readonly compatibleVectorCount: number;
  readonly vectorCount: number;
  readonly vectorCoverage: VectorCoverage;
  readonly semanticReady: boolean;
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
export interface SqliteMutationResult {
  readonly changed: boolean;
  readonly status: SqliteMutationStatus;
  readonly rescan?: boolean;
  readonly state: SqliteState;
}
export interface MissingVector {
  readonly chunkPk: number;
  readonly chunkId: string;
  readonly contentId: string;
  readonly ordinal: number;
  readonly text: string;
}
export interface StoredVectorInput {
  readonly chunkPk: number;
  readonly chunkId: string;
  readonly contentId: string;
  readonly vector: Float32Array;
}
export interface StoreVectorsPayload {
  readonly vectors: readonly StoredVectorInput[];
  readonly embeddingFingerprint: string;
  readonly observedChangeCounter: number;
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
  listNotes: Record<string, never>;
  planReconciliation: { readonly summaries: readonly SqliteNoteSummary[] };
  markIncomplete: Record<string, never>;
  beginRebuild: Record<string, never>;
  clearVectors: Record<string, never>;
  hashMarkdown: { readonly markdown: string; readonly corpusFingerprint: string };
  upsertMarkdown: {
    readonly path: string;
    readonly markdown: string;
    readonly expectedContentId: string;
    readonly size: number;
    readonly overlap: number;
  };
  renameNote: { readonly from: string; readonly to: string; readonly contentId?: string };
  deleteNote: { readonly path: string; readonly contentId?: string };
  finishReconciliation: {
    readonly observedChangeCounter: number;
    readonly summaries: readonly SqliteNoteSummary[];
  };
  listMissingVectors: {
    readonly embeddingFingerprint?: string;
    readonly limit: number;
    readonly afterChunkPk?: number;
  };
  storeVectors: {
    readonly embeddingFingerprint: string;
    readonly observedChangeCounter: number;
    readonly vectors: readonly StoredVectorInput[];
  };
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
  finalizePublication: { readonly publicationId: string; readonly expectedChangeCounter: number };
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
    | "incompatible_state"
    | "integrity_failed"
    | "storage_unavailable"
    | "unsupported"
    | "worker_crashed"
    | "internal";
  readonly message: string;
  readonly retryable: boolean;
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
  retryable = false
): SqliteProtocolError {
  return new SqliteProtocolError({ code, message, retryable });
}

const METHODS: readonly SqliteMethod[] = [
  "boot",
  "getState",
  "listNotes",
  "planReconciliation",
  "markIncomplete",
  "beginRebuild",
  "clearVectors",
  "hashMarkdown",
  "upsertMarkdown",
  "renameNote",
  "deleteNote",
  "finishReconciliation",
  "listMissingVectors",
  "storeVectors",
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
function validId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0")
  );
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
      value.dimensions > 4096
    )
      throw sqliteError("invalid_request", "Invalid boot payload");
  } else if (method === "hashMarkdown") {
    if (
      typeof value.markdown !== "string" ||
      value.markdown.length > SQLITE_MAX_MARKDOWN ||
      !validHash(value.corpusFingerprint)
    )
      throw sqliteError("invalid_request", "Invalid Markdown hash payload");
  } else if (method === "upsertMarkdown") {
    if (
      !validPath(value.path) ||
      typeof value.markdown !== "string" ||
      value.markdown.length > SQLITE_MAX_MARKDOWN ||
      !validHash(value.expectedContentId) ||
      !Number.isSafeInteger(value.size) ||
      value.size < 1 ||
      value.size > SQLITE_MAX_TEXT ||
      !Number.isSafeInteger(value.overlap) ||
      value.overlap < 0 ||
      value.overlap >= value.size
    )
      throw sqliteError("invalid_request", "Invalid Markdown upsert payload");
  } else if (method === "renameNote") {
    if (
      !validPath(value.from) ||
      !validPath(value.to) ||
      (value.contentId !== undefined && !validHash(value.contentId))
    )
      throw sqliteError("invalid_request", "Invalid rename payload");
  } else if (method === "deleteNote") {
    if (!validPath(value.path) || (value.contentId !== undefined && !validHash(value.contentId)))
      throw sqliteError("invalid_request", "Invalid delete payload");
  } else if (method === "planReconciliation" || method === "finishReconciliation") {
    if (
      (method === "finishReconciliation" &&
        (!Number.isSafeInteger(value.observedChangeCounter) || value.observedChangeCounter < 0)) ||
      !Array.isArray(value.summaries) ||
      value.summaries.length > SQLITE_MAX_NOTES ||
      !value.summaries.every(validSummary)
    )
      throw sqliteError("invalid_request", "Invalid reconciliation payload");
  } else if (method === "listMissingVectors") {
    if (
      !Number.isSafeInteger(value.limit) ||
      value.limit < 0 ||
      value.limit > SQLITE_MAX_VECTOR_BATCH ||
      (value.afterChunkPk !== undefined &&
        (!Number.isSafeInteger(value.afterChunkPk) || value.afterChunkPk < 0)) ||
      (value.embeddingFingerprint !== undefined && !validHash(value.embeddingFingerprint))
    )
      throw sqliteError("invalid_request", "Invalid vector batch payload");
  } else if (method === "storeVectors") {
    if (
      !validHash(value.embeddingFingerprint) ||
      !Number.isSafeInteger(value.observedChangeCounter) ||
      value.observedChangeCounter < 0 ||
      !Array.isArray(value.vectors) ||
      value.vectors.length > SQLITE_MAX_VECTOR_BATCH ||
      !value.vectors.every(
        (v: any) =>
          v &&
          Number.isSafeInteger(v.chunkPk) &&
          v.chunkPk > 0 &&
          validId(v.chunkId) &&
          validHash(v.contentId) &&
          validVector(v.vector)
      )
    )
      throw sqliteError("invalid_request", "Invalid vector batch payload");
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
