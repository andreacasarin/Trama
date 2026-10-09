import type { NoteStoreCall, NoteStoreInit, NoteStoreMethod, NoteStoreRpc } from "./protocol";

export interface NoteStoreWorkerLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (event: any) => void
  ): void;
  removeEventListener?(
    type: "message" | "error" | "messageerror",
    listener: (event: any) => void
  ): void;
  terminate?(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  abort?: () => void;
}

interface RpcError {
  readonly name?: string;
  readonly message?: string;
}

const CLOSED = new Error("Note store client closed");

function rpcError(error?: RpcError | string): Error {
  if (typeof error === "string") return new Error(error);
  const message = typeof error?.message === "string" ? error.message : "Note store request failed";
  if (error?.name === "AbortError") return new DOMException(message, "AbortError");
  const result = new Error(message);
  if (typeof error?.name === "string") result.name = error.name;
  return result;
}

export class NoteStoreClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly ready: Promise<unknown>;
  private readonly onMessage = (event: MessageEvent) => {
    const message = event.data as {
      id: number;
      ok: boolean;
      result?: unknown;
      error?: RpcError | string;
    };
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(rpcError(message.error));
  };
  private readonly onError = (event: ErrorEvent | MessageEvent) => {
    const detail = event as ErrorEvent;
    const error =
      typeof detail.message === "string"
        ? (detail.error ?? new Error(detail.message))
        : new Error("Note store worker could not deserialize a message");
    for (const pending of this.pending.values()) {
      if (pending.signal && pending.abort)
        pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(error);
    }
    this.pending.clear();
  };

  constructor(
    private readonly worker: NoteStoreWorkerLike,
    namespace: string
  ) {
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onError);
    worker.addEventListener("messageerror", this.onError);
    this.ready = this.send("init", { namespace });
  }

  initialize(): Promise<void> {
    return this.ready.then(() => undefined);
  }

  readonly call: NoteStoreCall = async (method, payload, signal) => {
    if (this.closing || this.closed) throw CLOSED;
    await this.ready;
    if (this.closing || this.closed) throw CLOSED;
    if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    return this.send(method, payload, signal);
  };

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      const deadline = Date.now() + 2_000;
      const beforeDeadline = <T>(promise: Promise<T>): Promise<T | undefined> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
          promise,
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
      };
      try {
        const initialized = await beforeDeadline(
          this.ready.then(
            () => true,
            () => false
          )
        );
        if (initialized) {
          for (const id of this.pending.keys()) {
            try {
              this.worker.postMessage({
                id: this.nextId++,
                method: "cancel",
                payload: { requestId: id },
              });
            } catch {
              // The bounded termination fallback below releases the worker.
            }
          }
          const closeAck = this.send("close", {});
          await beforeDeadline(closeAck);
        }
      } finally {
        this.closed = true;
        this.worker.removeEventListener?.("message", this.onMessage);
        this.worker.removeEventListener?.("error", this.onError);
        this.worker.removeEventListener?.("messageerror", this.onError);
        for (const pending of this.pending.values()) pending.reject(CLOSED);
        this.pending.clear();
        this.worker.terminate?.();
      }
    })();
    return this.closePromise;
  }

  private send(method: "init", payload: NoteStoreInit): Promise<unknown>;
  private send(method: "close", payload: Record<string, never>): Promise<unknown>;
  private send<M extends NoteStoreMethod>(
    method: M,
    payload: NoteStoreRpc[M],
    signal?: AbortSignal
  ): Promise<unknown>;
  private send(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        try {
          this.worker.postMessage({
            id: this.nextId++,
            method: "cancel",
            payload: { requestId: id },
          });
        } catch (error) {
          reject(error);
        }
      };
      this.pending.set(id, { resolve, reject, signal, abort });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.worker.postMessage({ id, method, payload });
      } catch (error) {
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(error);
      }
    });
  }
}

export type NoteStoreWorkerHandler = <M extends NoteStoreMethod>(
  method: M,
  payload: NoteStoreRpc[M],
  signal?: AbortSignal
) => Promise<unknown>;
