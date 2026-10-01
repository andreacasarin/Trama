import { describe, expect, it, vi } from "vitest";
import {
  closeWorkerDatabase,
  exportOpfsDatabase,
  type OpfsSAHPoolUtilLike,
} from "@/index/sqlite/worker-lifecycle";

describe("SQLite Worker storage lifecycle", () => {
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
});
