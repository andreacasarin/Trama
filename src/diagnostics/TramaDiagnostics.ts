import { ChatResponse, ToolCall } from "@/domain/contracts";
import { ToolResult } from "@/tools/ToolRegistry";

/** Explicit diagnostic area used to keep chat payloads separate from metadata-only index events. */
export type TramaDiagnosticArea = "chat" | "index" | "filo";

export interface SafeDiagnosticError {
  readonly name: string;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly cancelled?: boolean;
}

/** Typed diagnostic events emitted by Trama's bounded conversation session. */
export type TramaDiagnosticRecord =
  | { readonly area: "chat"; readonly event: "session_started"; readonly generation: number }
  | {
      readonly area: "chat";
      readonly event: "attachment_preflight_started";
      readonly generation: number;
      readonly count: number;
    }
  | {
      readonly area: "chat";
      readonly event: "attachment_preflight_completed";
      readonly generation: number;
      readonly count: number;
    }
  | {
      readonly area: "chat";
      readonly event: "model_round_started";
      readonly generation: number;
      readonly round: number;
    }
  | {
      readonly area: "chat";
      readonly event: "model_round_completed";
      readonly generation: number;
      readonly round: number;
      readonly finishReason: "stop" | "tool_calls" | "length";
    }
  | {
      readonly area: "chat";
      readonly event: "stream_delta";
      readonly generation: number;
      readonly text: string;
    }
  | {
      readonly area: "chat";
      readonly event: "tool_completed";
      readonly generation: number;
      readonly name: string;
      readonly ok: boolean;
      readonly call: ToolCall;
      readonly result: ToolResult;
    }
  | {
      readonly area: "chat";
      readonly event: "limit_reached";
      readonly generation: number;
      readonly message: string;
    }
  | {
      readonly area: "chat";
      readonly event: "error";
      readonly generation: number;
      readonly code: string;
      readonly message: string;
      readonly error: unknown;
    }
  | {
      readonly area: "chat";
      readonly event: "responses_request";
      readonly body: Readonly<Record<string, unknown>>;
    }
  | { readonly area: "chat"; readonly event: "responses_sse_event"; readonly eventData: unknown }
  | { readonly area: "chat"; readonly event: "model_response"; readonly response: ChatResponse }
  | { readonly area: "chat"; readonly event: "model_error"; readonly error: unknown }
  | { readonly area: "chat"; readonly event: "cancelled"; readonly generation: number }
  // Reserved metadata-only shapes for Slice 3. They intentionally have no context bag or raw error.
  | {
      readonly area: "index";
      readonly event: "index_status";
      readonly status: string;
      readonly revision: number;
      readonly hasLastGood: boolean;
      readonly generation?: string;
    }
  | {
      readonly area: "index";
      readonly event: "index_operation";
      readonly operation:
        | "load"
        | "build"
        | "full"
        | "incremental"
        | "startup"
        | "status"
        | "corpus"
        | "segment"
        | "manifest"
        | "vector"
        | "lexical"
        | "GC";
      readonly stage: "started" | "completed" | "published" | "failed" | "cancelled" | string;
      readonly phase?: string;
      readonly completed?: number;
      readonly total?: number;
      readonly unit?: string;
      readonly determinate?: boolean;
      readonly path?: string;
      readonly pathCount?: number;
      readonly counts?: Readonly<Record<string, number>>;
      readonly durationMs?: number;
      readonly generation?: string;
      readonly cancelled?: boolean;
      readonly lastCompletedStage?: string;
      readonly itemCount?: number;
      readonly model?: string;
      readonly dimensions?: number;
      readonly error?: SafeDiagnosticError;
    }
  | {
      readonly area: "filo";
      readonly event: "related_search";
      readonly stage?: "started" | "prepare-completed" | "retrieve-completed" | "completed";
      readonly path?: string;
      readonly generation?: string;
      readonly resultCount: number;
      readonly durationMs?: number;
      readonly cancelled?: boolean;
      readonly error?: SafeDiagnosticError;
    }
  | {
      readonly area: "index";
      readonly event: "lente_search";
      readonly generation?: string;
      readonly mode: "hybrid" | "lexical";
      readonly resultCount: number;
      readonly durationMs?: number;
      readonly cancelled?: boolean;
      readonly error?: SafeDiagnosticError;
    };

/** Receives transient diagnostics without buffering or persisting them. */
export interface TramaDiagnostics {
  emit(record: TramaDiagnosticRecord): void;
}

export const NOOP_TRAMA_DIAGNOSTICS: TramaDiagnostics = Object.freeze({ emit: () => undefined });

/** Emits observational diagnostics without allowing a hostile sink to affect control flow. */
export function emitTramaDiagnostic(
  diagnostics: TramaDiagnostics,
  record: TramaDiagnosticRecord
): void {
  try {
    diagnostics.emit(record);
  } catch {
    // Diagnostics must never recurse, log, throw, or alter the operation being observed.
  }
}

/** Projects unknown failures to stable metadata without exposing payloads or stack details. */
export function projectDiagnosticError(error: unknown): SafeDiagnosticError {
  try {
    if (!error || typeof error !== "object") return { name: "Error" };
    const candidate = error as {
      name?: unknown;
      code?: unknown;
      retryable?: unknown;
      cancelled?: unknown;
    };
    const knownCodes = new Set([
      "cancelled",
      "busy",
      "invalid_request",
      "unavailable",
      "limit_exceeded",
      "internal",
      "query_embedding_failed",
    ]);
    const name = candidate.name;
    const code = candidate.code;
    const retryable = candidate.retryable;
    const cancelled = candidate.cancelled;
    return {
      name: name === "StructuredError" || name === "Error" ? name : "Error",
      ...(typeof code === "string" && knownCodes.has(code) ? { code } : {}),
      ...(typeof code === "string" && knownCodes.has(code) && typeof retryable === "boolean"
        ? { retryable }
        : {}),
      ...(cancelled === true || code === "cancelled" ? { cancelled: true } : {}),
    };
  } catch {
    return { name: "Error" };
  }
}
