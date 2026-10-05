import {
  SQLITE_DIAGNOSTICS_CONFIG_TYPE,
  SQLITE_DIAGNOSTIC_EVENT_TYPE,
  SQLITE_PROTOCOL_VERSION,
  type SqliteDiagnosticsConfigRequest,
  type SqliteDiagnosticEventMessage,
  type SqliteMethod,
  type SqliteReply,
  type SqliteRequest,
  type SqliteRequestPayloads,
  SqliteProtocolError,
  sqliteError,
} from "./protocol";
import {
  NOOP_TRAMA_DIAGNOSTICS,
  diagnosticsEnabled,
  emitTramaDiagnostic,
  type TramaDiagnostics,
} from "@/diagnostics/TramaDiagnostics";

const HANDSHAKE_TYPE = "trama-runtime-handshake";
const DIAGNOSTICS_CONFIGURATION_TIMEOUT_MS = 1_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;

export interface SqliteWorkerLike {
  postMessage(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  terminate?(): void;
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (event: any) => void
  ): void;
  removeEventListener?(
    type: "message" | "error" | "messageerror",
    listener: (event: any) => void
  ): void;
}

export type SqliteCallHandler = <M extends SqliteMethod>(
  method: M,
  payload: SqliteRequestPayloads[M],
  signal?: AbortSignal
) => Promise<unknown>;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
  cancelled?: boolean;
}

/** Main-thread RPC client. Requests copy caller buffers unless ownership is explicitly transferred. */
export class SqliteWorkerClient {
  private static nextIncarnation = 1;
  private readonly incarnation = SqliteWorkerClient.nextIncarnation++;
  private nextOperation = 1;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  private handshakePromise?: Promise<string>;
  private configurationQueue: Promise<void> = Promise.resolve();
  private configurationPending = 0;
  private configurationState?: { id: number; finish: (error?: unknown) => void };
  private handshakeState?: {
    id: number;
    expectedBuildId: string;
    finish: (error?: unknown, actualBuildId?: string) => void;
  };
  private readonly onMessageBound = (event: MessageEvent<SqliteReply>) =>
    this.onMessage(event.data);
  private readonly onErrorBound = (event: ErrorEvent) =>
    this.crash(event.error ?? new Error(event.message));

  constructor(
    private readonly worker?: SqliteWorkerLike,
    private readonly handler?: SqliteCallHandler,
    private readonly diagnostics: TramaDiagnostics = NOOP_TRAMA_DIAGNOSTICS
  ) {
    if (worker) {
      worker.addEventListener("message", this.onMessageBound);
      worker.addEventListener("error", this.onErrorBound);
      worker.addEventListener("messageerror", this.onErrorBound);
    }
  }

  call<M extends SqliteMethod>(
    method: M,
    payload: SqliteRequestPayloads[M],
    signal?: AbortSignal,
    options: {
      readonly transferOwnedBytes?: boolean;
      readonly diagnosticOperationId?: string;
      readonly diagnosticParentOperationId?: string;
      readonly diagnosticBatchId?: string;
    } = {}
  ): Promise<any> {
    if (this.configurationPending)
      return this.configurationQueue.then(() => this.call(method, payload, signal, options));
    if (this.closed)
      return Promise.reject(sqliteError("storage_unavailable", "Worker client is closed"));
    if (this.handler) return this.handler(method, payload, signal);
    if (!this.worker)
      return Promise.reject(sqliteError("storage_unavailable", "SQLite Worker is unavailable"));
    const id = this.nextId++;
    const request = {
      v: SQLITE_PROTOCOL_VERSION,
      id,
      method,
      payload,
      ...(options.diagnosticOperationId
        ? { diagnosticOperationId: options.diagnosticOperationId }
        : {}),
      ...(options.diagnosticParentOperationId
        ? { diagnosticParentOperationId: options.diagnosticParentOperationId }
        : {}),
      ...(options.diagnosticBatchId ? { diagnosticBatchId: options.diagnosticBatchId } : {}),
    } as SqliteRequest<M>;
    return new Promise((resolve, reject) => {
      let settled = false;
      let cleanup: () => void = () => undefined;
      const onAbort = signal
        ? () => {
            if (settled) return;
            const entry = this.pending.get(id);
            if (!entry) {
              settled = true;
              reject(sqliteError("cancelled", "Request cancelled", true));
              return;
            }
            // Keep the original request in `pending` until the Worker settles it.
            // This is the boundary that lets callers remain in `cancelling` while
            // an active SQLite transaction reaches its next cancellation check.
            entry.cancelled = true;
            entry.cleanup();
            if (entry) {
              try {
                const cancelId = this.nextId++;
                this.worker!.postMessage({
                  v: SQLITE_PROTOCOL_VERSION,
                  id: cancelId,
                  method: "cancelQueued",
                  payload: { requestId: id },
                });
              } catch {
                // Cancellation remains local even if the Worker is already gone.
              }
            }
          }
        : undefined;
      cleanup = () => signal?.removeEventListener("abort", onAbort!);
      if (signal?.aborted) return onAbort!();
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", onAbort!, { once: true });
      try {
        if (options.transferOwnedBytes && method !== "inspectPublication")
          throw new Error("Only staged publication inspection can transfer ownership");
        const copied = options.transferOwnedBytes
          ? {
              request,
              transfer: [(payload as SqliteRequestPayloads["inspectPublication"]).bytes],
            }
          : cloneRequest(request);
        this.worker!.postMessage(copied.request, copied.transfer);
      } catch (error) {
        settled = true;
        const entry = this.pending.get(id);
        this.pending.delete(id);
        entry?.cleanup();
        reject(
          sqliteError(
            "invalid_request",
            error instanceof Error ? error.message : "Could not copy request"
          )
        );
      }
    });
  }

  /** Unique across replacement Worker clients, even when RPC ids restart at one. */
  diagnosticOperationId(): string {
    return `w${this.incarnation}_o${this.nextOperation++}`;
  }

  configureDiagnostics(strict = false): Promise<void> {
    if (!this.worker || this.closed) return Promise.resolve();
    const diagnostics = {
      performance: diagnosticsEnabled(this.diagnostics, "performance"),
      detailed: diagnosticsEnabled(this.diagnostics, "detailed"),
      sessionId: this.diagnostics.context?.sessionId ?? "none",
    };
    this.configurationPending++;
    const work = this.configurationQueue.then(() => this.postDiagnosticsConfiguration(diagnostics));
    this.configurationQueue = work.then(
      () => {
        this.configurationPending--;
      },
      () => {
        this.configurationPending--;
      }
    );
    return strict ? work : this.configurationQueue;
  }

  private postDiagnosticsConfiguration(
    diagnostics: SqliteDiagnosticsConfigRequest["diagnostics"]
  ): Promise<void> {
    if (this.closed) return Promise.reject(new Error("SQLite Worker client is closed."));
    const id = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("SQLite diagnostic configuration timed out.")),
        DIAGNOSTICS_CONFIGURATION_TIMEOUT_MS
      );
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        this.configurationState = undefined;
        if (error) reject(error);
        else resolve();
      };
      this.configurationState = { id, finish };
      try {
        this.worker!.postMessage({
          type: SQLITE_DIAGNOSTICS_CONFIG_TYPE,
          id,
          diagnostics,
        } satisfies SqliteDiagnosticsConfigRequest);
      } catch (error) {
        finish(error);
      }
    });
  }

  handshake(expectedBuildId: string, signal?: AbortSignal): Promise<string> {
    if (this.handler) return Promise.resolve(expectedBuildId);
    if (!this.worker)
      return Promise.reject(
        sqliteError("storage_unavailable", "SQLite Worker is unavailable.", true)
      );
    if (this.handshakePromise) return this.handshakePromise;
    const id = this.nextId++;
    this.handshakePromise = new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => finish(new Error("SQLite Worker handshake timed out.")),
        HANDSHAKE_TIMEOUT_MS
      );
      const abort = () => finish(sqliteError("cancelled", "Request cancelled", true));
      const finish = (error?: unknown, actualBuildId?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(actualBuildId ?? expectedBuildId);
      };
      this.handshakeState = { id, expectedBuildId, finish };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.worker!.postMessage({
          type: HANDSHAKE_TYPE,
          id,
          diagnostics: {
            performance: diagnosticsEnabled(this.diagnostics, "performance"),
            detailed: diagnosticsEnabled(this.diagnostics, "detailed"),
            sessionId: this.diagnostics.context?.sessionId ?? "none",
          },
        });
      } catch (error) {
        finish(error);
      }
    }).catch((error: unknown) => {
      this.handshakePromise = undefined;
      this.terminateNow();
      if (error instanceof SqliteProtocolError) throw error;
      if (error instanceof Error && error.message === "SQLite Worker handshake timed out.")
        throw sqliteError("storage_unavailable", "SQLite Worker handshake timed out.", true);
      if (error instanceof Error && error.message === "SQLite Worker build identity mismatch.")
        throw sqliteError(
          "storage_unavailable",
          "Installed SQLite runtime files do not match. Reinstall the plugin and reload Obsidian.",
          true
        );
      throw sqliteError("storage_unavailable", "SQLite Worker failed during startup.", true);
    });
    return this.handshakePromise;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    try {
      await this.call("shutdown", {});
    } finally {
      this.closed = true;
      this.worker?.terminate?.();
      this.crash(sqliteError("storage_unavailable", "Worker client is closed"));
      this.worker?.removeEventListener?.("message", this.onMessageBound);
      this.worker?.removeEventListener?.("error", this.onErrorBound);
      this.worker?.removeEventListener?.("messageerror", this.onErrorBound);
    }
  }

  dispose(): void {
    this.terminateNow();
  }

  /** Synchronous best-effort shutdown for Obsidian's synchronous unload hook. */
  terminateNow(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker?.terminate?.();
    this.crash(sqliteError("worker_crashed", "SQLite Worker stopped", true));
    this.worker?.removeEventListener?.("message", this.onMessageBound);
    this.worker?.removeEventListener?.("error", this.onErrorBound);
    this.worker?.removeEventListener?.("messageerror", this.onErrorBound);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private onMessage(reply: SqliteReply): void {
    const config = this.configurationState;
    if (
      config &&
      (reply as any)?.type === SQLITE_DIAGNOSTICS_CONFIG_TYPE &&
      (reply as any).id === config.id
    ) {
      config.finish(
        (reply as any).configured === true
          ? undefined
          : new Error("SQLite diagnostic configuration failed.")
      );
      return;
    }
    if ((reply as any)?.type === SQLITE_DIAGNOSTIC_EVENT_TYPE) {
      const record = (reply as unknown as SqliteDiagnosticEventMessage).record;
      if (
        record?.tier === "performance" &&
        record.context?.sessionId === this.diagnostics.context?.sessionId &&
        (!record.context?.operationId ||
          record.context.operationId.startsWith(`w${this.incarnation}_`)) &&
        (!record.context?.parentOperationId ||
          record.context.parentOperationId.startsWith(`w${this.incarnation}_`)) &&
        (!record.context?.batchId || record.context.batchId.startsWith(`w${this.incarnation}_`))
      )
        emitTramaDiagnostic(this.diagnostics, record);
      return;
    }
    const handshake = this.handshakeState;
    if (
      handshake &&
      (reply as any)?.type === HANDSHAKE_TYPE &&
      (reply as any).id === handshake.id
    ) {
      const actual = (reply as any).buildId;
      const configured = (reply as any).diagnosticsConfigured === true;
      handshake.finish(
        actual === handshake.expectedBuildId && configured
          ? undefined
          : new Error("SQLite Worker build identity mismatch."),
        actual
      );
      this.handshakeState = undefined;
      return;
    }
    if (
      handshake &&
      reply?.v === SQLITE_PROTOCOL_VERSION &&
      reply.id === handshake.id &&
      !reply.ok &&
      reply.error.code === "storage_unavailable"
    ) {
      this.handshakeState = undefined;
      handshake.finish(
        sqliteError("storage_unavailable", "SQLite Worker module could not be started.", true)
      );
      return;
    }
    if (!reply || reply.v !== SQLITE_PROTOCOL_VERSION || !Number.isSafeInteger(reply.id)) return;
    const entry = this.pending.get(reply.id);
    if (!entry) return;
    entry.cleanup();
    this.pending.delete(reply.id);
    if (entry.cancelled) entry.reject(sqliteError("cancelled", "Request cancelled", true));
    else if (reply.ok) entry.resolve(reply.result);
    else entry.reject(new SqliteProtocolError(reply.error));
  }

  private crash(error: unknown): void {
    this.configurationState?.finish(error);
    const handshake = this.handshakeState;
    if (handshake) {
      this.handshakeState = undefined;
      handshake.finish(
        error instanceof SqliteProtocolError
          ? error
          : sqliteError("storage_unavailable", "SQLite Worker failed during startup.", true)
      );
    }
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.cleanup();
      entry.reject(error);
    }
  }
}

function cloneRequest<M extends SqliteMethod>(
  request: SqliteRequest<M>
): { request: SqliteRequest<M>; transfer: ArrayBuffer[] } {
  const cloned = structuredClone(request) as SqliteRequest<M>;
  const payload = cloned.payload as Record<string, unknown>;
  const transfer: ArrayBuffer[] = [];
  if (payload.vector instanceof Float32Array && payload.vector.buffer instanceof ArrayBuffer)
    transfer.push(payload.vector.buffer);
  if (payload.bytes instanceof ArrayBuffer) transfer.push(payload.bytes);
  const vectors = payload.results as readonly { vector?: Float32Array }[] | undefined;
  if (vectors)
    for (const item of vectors)
      if (item.vector?.buffer instanceof ArrayBuffer) transfer.push(item.vector.buffer);
  return { request: cloned, transfer };
}
