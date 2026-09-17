/** A message exchanged in a chat turn. */
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  /** Sources supporting a completed final assistant answer; absent on tool-call messages. */
  readonly provenance?: readonly ProvenanceRecord[];
  /** Provider-neutral reasoning context retained for stateless replay. */
  readonly reasoningContext?: string;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** Provider-neutral reasoning control; omission remains the automatic default. */
export type ReasoningEffort = "none" | "low" | "medium" | "high";

/** A request for a named, read-only tool operation. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** A result returned to the model and retained for provenance display. */
export interface ToolResult {
  readonly toolCallId: string;
  readonly content: string;
  readonly provenance: readonly ProvenanceRecord[];
}

/** A model response for one chat round. */
export interface ChatResponse {
  readonly message: ChatMessage;
  readonly finishReason: "stop" | "tool_calls" | "length";
  readonly usage?: ChatUsage;
}

/** Token accounting reported by a model when available. */
export interface ChatUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/** Tool metadata supplied to a model for one completion request. */
export interface ChatToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** The smallest contract required by the bounded chat application. */
export interface ChatModel {
  complete(
    messages: readonly ChatMessage[],
    signal: AbortSignal,
    tools?: readonly ChatToolDefinition[],
    onText?: (text: string) => void
  ): Promise<ChatResponse>;
}

/** The embedding model contract used by Filo's semantic index. */
export interface EmbeddingProgress {
  readonly completed: number;
  readonly total: number;
  readonly unit: "texts";
}

export type IndexOperation = "full" | "incremental" | "startup";

/** Both search channels use the same readiness and activity vocabulary. */
export type IndexAvailability = "unavailable" | "available";
export type IndexChannelState = "unavailable" | "empty" | "partial" | "ready" | "incompatible";
export type IndexChannelActivity = "idle" | "updating";
export interface IndexChannelStatus {
  readonly state: IndexChannelState;
  readonly activity: IndexChannelActivity;
  readonly searchable: boolean;
}
export type IndexFreshness = "locally-reconciled" | "snapshot-loaded" | "unknown";

export interface IndexCapabilities {
  readonly availability: IndexAvailability;
  readonly lexical: IndexChannelStatus;
  readonly semantic: IndexChannelStatus;
  readonly freshness: IndexFreshness;
  readonly publicationId?: string;
}
export type IndexProgressPhase =
  | "discover"
  | "read"
  | "chunk"
  | "embed"
  | "encode-write"
  | "validate"
  | "build-vector"
  | "build-lexical"
  | "activate"
  | "GC";

export interface IndexProgress {
  readonly operation: IndexOperation;
  readonly phase: IndexProgressPhase;
  readonly completed: number;
  readonly total?: number;
  readonly unit: "paths" | "notes" | "chunks" | "texts" | "segments" | "pages" | "artifacts";
  readonly determinate: boolean;
  /** True when total is a fast metadata-based estimate rather than a completed count. */
  readonly estimated?: boolean;
  /** Mutable-index cache token; unlike the legacy generation field it never denotes publication. */
  readonly changeCounter?: number;
  readonly generationId?: string;
}

export interface EmbeddingModel {
  embed(
    texts: readonly string[],
    signal: AbortSignal,
    onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<readonly number[][]>;
  readonly dimensions: number;
}

/** Cancellation passed through model, tool, and vault operations. */
export interface CancellationToken {
  readonly signal: AbortSignal;
}

export type StructuredErrorCode =
  "cancelled" | "busy" | "invalid_request" | "unavailable" | "limit_exceeded" | "internal";

/** A stable, serializable error shape for UI and application boundaries. */
export interface StructuredErrorShape {
  readonly code: StructuredErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/** Error carrying a stable code instead of requiring callers to parse text. */
export class StructuredError extends Error implements StructuredErrorShape {
  readonly name = "StructuredError";

  constructor(
    readonly code: StructuredErrorCode,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
  }
}

/** The vault location and optional line range used to substantiate an answer. */
export interface ProvenanceRecord {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly excerpt?: string;
  readonly score?: number;
}

/** A note read through the future read-only vault adapter. */
export interface ReadonlyNote {
  readonly path: string;
  readonly content: string;
  readonly truncated?: boolean;
  readonly startLine?: number;
  readonly endLine?: number;
}

/** The only vault capability future tools may depend on. */
export interface ReadonlyVault {
  readNote(path: string, signal: AbortSignal): Promise<ReadonlyNote>;
  currentNotePath(signal: AbortSignal): Promise<string | null>;
  resolveLink(link: string, sourcePath: string, signal: AbortSignal): Promise<string | null>;
  discoverLinks(
    path: string,
    signal: AbortSignal,
    maxLinks?: number
  ): Promise<readonly VaultLink[]>;
  currentNote?(signal: AbortSignal): Promise<ReadonlyNote | null>;
  resolveLinkDetails?(
    link: string,
    sourcePath: string,
    signal: AbortSignal
  ): Promise<ResolvedLink | null>;
}

export interface VaultLink {
  readonly link: string;
  readonly targetPath: string | null;
  readonly sourcePath: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface ResolvedLink {
  readonly path: string | null;
  readonly startLine?: number;
  readonly endLine?: number;
}
