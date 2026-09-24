import { ChatResponse, ToolCall } from "@/domain/contracts";
import { isSqliteMethod } from "@/index/sqlite/protocol";
import { ToolResult } from "@/tools/ToolRegistry";

/** Explicit diagnostic area used to keep chat payloads separate from metadata-only index events. */
export type TramaDiagnosticArea = "chat" | "index" | "filo";

export interface SafeDiagnosticError {
  readonly name: string;
  readonly code?: string;
  readonly message?: string;
  readonly method?: string;
  readonly phase?: string;
  readonly debugLocation?: string;
  readonly retryable?: boolean;
  readonly cancelled?: boolean;
}

const SQLITE_ERROR_CODES = new Set([
  "cancelled",
  "busy",
  "invalid_request",
  "incompatible_state",
  "integrity_failed",
  "storage_unavailable",
  "unsupported",
  "worker_crashed",
  "internal",
  "unavailable",
  "limit_exceeded",
  "query_embedding_failed",
]);
const SQLITE_PHASES = new Set([
  "boot",
  "load",
  "startup",
  "discover",
  "read",
  "chunk",
  "embed",
  "encode-write",
  "build-lexical",
  "build-vector",
  "activate",
  "validate",
  "retrieve",
  "publish",
  "adopt",
  "shutdown",
  "validation",
  "dispatch",
  "open",
  "execute",
]);

function sanitizeDiagnosticMessage(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const redacted = normalized
    // Absolute Unix/Windows paths, including vault names with spaces.
    .replace(/(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/)[^"'`;,)]*?(?:\.md\b|$)/gi, "<path>")
    // Relative vault paths that include a Markdown filename.
    .replace(/(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_. -]+\.md\b/gi, "<note>")
    .replace(/\b[A-Za-z0-9_.-]+\.md\b/gi, "<note>")
    // Content identifiers and long opaque fragments.
    .replace(/\b(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{48,})\b/g, "<id>");
  return redacted.slice(0, 240);
}

function safeDebugLocation(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 160) return undefined;
  return /^[A-Za-z_$][A-Za-z0-9_$]{0,63}@[A-Za-z0-9_.-]{1,96}:\d{1,7}(?::\d{1,7})?$/.test(value)
    ? value
    : undefined;
}

function safeBuildId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)
    ? value
    : undefined;
}

/** Typed diagnostic events emitted by Trama's bounded conversation session. */
export type TramaDiagnosticRecord =
  | { readonly area: "chat"; readonly event: "session_started"; readonly generation: number }
  | {
      readonly area: "chat";
      readonly event: "session_completed";
      readonly generation: number;
      readonly durationMs: number;
    }
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
      readonly durationMs: number;
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
      readonly durationMs: number;
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
      readonly durationMs: number;
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
      readonly durationMs: number;
    }
  | {
      readonly area: "chat";
      readonly event: "responses_request";
      readonly body: Readonly<Record<string, unknown>>;
    }
  | { readonly area: "chat"; readonly event: "responses_sse_event"; readonly eventData: unknown }
  | {
      readonly area: "chat";
      readonly event: "model_response";
      readonly response: ChatResponse;
      readonly durationMs: number;
    }
  | {
      readonly area: "chat";
      readonly event: "model_error";
      readonly error: unknown;
      readonly durationMs: number;
    }
  | {
      readonly area: "chat";
      readonly event: "cancelled";
      readonly generation: number;
      readonly durationMs: number;
    }
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
        | "search"
        | "publication"
        | "GC";
      readonly stage: "started" | "completed" | "failed" | "cancelled" | string;
      readonly channel?: "lexical" | "semantic" | "publication";
      readonly source?: "startup" | "event" | "explicit" | "retry" | "quit";
      readonly delayMs?: number;
      readonly deferredReason?: string;
      readonly retryAttempt?: number;
      readonly publicationSizeBytes?: number;
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
      readonly runtime?: {
        readonly expectedBuildId: string;
        readonly actualBuildId: string;
        readonly protocolVersion: number;
        readonly schemaVersion: number;
      };
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

/** Starts one wall-clock timer for diagnostic duration records. */
export function startDiagnosticTimer(now: () => number = () => Date.now()): () => number {
  const startedAt = now();
  return () => Math.max(0, now() - startedAt);
}

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
    const outer = error as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      error?: unknown;
      retryable?: unknown;
      cancelled?: unknown;
    };
    const nested =
      outer.error && typeof outer.error === "object"
        ? (outer.error as {
            code?: unknown;
            message?: unknown;
            retryable?: unknown;
            method?: unknown;
            phase?: unknown;
            debugLocation?: unknown;
          })
        : undefined;
    const name = outer.name;
    const code = nested?.code ?? outer.code;
    const message = nested?.message ?? outer.message;
    const retryable = nested?.retryable ?? outer.retryable;
    const method = nested?.method;
    const phase = nested?.phase;
    const debugLocation = safeDebugLocation(
      nested?.debugLocation ?? (outer as { debugLocation?: unknown }).debugLocation
    );
    const cancelled = outer.cancelled;
    const safeMessage =
      typeof message === "string" ? sanitizeDiagnosticMessage(message) : undefined;
    return {
      name:
        name === "StructuredError" || name === "SqliteProtocolError" || name === "Error"
          ? name
          : "Error",
      ...(typeof code === "string" && SQLITE_ERROR_CODES.has(code) ? { code } : {}),
      ...(safeMessage ? { message: safeMessage } : {}),
      ...(isSqliteMethod(method) ? { method } : {}),
      ...(typeof phase === "string" && SQLITE_PHASES.has(phase) ? { phase } : {}),
      ...(debugLocation ? { debugLocation } : {}),
      ...(typeof code === "string" && SQLITE_ERROR_CODES.has(code) && typeof retryable === "boolean"
        ? { retryable }
        : {}),
      ...(cancelled === true || code === "cancelled" ? { cancelled: true } : {}),
    };
  } catch {
    return { name: "Error" };
  }
}

/** Concise safe line for collapsed developer-console previews. */
export function formatDiagnosticLogLine(record: TramaDiagnosticRecord): string | undefined {
  if (
    record.event === "index_operation" &&
    record.operation === "startup" &&
    record.stage === "completed" &&
    record.phase === "handshake" &&
    record.runtime
  ) {
    const expected = safeBuildId(record.runtime.expectedBuildId);
    const actual = safeBuildId(record.runtime.actualBuildId);
    if (!expected || !actual)
      return "[Trama] index:index_operation operation=startup stage=completed phase=handshake";
    return `[Trama] index:index_operation operation=startup stage=completed phase=handshake expectedBuildId=${expected} actualBuildId=${actual} protocol=${record.runtime.protocolVersion} schema=${record.runtime.schemaVersion}`;
  }
  if (record.event !== "index_operation" || record.stage !== "failed") return undefined;
  const error = record.error;
  const details = [
    `operation=${record.operation}`,
    `stage=${record.stage}`,
    ...(error?.method ? [`method=${error.method}`] : []),
    ...(error?.phase ? [`phase=${error.phase}`] : []),
    ...(error?.code ? [`code=${error.code}`] : []),
    ...(error?.message
      ? [`message=${sanitizeDiagnosticMessage(error.message) ?? "<detail>"}`]
      : []),
    ...(error?.debugLocation ? [`location=${error.debugLocation}`] : []),
  ];
  return `[Trama] ${record.area}:${record.event} ${details.join(" ")}`;
}
