import { deferred } from "./test-helpers";
import { describe, expect, it, vi } from "vitest";
import {
  closeWorkerDatabase,
  exportOpfsDatabase,
  resetWorkerDatabase,
  type OpfsSAHPoolUtilLike,
} from "@/index/sqlite/worker-lifecycle";
import { PublicationService } from "@/index/manager/publication";
import { SqliteScheduler } from "@/index/sqlite/scheduler";

describe("SQLite Worker storage lifecycle", () => {
  it("keeps queued reads available behind serialized cache-shard ingestion", async () => {
    const scheduler = new SqliteScheduler();
    const ingestGate = deferred<void>();
    const state = { noteCount: 1 };
    const order: string[] = [];
    let id = 0;
    const runtime = {
      building: false,
      preparing: false,
      loaded: true,
      unavailable: false,
      state,
      isInMaintenance: () => false,
      beginMaintenance: vi.fn(),
      endMaintenance: vi.fn(),
      setState: vi.fn(),
      ensureClient: () => ({
        call: (method: string) =>
          scheduler.enqueue(++id, async () => {
            order.push(method);
            if (method === "ingestCacheShard") {
              await ingestGate.promise;
              return { imported: 1, duplicate: false, profile: "profile", taskKind: "document" };
            }
            if (method === "getState") return state;
            throw new Error("unexpected worker method");
          }),
      }),
    };
    const service = new PublicationService(runtime as any);
    const ingest = service.ingestCacheShard(new ArrayBuffer(1), "digest");
    const related = scheduler.enqueue(++id, async () => {
      order.push("findRelated");
      return [{ path: "notes/0002.md" }];
    });
    expect(runtime.isInMaintenance()).toBe(false);
    expect(runtime.beginMaintenance).not.toHaveBeenCalled();
    expect(order).toEqual(["ingestCacheShard"]);

    ingestGate.resolve();
    await expect(ingest).resolves.toMatchObject({ imported: 1, duplicate: false });
    await expect(related).resolves.toEqual([{ path: "notes/0002.md" }]);
    expect(order).toEqual(["ingestCacheShard", "findRelated", "getState"]);
    expect(runtime.endMaintenance).not.toHaveBeenCalled();
  });

  it("does not throw while sanitizing an open failure with no message", async () => {
    const platformError = Object.create(Error.prototype) as Error;
    Object.defineProperty(platformError, "message", { value: undefined });
    Object.defineProperty(platformError, "name", { value: undefined });
    vi.stubGlobal("self", { onmessage: undefined });
    try {
      const {
        storageFailureDetail,
        workerFailureLocation,
        workerFailureReply,
        retrievalPhaseRecord,
      } = await import("@/index/sqlite/worker");
      expect(retrievalPhaseRecord("findRelated", "centroid", 1, 2)).toMatchObject({
        operation: "related",
        area: "filo",
        facets: ["index", "related", "worker"],
      });
      expect(retrievalPhaseRecord("retrieve", "fusion", 1, 2)).toMatchObject({
        operation: "retrieve",
        area: "index",
        facets: ["index", "retrieve", "worker"],
      });
      expect(() => storageFailureDetail(platformError)).not.toThrow();
      expect(storageFailureDetail(platformError)).toBe("unknown failure");

      const namedError = Object.create(Error.prototype) as Error & {
        code?: unknown;
        resultCode?: unknown;
      };
      Object.defineProperties(namedError, {
        message: { value: undefined },
        name: { value: "DOMException" },
        code: { value: "E_OPEN" },
      });
      expect(storageFailureDetail(namedError)).toBe("name=DOMException code=E_OPEN");

      const privateError = Object.create(Error.prototype) as Error & { code?: unknown };
      Object.defineProperties(privateError, {
        message: { value: undefined },
        name: { value: "/vault/secret.md" },
        code: { value: "/private/content" },
      });
      expect(storageFailureDetail(privateError)).toBe("unknown failure");
      const stackError = new Error("private content");
      Object.defineProperty(stackError, "stack", {
        value: "Error: private content\n    at load (/private/vault/sqlite-worker.mjs:42:7)",
      });
      expect(workerFailureLocation(stackError)).toBe("load@sqlite-worker.mjs:42");
      expect(workerFailureLocation(stackError)).not.toContain("/private");
      const electronError = new TypeError("Cannot read properties of undefined");
      Object.defineProperty(electronError, "stack", {
        value:
          "TypeError: Cannot read properties of undefined\n    at async openDatabase (file:///vault/sqlite-worker.mjs:17:9)",
      });
      for (const phase of ["validation", "dispatch", "open", "execute"] as const) {
        const reply = workerFailureReply(electronError, "getState", phase);
        expect(reply).toMatchObject({
          code: "internal",
          method: "getState",
          phase,
          debugLocation: "openDatabase@sqlite-worker.mjs:17",
        });
        expect(JSON.stringify(reply)).not.toContain("/vault");
      }
      expect(
        workerFailureReply(
          { error: { code: "storage_unavailable", message: "hash failed", retryable: true } },
          "getState",
          "execute"
        )
      ).toMatchObject({ method: "getState", phase: "execute" });
      expect(
        workerFailureReply(
          {
            error: {
              code: "storage_unavailable",
              message: "open failed",
              retryable: true,
              phase: "open",
            },
          },
          "boot",
          "execute"
        )
      ).toMatchObject({ method: "boot", phase: "open" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("coalesces semantic phase events to a bounded request summary", async () => {
    vi.stubGlobal("self", { onmessage: undefined });
    try {
      const { aggregateSemanticPhase } = await import("@/index/sqlite/worker");
      const phases = new Map();
      const phase = {
        tier: "performance" as const,
        facets: ["index", "semantic", "worker"] as const,
        area: "index" as const,
        event: "phase" as const,
        operation: "semantic" as const,
        semanticStep: "commit" as const,
        phase: "transactionSetupResultInserts" as const,
        durationMs: 1,
        sqlMs: 0.5,
        sqlCalls: 1,
        callbackRows: 1,
        copiedBytes: 8,
        nested: true,
      };
      for (let i = 0; i < 128; i++) aggregateSemanticPhase(phases, phase);
      expect(phases.size).toBe(1);
      expect([...phases.values()][0]).toMatchObject({
        durationMs: 128,
        sqlCalls: 128,
        callbackRows: 128,
        copiedBytes: 1024,
        nested: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clears database references before a throwing close", () => {
    const state: {
      database?: { close(): void };
      connection?: object;
      opfsPool?: object;
    } = {};
    const pool = {};
    const close = vi.fn(() => {
      expect(state.database).toBeUndefined();
      expect(state.connection).toBeUndefined();
      throw new Error("close failed");
    });
    state.database = { close };
    state.connection = {};
    state.opfsPool = pool;

    expect(() => closeWorkerDatabase(state)).toThrow("close failed");
    expect(close).toHaveBeenCalledTimes(1);
    expect(state.database).toBeUndefined();
    expect(state.connection).toBeUndefined();
    expect(state.opfsPool).toBe(pool);
  });

  it("uses the official pool export surface and copies returned bytes", () => {
    const original = new Uint8Array([1, 2, 3]);
    const pool: OpfsSAHPoolUtilLike = {
      exportFile: vi.fn(() => original),
      importDb: vi.fn(() => original.byteLength),
      unlink: vi.fn(() => true),
    };

    const exported = exportOpfsDatabase(pool, "/index.sqlite3");
    expect(new Uint8Array(exported)).toEqual(original);
    expect(exported).not.toBe(original.buffer);
    expect(pool.exportFile).toHaveBeenCalledWith("/index.sqlite3");
    expect("releaseAccessHandles" in pool).toBe(false);
  });

  it("closes then unlinks only the index file in the same pool before installing fresh refs", () => {
    const order: string[] = [];
    const priorDatabase = { close: vi.fn(() => order.push("close")) };
    const priorConnection = {};
    const state: {
      database?: typeof priorDatabase;
      connection?: object;
      opfsPool?: { unlink: (name: string) => boolean };
    } = { database: priorDatabase, connection: priorConnection };
    const pool = {
      unlink: vi.fn((name: string) => {
        order.push(`unlink:${name}`);
        expect(state.database).toBeUndefined();
        expect(state.connection).toBeUndefined();
        return false;
      }),
    };
    state.opfsPool = pool;
    const connection = {};
    const database = { close: vi.fn() };
    const result = resetWorkerDatabase(state, pool, () => {
      order.push("open");
      return { connection, database };
    });

    expect(result).toBe(database);
    expect(order).toEqual(["close", "unlink:/index.sqlite3", "open"]);
    expect(pool.unlink).toHaveBeenCalledOnce();
    expect(state).toEqual({ database, connection, opfsPool: pool });
  });

  it.each(["close", "unlink", "open"] as const)(
    "leaves cleared refs and rejects a reset when %s fails",
    (failure) => {
      const priorDatabase = {
        close: vi.fn(() => {
          if (failure === "close") throw new Error("close failed");
        }),
      };
      const pool = {
        unlink: vi.fn(() => {
          if (failure === "unlink") throw new Error("unlink failed");
          return true;
        }),
      };
      const state: {
        database?: typeof priorDatabase;
        connection?: object;
        opfsPool?: typeof pool;
      } = { database: priorDatabase, connection: {}, opfsPool: pool };
      const open = vi.fn(() => {
        if (failure === "open") throw new Error("open failed");
        return { connection: {}, database: { close: vi.fn() } };
      });

      expect(() => resetWorkerDatabase(state, pool, open)).toThrow(`${failure} failed`);
      expect(state.database).toBeUndefined();
      expect(state.connection).toBeUndefined();
      expect(state.opfsPool).toBe(pool);
      expect(pool.unlink).toHaveBeenCalledTimes(failure === "close" ? 0 : 1);
      expect(open).toHaveBeenCalledTimes(failure === "close" || failure === "unlink" ? 0 : 1);
    }
  );
});
