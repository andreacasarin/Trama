import { ChatResponse, ToolCall } from "@/domain/contracts";
import { ToolResult } from "@/tools/ToolRegistry";

/** Typed diagnostic events emitted by Voce's bounded conversation session. */
export type VoceDiagnosticRecord =
  | { readonly event: "session_started"; readonly generation: number }
  | {
      readonly event: "attachment_preflight_started";
      readonly generation: number;
      readonly count: number;
    }
  | {
      readonly event: "attachment_preflight_completed";
      readonly generation: number;
      readonly count: number;
    }
  | { readonly event: "model_round_started"; readonly generation: number; readonly round: number }
  | {
      readonly event: "model_round_completed";
      readonly generation: number;
      readonly round: number;
      readonly finishReason: "stop" | "tool_calls" | "length";
    }
  | { readonly event: "stream_delta"; readonly generation: number; readonly text: string }
  | {
      readonly event: "tool_completed";
      readonly generation: number;
      readonly name: string;
      readonly ok: boolean;
      readonly call: ToolCall;
      readonly result: ToolResult;
    }
  | { readonly event: "limit_reached"; readonly generation: number; readonly message: string }
  | {
      readonly event: "error";
      readonly generation: number;
      readonly code: string;
      readonly message: string;
      readonly error: unknown;
    }
  | {
      readonly event: "responses_request";
      readonly body: Readonly<Record<string, unknown>>;
    }
  | { readonly event: "responses_sse_event"; readonly eventData: unknown }
  | { readonly event: "model_response"; readonly response: ChatResponse }
  | { readonly event: "model_error"; readonly error: unknown }
  | { readonly event: "cancelled"; readonly generation: number };

/** Receives transient Voce diagnostics without buffering or persisting them. */
export interface VoceDiagnostics {
  emit(record: VoceDiagnosticRecord): void;
}

export const NOOP_VOCE_DIAGNOSTICS: VoceDiagnostics = Object.freeze({ emit: () => undefined });
