import { describe, expect, it, vi } from "vitest";
import { SqliteWorkerClient } from "@/index/sqlite/client";
import { SQLITE_PROTOCOL_VERSION } from "@/index/sqlite/protocol";
import { TRAMA_RUNTIME_BUILD_ID } from "@/build/identity";
import { createTramaDiagnostics } from "@/diagnostics/TramaDiagnostics";

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
  it("correlates concurrent calls and rejects a prior Worker incarnation", async () => {
    const records: any[] = [];
    const diagnostics = createTramaDiagnostics(
      () => "performance",
      (record) => records.push(record),
      { sessionId: "session-c" }
    );
    const worker = new FakeWorker();
    const client = new SqliteWorkerClient(worker, undefined, diagnostics);
    const first = client.diagnosticOperationId();
    const second = client.diagnosticOperationId();
    const parent = client.diagnosticOperationId();
    expect(first).not.toBe(second);
    await Promise.all([
      client.call("getState", {}, undefined, {
        diagnosticOperationId: first,
        diagnosticParentOperationId: parent,
        diagnosticBatchId: first,
      }),
      client.call("getState", {}, undefined, {
        diagnosticOperationId: second,
        diagnosticParentOperationId: parent,
        diagnosticBatchId: first,
      }),
    ]);
    expect(worker.messages.map((message) => message.value.diagnosticOperationId)).toEqual([
      first,
      second,
    ]);
    expect(worker.messages.map((message) => message.value.diagnosticParentOperationId)).toEqual([
      parent,
      parent,
    ]);
    expect(worker.messages.map((message) => message.value.diagnosticBatchId)).toEqual([
      first,
      first,
    ]);
    const replacementWorker = new FakeWorker();
    const replacement = new SqliteWorkerClient(replacementWorker, undefined, diagnostics);
    const fresh = replacement.diagnosticOperationId();
    const freshParent = replacement.diagnosticOperationId();
    expect(fresh).not.toBe(first);
    const event = (operationId: string, parentOperationId: string, batchId: string) => ({
      type: "trama-diagnostic",
      record: {
        tier: "performance",
        facets: ["index", "worker"],
        area: "index",
        event: "phase",
        operation: "semantic",
        phase: "prepareSemanticWork",
        durationMs: 1,
        context: { sessionId: "session-c", requestId: 1, operationId, parentOperationId, batchId },
      },
    });
    replacementWorker.emit("message", { data: event(first, parent, first) });
    expect(records).toHaveLength(0);
    replacementWorker.emit("message", { data: event(fresh, parent, first) });
    expect(records).toHaveLength(0);
    replacementWorker.emit("message", { data: event(fresh, freshParent, fresh) });
    expect(records).toHaveLength(1);
    expect(records[0].context.operationId).toBe(fresh);
    expect(records[0].context).toMatchObject({ parentOperationId: freshParent, batchId: fresh });
  });
  it("acknowledges capture configuration before work and restores the Worker afterward", async () => {
    const worker = new FakeWorker();
    worker.postMessage = ((value: any) => {
      worker.messages.push({ value });
      if (value.type === "trama-diagnostics-config")
        queueMicrotask(() =>
          worker.emit("message", { data: { type: value.type, id: value.id, configured: true } })
        );
    }) as any;
    const diagnostics = createTramaDiagnostics(
      () => "off",
      () => undefined,
      { sessionId: "capture-c" }
    );
    const client = new SqliteWorkerClient(worker, undefined, diagnostics);
    await diagnostics.capturePerformance!(
      () => client.configureDiagnostics(true),
      async () => {
        expect(worker.messages[0].value.diagnostics.performance).toBe(true);
        expect(diagnostics.enabled("performance")).toBe(true);
      }
    );
    expect(worker.messages[1].value.diagnostics.performance).toBe(false);
  });
  it("serializes distinct captured states instead of coalescing restoration with a new entry", async () => {
    const worker = new FakeWorker();
    worker.postMessage = ((value: any) => {
      worker.messages.push({ value });
    }) as any;
    let mode: "off" | "performance" | "detailed" = "performance";
    const diagnostics = createTramaDiagnostics(
      () => mode,
      () => undefined,
      { sessionId: "race" }
    );
    const client = new SqliteWorkerClient(worker, undefined, diagnostics);
    const first = client.configureDiagnostics(true);
    mode = "off";
    const restore = client.configureDiagnostics(true);
    mode = "detailed";
    const next = client.configureDiagnostics(true);
    await Promise.resolve();
    expect(worker.messages).toHaveLength(1);
    const ack = (index: number) =>
      worker.emit("message", {
        data: {
          type: "trama-diagnostics-config",
          id: worker.messages[index].value.id,
          configured: true,
        },
      });
    expect(worker.messages[0].value.diagnostics).toMatchObject({
      performance: true,
      detailed: false,
    });
    ack(0);
    await first;
    await Promise.resolve();
    expect(worker.messages[1].value.diagnostics).toMatchObject({
      performance: false,
      detailed: false,
    });
    ack(1);
    await restore;
    await Promise.resolve();
    expect(worker.messages[2].value.diagnostics).toMatchObject({
      performance: true,
      detailed: true,
    });
    ack(2);
    await next;
  });
  it("configures diagnostics before boot, transports correlated events, and reconfigures before later calls", async () => {
    const worker = new FakeWorker();
    const original = worker.postMessage.bind(worker);
    worker.postMessage = ((value: any, transfer?: readonly ArrayBuffer[]) => {
      if (value.type === "trama-runtime-handshake") {
        worker.messages.push({ value });
        queueMicrotask(() =>
          worker.emit("message", {
            data: {
              type: value.type,
              id: value.id,
              buildId: TRAMA_RUNTIME_BUILD_ID,
              diagnosticsConfigured: true,
            },
          })
        );
        return;
      }
      if (value.type === "trama-diagnostics-config") {
        worker.messages.push({ value });
        queueMicrotask(() =>
          worker.emit("message", {
            data: {
              type: value.type,
              id: value.id,
              configured: true,
            },
          })
        );
        return;
      }
      original(value, transfer);
    }) as any;
    let mode: "off" | "performance" = "performance";
    const records: unknown[] = [];
    const diagnostics = createTramaDiagnostics(
      () => mode,
      (record) => records.push(record),
      { sessionId: "session-1" }
    );
    const client = new SqliteWorkerClient(worker, undefined, diagnostics);
    await client.handshake(TRAMA_RUNTIME_BUILD_ID);
    expect(worker.messages[0].value.diagnostics).toEqual({
      performance: true,
      detailed: false,
      sessionId: "session-1",
    });
    await client.call("boot", { corpusFingerprint: "a", dimensions: 2 });
    worker.emit("message", {
      data: {
        type: "trama-diagnostic",
        record: {
          tier: "performance",
          facets: ["index", "worker"],
          area: "index",
          event: "phase",
          operation: "semantic",
          phase: "firstInputLookup",
          durationMs: 2,
          context: { sessionId: "session-1", requestId: 2 },
        },
      },
    });
    expect(records).toHaveLength(1);
    worker.emit("message", {
      data: {
        type: "trama-diagnostic",
        record: {
          tier: "performance",
          facets: ["index"],
          area: "index",
          event: "phase",
          operation: "semantic",
          phase: "firstInputLookup",
          durationMs: 2,
          context: { sessionId: "stale", requestId: 2 },
        },
      },
    });
    expect(records).toHaveLength(1);
    mode = "off";
    const configured = client.configureDiagnostics();
    const next = client.call("getState", {});
    await configured;
    await next;
    expect(worker.messages.at(-2)?.value.type).toBe("trama-diagnostics-config");
    expect(worker.messages.at(-1)?.value.method).toBe("getState");
    const restarted = new FakeWorker();
    restarted.postMessage = ((value: any) => {
      restarted.messages.push({ value });
      if (value.type === "trama-runtime-handshake")
        queueMicrotask(() =>
          restarted.emit("message", {
            data: {
              type: value.type,
              id: value.id,
              buildId: TRAMA_RUNTIME_BUILD_ID,
              diagnosticsConfigured: true,
            },
          })
        );
    }) as any;
    const replacement = new SqliteWorkerClient(restarted, undefined, diagnostics);
    await replacement.handshake(TRAMA_RUNTIME_BUILD_ID);
    expect(restarted.messages[0].value.diagnostics.performance).toBe(false);
  });
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
            data: {
              type: value.type,
              id: value.id,
              buildId: TRAMA_RUNTIME_BUILD_ID,
              diagnosticsConfigured: true,
            },
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

  it("sends lexical Markdown batches without requiring vector transferables", async () => {
    const worker = new FakeWorker();
    const client = new SqliteWorkerClient(worker);

    await client.call("applyLexicalBatch", {
      runId: "lexical-1",
      notes: [{ path: "lexical.md", markdown: "lexical only", size: 384 }],
    });

    expect(worker.messages[0].value.method).toBe("applyLexicalBatch");
    expect(worker.messages[0].transfer).toEqual([]);
  });

  it("transfers embedding result vectors without copying them", async () => {
    const worker = new FakeWorker();
    const client = new SqliteWorkerClient(worker);
    const vector = new Float32Array([1, 0]);

    await client.call("commitSemanticResults", {
      embeddingFingerprint: "a".repeat(64),
      dimensions: 2,
      expectedCount: 1,
      results: [{ actionKey: "a".repeat(64), inputId: 1, serialization: "input", vector }],
    });

    expect(worker.messages[0].value.method).toBe("commitSemanticResults");
    expect(worker.messages[0].transfer).toEqual([vector.buffer]);
  });

  it("does not treat an unsupported vectors alias as semantic results", async () => {
    const worker = new FakeWorker();
    const client = new SqliteWorkerClient(worker);
    const vector = new Float32Array([1, 0]);

    await client.call("commitSemanticResults", {
      embeddingFingerprint: "a".repeat(64),
      dimensions: 2,
      expectedCount: 0,
      results: [],
      vectors: [{ vector }],
    } as any);

    expect(worker.messages[0].transfer).toEqual([]);
    expect(worker.messages[0].value.payload.vectors[0].vector).not.toBe(vector);
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
