import { describe, expect, it, vi } from "vitest";
import { SqliteWorkerClient } from "@/index/sqlite/client";
import { SQLITE_PROTOCOL_VERSION } from "@/index/sqlite/protocol";

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

  it("terminates synchronously for immediate unload cleanup", () => {
    const worker = new FakeWorker();
    const client = new SqliteWorkerClient(worker);
    client.terminateNow();
    expect(worker.terminated).toBe(true);
    expect(client.pendingCount).toBe(0);
  });
});
