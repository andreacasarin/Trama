import { describe, expect, it, vi } from "vitest";
import { SqliteWorkerClient } from "@/index/sqlite/client";
import { SQLITE_PROTOCOL_VERSION } from "@/index/sqlite/protocol";
import { TRAMA_RUNTIME_BUILD_ID } from "@/build/identity";

class FakeWorker {
  readonly messages: { value: any; transfer?: readonly ArrayBuffer[] }[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  postMessage(value: any, transfer?: readonly ArrayBuffer[]): void {
    this.messages.push({ value, transfer });
    queueMicrotask(() =>
      this.emit("message", {
        data: {
          v: SQLITE_PROTOCOL_VERSION,
          id: value.id,
          ok: true,
          result: { method: value.method },
        },
      })
    );
  }
  terminate(): void {
    this.terminated = true;
  }
  addEventListener(type: string, listener: (event: any) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) this.listeners.set(type, (listeners = new Set()));
    listeners.add(listener);
  }
  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

describe("SqliteWorkerClient", () => {
  it("owns request ids and copies caller transferables", async () => {
    const worker = new FakeWorker();
    const client = new SqliteWorkerClient(worker);
    const vector = new Float32Array([1, 0]);
    await client.call("findRelated", { path: "a.md", vector, limit: 2 });
    expect(worker.messages[0].value.id).toBe(1);
    expect(worker.messages[0].transfer).toHaveLength(1);
    expect(worker.messages[0].transfer?.[0]).not.toBe(vector.buffer);
    await client.shutdown();
    expect(client.pendingCount).toBe(0);
    expect(worker.listenerCount("messageerror")).toBe(0);
  });

  it("accepts the runtime handshake before numeric protocol requests", async () => {
    const worker = new FakeWorker();
    let handshakeSent = false;
    const original = worker.postMessage.bind(worker);
    worker.postMessage = ((value: any, transfer?: readonly ArrayBuffer[]) => {
      if (value.type === "trama-runtime-handshake") {
        handshakeSent = true;
        queueMicrotask(() =>
          worker.emit("message", {
            data: { type: value.type, id: value.id, buildId: TRAMA_RUNTIME_BUILD_ID },
          })
        );
        return;
      }
      original(value, transfer);
    }) as any;
    const client = new SqliteWorkerClient(worker);
    await expect(client.handshake(TRAMA_RUNTIME_BUILD_ID)).resolves.toBe(TRAMA_RUNTIME_BUILD_ID);
    expect(handshakeSent).toBe(true);
  });

  it("terminates a worker that does not complete the runtime handshake", async () => {
    const worker = new FakeWorker();
    const client = new SqliteWorkerClient(worker);
    await expect(client.handshake(TRAMA_RUNTIME_BUILD_ID)).rejects.toMatchObject({
      error: { code: "storage_unavailable" },
    });
    expect(worker.terminated).toBe(true);
  });

  it("terminates immediately when the Worker reports a mismatched build", async () => {
    const worker = new FakeWorker();
    worker.postMessage = ((value: any) => {
      queueMicrotask(() =>
        worker.emit("message", {
          data: { type: "trama-runtime-handshake", id: value.id, buildId: "stale-build" },
        })
      );
    }) as any;
    const client = new SqliteWorkerClient(worker);
    await expect(client.handshake(TRAMA_RUNTIME_BUILD_ID)).rejects.toMatchObject({
      error: { code: "storage_unavailable" },
    });
    expect(worker.terminated).toBe(true);
  });

  it("fails the handshake on Worker error and messageerror without leaving a timer", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const client = new SqliteWorkerClient(worker);
      const handshake = client.handshake(TRAMA_RUNTIME_BUILD_ID);
      worker.emit("error", { error: new Error("worker failed") });
      worker.emit("messageerror", { error: new Error("message failed") });
      await expect(handshake).rejects.toMatchObject({
        error: { code: "storage_unavailable" },
      });
      expect(worker.terminated).toBe(true);
      vi.advanceTimersByTime(2_000);
      expect(client.pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends lexical Markdown without requiring vector transferables", async () => {
    const worker = new FakeWorker();
    const client = new SqliteWorkerClient(worker);

    await client.call("upsertLexicalRevision", {
      path: "lexical.md",
      markdown: "lexical only",
      expectedRevisionDigest: "a".repeat(64),
      size: 384,
    });

    expect(worker.messages[0].value.method).toBe("upsertLexicalRevision");
    expect(worker.messages[0].transfer).toEqual([]);
  });

  it("transfers embedding result vectors without copying them", async () => {
    const worker = new FakeWorker();
    const client = new SqliteWorkerClient(worker);
    const vector = new Float32Array([1, 0]);

    await client.call("storeEmbeddingResults", {
      embeddingFingerprint: "a".repeat(64),
      results: [{ actionKey: "a".repeat(64), inputId: 1, serialization: "input", vector }],
    });

    expect(worker.messages[0].value.method).toBe("storeEmbeddingResults");
    expect(worker.messages[0].transfer).toEqual([vector.buffer]);
  });

  it("transfers owned publication readback without copying it on the main thread", async () => {
    const worker = new FakeWorker();
    const client = new SqliteWorkerClient(worker);
    const bytes = new Uint8Array([1, 2, 3]).buffer;

    await client.call("inspectPublication", { bytes }, undefined, { transferOwnedBytes: true });

    expect(worker.messages[0].value.payload.bytes).toBe(bytes);
    expect(worker.messages[0].transfer).toEqual([bytes]);
  });

  it("rejects pending calls on a Worker crash", async () => {
    const worker = new FakeWorker();
    const client = new SqliteWorkerClient(worker);
    const pending = client.call("getState", {});
    worker.emit("error", { error: new Error("crash") });
    await expect(pending).rejects.toThrow("crash");
    expect(client.pendingCount).toBe(0);
  });

  it("removes abort listeners after replies and does not cancel settled RPCs", async () => {
    const worker = new FakeWorker();
    const client = new SqliteWorkerClient(worker);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await Promise.all(
      Array.from({ length: 64 }, () => client.call("getState", {}, controller.signal))
    );
    expect(remove).toHaveBeenCalledTimes(64);
    controller.abort();
    expect(worker.messages.filter((entry) => entry.value.method === "cancelQueued")).toHaveLength(
      0
    );
    expect(client.pendingCount).toBe(0);
  });

  it("cleans abort listeners when crash fan-out rejects pending calls", async () => {
    const worker = new FakeWorker();
    const client = new SqliteWorkerClient(worker);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = Array.from({ length: 8 }, () => client.call("getState", {}, controller.signal));
    worker.emit("error", { error: new Error("crash") });
    const results = await Promise.allSettled(pending);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(remove).toHaveBeenCalledTimes(8);
    controller.abort();
    expect(worker.messages.filter((entry) => entry.value.method === "cancelQueued")).toHaveLength(
      0
    );
  });

  it("discards a cancelled request and asks the Worker to cancel its queue", async () => {
    const worker = new FakeWorker();
    const client = new SqliteWorkerClient(worker);
    const controller = new AbortController();
    const pending = client.call("getState", {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ error: { code: "cancelled" } });
    expect(worker.messages.some((entry) => entry.value.method === "cancelQueued")).toBe(true);
  });

  it("keeps a cancelled request pending until the original Worker reply settles", async () => {
    const worker = new FakeWorker();
    const original = worker.postMessage.bind(worker);
    worker.postMessage = ((value: any, transfer?: readonly ArrayBuffer[]) => {
      if (value.method === "cancelQueued") return;
      worker.messages.push({ value, transfer });
    }) as any;
    const client = new SqliteWorkerClient(worker);
    const controller = new AbortController();
    const pending = client.call("getState", {}, controller.signal);
    controller.abort();
    expect(client.pendingCount).toBe(1);
    worker.emit("message", {
      data: { v: SQLITE_PROTOCOL_VERSION, id: 1, ok: true, result: { late: true } },
    });
    await expect(pending).rejects.toMatchObject({ error: { code: "cancelled" } });
    expect(client.pendingCount).toBe(0);
    worker.postMessage = original;
  });

  it("terminates synchronously for immediate unload cleanup", () => {
    const worker = new FakeWorker();
    const client = new SqliteWorkerClient(worker);
    client.terminateNow();
    expect(worker.terminated).toBe(true);
    expect(client.pendingCount).toBe(0);
  });
});
