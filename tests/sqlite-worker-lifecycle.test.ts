import { describe, expect, it, vi } from "vitest";
import { deriveNoteContentId } from "@/index/Identity";
import { SQLITE_PROTOCOL_VERSION } from "@/index/sqlite/protocol";
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
      const { storageFailureDetail, workerFailureLocation, workerFailureReply } =
        await import("@/index/sqlite/worker");
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
        const reply = workerFailureReply(electronError, "hashMarkdown", phase);
        expect(reply).toMatchObject({
          code: "internal",
          method: "hashMarkdown",
          phase,
          debugLocation: "openDatabase@sqlite-worker.mjs:17",
        });
        expect(JSON.stringify(reply)).not.toContain("/vault");
      }
      expect(
        workerFailureReply(
          { error: { code: "storage_unavailable", message: "hash failed", retryable: true } },
          "hashMarkdown",
          "execute"
        )
      ).toMatchObject({ method: "hashMarkdown", phase: "execute" });
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

  it("hashes through the production Worker handler before SQLite opens", async () => {
    vi.resetModules();
    const replies: any[] = [];
    const surface = {
      onmessage: undefined as ((event: MessageEvent) => void) | undefined,
      postMessage: (reply: unknown) => replies.push(reply),
    };
    const fetch = vi.fn(() => {
      throw new Error("SQLite must not open for hashing");
    });
    vi.stubGlobal("self", surface);
    vi.stubGlobal("fetch", fetch);
    try {
      await import("@/index/sqlite/worker");
      surface.onmessage?.({
        data: {
          v: SQLITE_PROTOCOL_VERSION,
          id: 1,
          method: "trama-runtime-handshake",
          type: "trama-runtime-handshake",
        },
      } as MessageEvent);
      surface.onmessage?.({
        data: {
          v: SQLITE_PROTOCOL_VERSION,
          id: 2,
          method: "hashMarkdown",
          payload: { markdown: "alpha", corpusFingerprint: "a".repeat(64) },
        },
      } as MessageEvent);
      await vi.waitFor(() => expect(replies).toHaveLength(2));
      expect(replies[0]).toMatchObject({ type: "trama-runtime-handshake" });
      expect(replies[1]).toMatchObject({
        id: 2,
        ok: true,
        result: await deriveNoteContentId("a".repeat(64), "alpha"),
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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
