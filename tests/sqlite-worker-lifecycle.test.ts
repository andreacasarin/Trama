import { describe, expect, it, vi } from "vitest";
import {
  closeWorkerDatabase,
  exportOpfsDatabase,
  type OpfsSAHPoolUtilLike,
} from "@/index/sqlite/worker-lifecycle";

describe("SQLite Worker storage lifecycle", () => {
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
