import { describe, expect, it } from "vitest";
import { SqliteWorkerClient } from "@/index/sqlite/client";
import { SQLITE_PROTOCOL_VERSION } from "@/index/sqlite/protocol";

class DelayedWorker {
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  postMessage(message: any): void {
    if (message.method === "cancelQueued") return;
    setTimeout(
      () =>
        this.emit("message", {
          data: { v: SQLITE_PROTOCOL_VERSION, id: message.id, ok: true, result: {} },
        }),
      0
    );
  }
  terminate() {}
  addEventListener(type: string, listener: (event: any) => void): void {
    (
      this.listeners.get(type) ?? (this.listeners.set(type, new Set()), this.listeners.get(type)!)
    ).add(listener);
  }
  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("SQLite mutation failure boundaries", () => {
  it("discards a late acknowledgement after cancellation", async () => {
    const worker = new DelayedWorker();
    const client = new SqliteWorkerClient(worker);
    const controller = new AbortController();
    const request = client.call("getState", {}, controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ error: { code: "cancelled" } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(client.pendingCount).toBe(0);
  });

  it("fans a worker crash out to all pending calls", async () => {
    const worker = new DelayedWorker();
    const client = new SqliteWorkerClient(worker);
    const first = client.call("getState", {});
    const second = client.call("markIncomplete", {});
    worker.emit("error", { error: new Error("crashed") });
    await expect(first).rejects.toThrow("crashed");
    await expect(second).rejects.toThrow("crashed");
    expect(client.pendingCount).toBe(0);
  });
});
