import { ChatResponse, ToolCall } from "@/domain/contracts";
import { isSqliteMethod, SQLITE_METHODS, type SqliteMethod } from "@/index/sqlite/protocol";
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
  "upgrade_required",
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
export type TramaDetailedInput =
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

export type DiagnosticTier = "performance" | "detailed";
export type DiagnosticMode = "off" | "performance" | "detailed";
export type DiagnosticFacet =
  | "chat"
  | "index"
  | "filo"
  | "lexical"
  | "semantic"
  | "retrieve"
  | "related"
  | "adoption"
  | "publication"
  | "worker"
  | "rpc";
export type PerformanceFacet = Exclude<DiagnosticFacet, "chat">;
export type PerformancePhase = (typeof PERFORMANCE_PHASE_LIST)[number] | SqliteMethod | "unknown";
export interface DiagnosticContext {
  readonly sessionId: string;
  readonly requestId?: number;
  readonly operationId?: string;
  readonly parentOperationId?: string;
  readonly batchId?: string;
}
/** Bounded metadata only. No open-ended context, payload, path, hash, vector, or error fields. */
export interface TramaPerformanceRecord {
  readonly tier: "performance";
  readonly facets: readonly PerformanceFacet[];
  readonly area: "index" | "filo";
  readonly event: "phase";
  readonly operation: "lexical" | "semantic" | "retrieve" | "related" | "publication" | "adoption";
  readonly phase: PerformancePhase;
  readonly semanticStep?: "prepare" | "commit";
  readonly durationMs: number;
  readonly sqlMs?: number;
  readonly sqlCalls?: number;
  readonly callbackRows?: number;
  readonly copiedBytes?: number;
  readonly itemCount?: number;
  readonly byteCount?: number;
  readonly nested?: boolean;
  readonly context?: DiagnosticContext;
}
export type TramaDiagnosticRecord =
  | TramaPerformanceRecord
  | (TramaDetailedInput & {
      readonly tier: "detailed";
      readonly facets: readonly DiagnosticFacet[];
      readonly context?: DiagnosticContext;
    });
export type TramaDiagnosticInput = TramaDetailedInput | TramaPerformanceRecord;

/** Receives transient diagnostics without buffering or persisting them. */
export interface TramaDiagnostics {
  readonly context?: DiagnosticContext;
  enabled(tier: DiagnosticTier): boolean;
  emit(record: TramaDiagnosticInput): void;
  capturePerformance?(
    configureWorker: () => Promise<void>,
    work: (records: readonly TramaPerformanceRecord[]) => Promise<void>,
    onRecord?: (record: TramaPerformanceRecord) => void
  ): Promise<readonly TramaPerformanceRecord[]>;
}

export const NOOP_TRAMA_DIAGNOSTICS: TramaDiagnostics = Object.freeze({
  enabled: () => false,
  emit: () => undefined,
});

export function modeEnables(mode: DiagnosticMode, tier: DiagnosticTier): boolean {
  return mode === "detailed" || (mode === "performance" && tier === "performance");
}

/** An injected diagnostic port is untrusted: observation must never interrupt work. */
export function diagnosticsEnabled(diagnostics: TramaDiagnostics, tier: DiagnosticTier): boolean {
  try {
    return diagnostics.enabled(tier) === true;
  } catch {
    return false;
  }
}

export function createTramaDiagnostics(
  getMode: () => DiagnosticMode,
  sink: (record: TramaDiagnosticRecord) => void,
  context: DiagnosticContext
): TramaDiagnostics {
  const captures: {
    records: TramaPerformanceRecord[];
    onRecord?: (record: TramaPerformanceRecord) => void;
    failure?: Error;
  }[] = [];
  return {
    context,
    enabled: (tier) => {
      try {
        return (captures.length > 0 && tier === "performance") || modeEnables(getMode(), tier);
      } catch {
        return false;
      }
    },
    emit(input) {
      try {
        const tier = "tier" in input ? input.tier : "detailed";
        let liveEnabled = false;
        try {
          liveEnabled = modeEnables(getMode(), tier);
        } catch {
          // A failing settings reader only disables the live sink.
        }
        if (!(captures.length > 0 && tier === "performance") && !liveEnabled) return;
        const record: TramaDiagnosticRecord =
          tier === "performance"
            ? safePerformanceRecord(input as TramaPerformanceRecord, context)
            : ({
                ...input,
                tier: "detailed",
                facets: [input.area],
                context,
              } as TramaDiagnosticRecord);
        if (record.tier === "performance")
          for (const capture of captures) {
            if (capture.failure) continue;
            if (capture.onRecord) {
              try {
                capture.onRecord(record);
              } catch {
                capture.failure = new Error("Performance capture consumer failed.");
              }
            } else if (capture.records.length < 512) capture.records.push(record);
            else capture.failure = new Error("Performance capture exceeded 512 records.");
          }
        if (liveEnabled) sink(record);
      } catch {
        // A failing diagnostic sink cannot affect the observed operation.
      }
    },
    async capturePerformance(configureWorker, work, onRecord) {
      const records: TramaPerformanceRecord[] = [];
      const capture = { records, onRecord, failure: undefined as Error | undefined };
      captures.push(capture);
      try {
        await configureWorker();
        await work(records);
        if (capture.failure) throw capture.failure;
        return records;
      } finally {
        captures.splice(captures.indexOf(capture), 1);
        await configureWorker();
      }
    },
  };
}

const PERFORMANCE_FACETS = new Set<PerformanceFacet>([
  "index",
  "filo",
  "lexical",
  "semantic",
  "retrieve",
  "related",
  "adoption",
  "publication",
  "worker",
  "rpc",
]);
const PERFORMANCE_OPERATIONS = new Set<TramaPerformanceRecord["operation"]>([
  "lexical",
  "semantic",
  "retrieve",
  "related",
  "publication",
  "adoption",
]);
const PERFORMANCE_PHASE_LIST = [
  "snapshotRead",
  "batch",
  "queryEmbedding",
  "resultShaping",
  "overall",
  "prepareRpc",
  "provider",
  "vectorConversion",
  "commitRpc",
  "prepare",
  "install",
  "finalize",
  "hybrid",
  "lexical",
  "semantic",
  "related",
  "firstInputLookup",
  "boundedMissingSelection",
  "remainingWorkCheck",
  "generationLookup",
  "resultAssembly",
  "unrestrictedPromotion",
  "inputRereadValidation",
  "vectorNormalizationDedup",
  "transaction",
  "transactionSetupResultInserts",
  "knownBlobCopy",
  "affectedNoteCacheUpsert",
  "promotion",
  "cleanup",
  "snapshotValidation",
  "snapshotLiveExport",
  "snapshotCandidateImport",
  "snapshotBootPrune",
  "snapshotCandidateExport",
  "snapshotLiveReopen",
  "snapshotIntegrityCheck",
  "snapshotForeignKeyCheck",
  "snapshotPointerOwnership",
  "snapshotFtsCoverage",
  "snapshotSemanticCoverage",
  "snapshotVectorValidation",
  "lexicalInputPreparation",
  "lexicalSqlMutation",
  "semanticCandidates",
  "lexicalCandidates",
  "fusion",
  "centroid",
  "relatedCandidates",
  "relatedRerank",
] as const;
const PERFORMANCE_PHASES = new Set<string>([...PERFORMANCE_PHASE_LIST, ...SQLITE_METHODS]);
function safePerformanceRecord(
  input: TramaPerformanceRecord,
  context: DiagnosticContext
): TramaPerformanceRecord {
  const count = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  return {
    tier: "performance",
    facets: Array.isArray(input.facets)
      ? input.facets.filter((facet) => PERFORMANCE_FACETS.has(facet)).slice(0, 8)
      : [],
    area: input.area === "filo" ? "filo" : "index",
    event: "phase",
    operation: PERFORMANCE_OPERATIONS.has(input.operation) ? input.operation : "lexical",
    phase: PERFORMANCE_PHASES.has(input.phase) ? input.phase : "unknown",
    ...(input.semanticStep === "prepare" || input.semanticStep === "commit"
      ? { semanticStep: input.semanticStep }
      : {}),
    durationMs: count(input.durationMs) ?? 0,
    ...(count(input.sqlMs) === undefined ? {} : { sqlMs: count(input.sqlMs) }),
    ...(count(input.sqlCalls) === undefined ? {} : { sqlCalls: count(input.sqlCalls) }),
    ...(count(input.callbackRows) === undefined ? {} : { callbackRows: count(input.callbackRows) }),
    ...(count(input.copiedBytes) === undefined ? {} : { copiedBytes: count(input.copiedBytes) }),
    ...(count(input.itemCount) === undefined ? {} : { itemCount: count(input.itemCount) }),
    ...(count(input.byteCount) === undefined ? {} : { byteCount: count(input.byteCount) }),
    ...(input.nested === undefined ? {} : { nested: input.nested === true }),
    context: {
      sessionId: context.sessionId,
      ...(Number.isSafeInteger(input.context?.requestId)
        ? { requestId: input.context!.requestId }
        : {}),
      ...(typeof input.context?.operationId === "string" &&
      /^[A-Za-z0-9_-]{1,96}$/.test(input.context.operationId)
        ? { operationId: input.context.operationId }
        : {}),
      ...(typeof input.context?.parentOperationId === "string" &&
      /^[A-Za-z0-9_-]{1,96}$/.test(input.context.parentOperationId)
        ? { parentOperationId: input.context.parentOperationId }
        : {}),
      ...(typeof input.context?.batchId === "string" &&
      /^[A-Za-z0-9_-]{1,96}$/.test(input.context.batchId)
        ? { batchId: input.context.batchId }
        : {}),
    },
  };
}

/** Returns undefined without reading the clock when a tier is disabled. */
export function diagnosticTimer(
  diagnostics: TramaDiagnostics,
  tier: DiagnosticTier,
  now: () => number = () => performance.now()
): (() => number) | undefined {
  return diagnosticsEnabled(diagnostics, tier) ? startDiagnosticTimer(now) : undefined;
}

/** Starts one wall-clock timer for diagnostic duration records. */
export function startDiagnosticTimer(now: () => number = () => Date.now()): () => number {
  const startedAt = now();
  return () => Math.max(0, now() - startedAt);
}

/** Emits observational diagnostics without allowing a hostile sink to affect control flow. */
export function emitTramaDiagnostic(
  diagnostics: TramaDiagnostics,
  record: TramaDiagnosticInput
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
export function formatDiagnosticLogLine(record: TramaDiagnosticInput): string | undefined {
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
