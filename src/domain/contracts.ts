/** A message exchanged in a chat turn. */
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  /** Sources supporting a completed final assistant answer; absent on tool-call messages. */
  readonly provenance?: readonly ProvenanceRecord[];
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

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
    tools?: readonly ChatToolDefinition[]
  ): Promise<ChatResponse>;
}

/** The embedding model contract used by the future semantic index. */
export interface EmbeddingModel {
  embed(texts: readonly string[], signal: AbortSignal): Promise<readonly number[][]>;
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
