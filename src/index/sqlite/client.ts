import {
  SQLITE_PROTOCOL_VERSION,
  type SqliteMethod,
  type SqliteReply,
  type SqliteRequest,
  type SqliteRequestPayloads,
  SqliteProtocolError,
  sqliteError,
} from "./protocol";

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
}

/** Main-thread RPC client. Requests copy caller buffers unless ownership is explicitly transferred. */
export class SqliteWorkerClient {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly onMessageBound = (event: MessageEvent<SqliteReply>) =>
    this.onMessage(event.data);
  private readonly onErrorBound = (event: ErrorEvent) =>
    this.crash(event.error ?? new Error(event.message));

  constructor(
    private readonly worker?: SqliteWorkerLike,
    private readonly handler?: SqliteCallHandler
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
    options: { readonly transferOwnedBytes?: boolean } = {}
  ): Promise<any> {
    if (this.closed)
      return Promise.reject(sqliteError("storage_unavailable", "Worker client is closed"));
    if (this.handler) return this.handler(method, payload, signal);
    if (!this.worker)
      return Promise.reject(sqliteError("storage_unavailable", "SQLite Worker is unavailable"));
    const id = this.nextId++;
    const request = { v: SQLITE_PROTOCOL_VERSION, id, method, payload } as SqliteRequest<M>;
    return new Promise((resolve, reject) => {
      let settled = false;
      let cleanup: () => void = () => undefined;
      const onAbort = signal
        ? () => {
            if (settled) return;
            settled = true;
            const entry = this.pending.get(id);
            this.pending.delete(id);
            entry?.cleanup();
            reject(sqliteError("cancelled", "Request cancelled", true));
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
    if (!reply || reply.v !== SQLITE_PROTOCOL_VERSION || !Number.isSafeInteger(reply.id)) return;
    const entry = this.pending.get(reply.id);
    if (!entry) return;
    entry.cleanup();
    this.pending.delete(reply.id);
    if (reply.ok) entry.resolve(reply.result);
    else entry.reject(new SqliteProtocolError(reply.error));
  }

  private crash(error: unknown): void {
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
  // These payloads contain only strings and numbers; postMessage performs the one required clone.
  if (request.method === "hashMarkdown" || request.method === "upsertMarkdown")
    return { request, transfer: [] };
  const cloned = structuredClone(request) as SqliteRequest<M>;
  const payload = cloned.payload as Record<string, unknown>;
  const transfer: ArrayBuffer[] = [];
  if (payload.vector instanceof Float32Array && payload.vector.buffer instanceof ArrayBuffer)
    transfer.push(payload.vector.buffer);
  if (payload.bytes instanceof ArrayBuffer) transfer.push(payload.bytes);
  const vectors = payload.vectors as readonly { vector?: Float32Array }[] | undefined;
  if (vectors)
    for (const item of vectors)
      if (item.vector?.buffer instanceof ArrayBuffer) transfer.push(item.vector.buffer);
  return { request: cloned, transfer };
}
