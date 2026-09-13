/** Closed, versioned protocol for the mutable SQLite index. */
export const SQLITE_PROTOCOL_VERSION = 2 as const;
export const SQLITE_MAX_PATH = 4096;
export const SQLITE_MAX_TEXT = 2_000_000;
export const SQLITE_MAX_NOTES = 100_000;
export const SQLITE_MAX_CHUNKS = 1_000_000;
export const SQLITE_MAX_RESULTS = 256;
/** Explicit snapshot imports are bounded before any SQLite work is attempted. */
export const SQLITE_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const SQLITE_SNAPSHOT_NAMESPACE = ".trama/sqlite/v1/snapshots";

export type SqliteMethod =
  | "boot"
  | "getState"
  | "listNotes"
  | "markIncomplete"
  | "beginRebuild"
  | "upsertNote"
  | "renameNote"
  | "deleteNote"
  | "finishReconciliation"
  | "retrieve"
  | "findRelated"
  | "export"
  | "import"
  | "cancelQueued"
  | "shutdown";

export interface SqliteChunkInput {
  readonly id: string;
  readonly ordinal: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly vector: Float32Array;
}

export interface SqliteNoteInput {
  readonly path: string;
  readonly contentId: string;
  readonly chunks: readonly SqliteChunkInput[];
}

export interface SqliteState {
  readonly schemaVersion: number;
  readonly dimensions: number;
  readonly fingerprint: string;
  readonly incomplete: boolean;
  readonly changeCounter: number;
  readonly noteCount: number;
  readonly chunkCount: number;
}

export interface SqliteNoteSummary {
  readonly path: string;
  readonly contentId: string;
  readonly chunkCount?: number;
}

export type SqliteMutationStatus =
  "changed" | "unchanged" | "absent" | "alreadyApplied" | "state_changed";

export interface SqliteMutationResult {
  readonly changed: boolean;
  readonly status: SqliteMutationStatus;
  readonly rescan?: boolean;
  readonly state: SqliteState;
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

export interface SqliteRequestPayloads {
  boot: { readonly fingerprint: string; readonly dimensions: number; readonly identity: string };
  getState: Record<string, never>;
  listNotes: Record<string, never>;
  markIncomplete: Record<string, never>;
  beginRebuild: Record<string, never>;
  upsertNote: { readonly note: SqliteNoteInput };
  renameNote: { readonly from: string; readonly to: string; readonly contentId?: string };
  deleteNote: { readonly path: string; readonly contentId?: string };
  finishReconciliation: {
    readonly observedChangeCounter: number;
    readonly summaries: readonly Required<SqliteNoteSummary>[];
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
  export: Record<string, never>;
  import: { readonly bytes: ArrayBuffer };
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

export function isSqliteMethod(value: unknown): value is SqliteMethod {
  return (
    typeof value === "string" &&
    [
      "boot",
      "getState",
      "listNotes",
      "markIncomplete",
      "beginRebuild",
      "upsertNote",
      "renameNote",
      "deleteNote",
      "finishReconciliation",
      "retrieve",
      "findRelated",
      "export",
      "import",
      "cancelQueued",
      "shutdown",
    ].includes(value)
  );
}

function validPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= SQLITE_MAX_PATH &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => part === ".." || part === ".")
  );
}

function validHex(value: unknown, bytes: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${bytes * 2}}$`, "i").test(value);
}

function validVector(vector: unknown, dimensions?: number): vector is Float32Array {
  return (
    vector instanceof Float32Array &&
    vector.byteOffset % 4 === 0 &&
    (dimensions === undefined || vector.length === dimensions) &&
    vector.length > 0 &&
    vector.every((value) => Number.isFinite(value))
  );
}

function validChunk(chunk: unknown, dimensions?: number): chunk is SqliteChunkInput {
  if (!chunk || typeof chunk !== "object") return false;
  const value = chunk as SqliteChunkInput;
  const [contentId, ordinalText] = typeof value.id === "string" ? value.id.split(":") : [];
  return (
    validHex(contentId, 32) &&
    /^\d+$/.test(ordinalText ?? "") &&
    Number(ordinalText) === value.ordinal &&
    Number.isSafeInteger(value.ordinal) &&
    value.ordinal >= 0 &&
    Number.isSafeInteger(value.startLine) &&
    value.startLine >= 1 &&
    Number.isSafeInteger(value.endLine) &&
    value.endLine >= value.startLine &&
    typeof value.text === "string" &&
    value.text.length <= SQLITE_MAX_TEXT &&
    validVector(value.vector, dimensions)
  );
}

function validatePayload(method: SqliteMethod, payload: unknown): void {
  if (!payload || typeof payload !== "object")
    throw sqliteError("invalid_request", "Invalid payload");
  const value = payload as Record<string, unknown>;
  if (method === "boot") {
    if (
      !validHex(value.fingerprint, 32) ||
      !validHex(value.identity, 32) ||
      !Number.isSafeInteger(value.dimensions) ||
      Number(value.dimensions) < 1 ||
      Number(value.dimensions) > 4096
    )
      throw sqliteError("invalid_request", "Invalid boot payload");
  } else if (method === "upsertNote") {
    const note = value.note as SqliteNoteInput | undefined;
    if (
      !note ||
      !validPath(note.path) ||
      !validHex(note.contentId, 32) ||
      !Array.isArray(note.chunks) ||
      note.chunks.length > SQLITE_MAX_CHUNKS ||
      !note.chunks.every((chunk) => validChunk(chunk))
    )
      throw sqliteError("invalid_request", "Invalid note payload");
    const ids = new Set(note.chunks.map((chunk) => `${chunk.ordinal}\0${chunk.id}`));
    if (ids.size !== note.chunks.length)
      throw sqliteError("invalid_request", "Duplicate chunk identity");
  } else if (method === "renameNote") {
    if (
      !validPath(value.from) ||
      !validPath(value.to) ||
      (value.contentId !== undefined && !validHex(value.contentId, 32))
    )
      throw sqliteError("invalid_request", "Invalid rename payload");
  } else if (method === "deleteNote") {
    if (!validPath(value.path) || (value.contentId !== undefined && !validHex(value.contentId, 32)))
      throw sqliteError("invalid_request", "Invalid delete payload");
  } else if (method === "finishReconciliation") {
    if (
      !Number.isSafeInteger(value.observedChangeCounter) ||
      Number(value.observedChangeCounter) < 0 ||
      !Array.isArray(value.summaries) ||
      value.summaries.length > SQLITE_MAX_NOTES ||
      !value.summaries.every(
        (summary) =>
          !!summary &&
          typeof summary === "object" &&
          validPath((summary as SqliteNoteSummary).path) &&
          validHex((summary as SqliteNoteSummary).contentId, 32) &&
          Number.isSafeInteger((summary as SqliteNoteSummary).chunkCount) &&
          Number((summary as SqliteNoteSummary).chunkCount) >= 0
      )
    )
      throw sqliteError("invalid_request", "Invalid reconciliation payload");
  } else if (method === "retrieve") {
    if (
      (value.query !== undefined &&
        (typeof value.query !== "string" || value.query.length > SQLITE_MAX_TEXT)) ||
      (value.vector !== undefined && !validVector(value.vector)) ||
      !Number.isSafeInteger(value.limit) ||
      Number(value.limit) < 0 ||
      Number(value.limit) > SQLITE_MAX_RESULTS ||
      (value.currentPath !== undefined && !validPath(value.currentPath)) ||
      (value.semanticCandidateLimit !== undefined &&
        (!Number.isSafeInteger(value.semanticCandidateLimit) ||
          Number(value.semanticCandidateLimit) < 0 ||
          Number(value.semanticCandidateLimit) > SQLITE_MAX_RESULTS)) ||
      (value.lexicalCandidateLimit !== undefined &&
        (!Number.isSafeInteger(value.lexicalCandidateLimit) ||
          Number(value.lexicalCandidateLimit) < 0 ||
          Number(value.lexicalCandidateLimit) > SQLITE_MAX_RESULTS)) ||
      (value.lexicalProfile !== undefined &&
        value.lexicalProfile !== "voce" &&
        value.lexicalProfile !== "lente") ||
      (value.resultShape !== undefined &&
        value.resultShape !== "chunks" &&
        value.resultShape !== "notes")
    )
      throw sqliteError("invalid_request", "Invalid retrieve payload");
  } else if (method === "findRelated") {
    if (
      !validPath(value.path) ||
      (value.vector !== undefined && !validVector(value.vector)) ||
      !Number.isSafeInteger(value.limit) ||
      Number(value.limit) < 0 ||
      Number(value.limit) > SQLITE_MAX_RESULTS
    )
      throw sqliteError("invalid_request", "Invalid related payload");
  } else if (method === "import") {
    if (
      !(value.bytes instanceof ArrayBuffer) ||
      value.bytes.byteLength === 0 ||
      value.bytes.byteLength > SQLITE_SNAPSHOT_MAX_BYTES
    )
      throw sqliteError("invalid_request", "Invalid snapshot payload");
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
