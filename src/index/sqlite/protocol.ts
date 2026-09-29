/** Closed, versioned protocol for the mutable SQLite index. */
export const SQLITE_PROTOCOL_VERSION = 9 as const;
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

export const SQLITE_METHODS = [
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
] as const;
export type SqliteMethod = (typeof SQLITE_METHODS)[number];
export function isSqliteMethod(value: unknown): value is SqliteMethod {
  return typeof value === "string" && (SQLITE_METHODS as readonly string[]).includes(value);
}

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
  readonly lexicalGeneration: number;
  readonly semanticGeneration: number;
  readonly noteCount: number;
  readonly chunkCount: number;
  readonly compatibleVectorCount: number;
  readonly vectorCount: number;
  readonly vectorCoverage: VectorCoverage;
  readonly semanticReady: boolean;
  /** Counts derived from active lexical/semantic revision heads. */
  readonly semanticEligibleCount: number;
  readonly semanticHeadCount: number;
  readonly semanticLagCount: number;
  readonly semanticMissingCount: number;
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
    lexicalGeneration: state.lexicalGeneration,
    semanticGeneration: state.semanticGeneration,
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
    readonly expectedLexicalGeneration: number;
    readonly expectedSemanticGeneration: number;
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
