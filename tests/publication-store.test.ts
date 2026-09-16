import { describe, expect, it } from "vitest";
import {
  PublicationStore,
  normalizePublicationDirectory,
  type PublicationDataAdapter,
} from "@/index/publications/PublicationStore";

function adapter() {
  const files = new Map<string, Uint8Array>();
  const renamed: string[][] = [];
  const value: PublicationDataAdapter & { files: typeof files; renamed: typeof renamed } = {
    files,
    renamed,
    readBinary: async (path) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error("missing");
      return bytes.slice().buffer;
    },
    writeBinary: async (path, bytes) => {
      files.set(path, new Uint8Array(bytes.slice(0)));
    },
    mkdir: async () => undefined,
    rename: async (from, to) => {
      const bytes = files.get(from);
      if (!bytes) throw new Error("missing temp");
      files.set(to, bytes);
      files.delete(from);
      renamed.push([from, to]);
    },
    remove: async (path) => {
      files.delete(path);
    },
  };
  return value;
}

describe("PublicationStore", () => {
  it("normalizes a captured vault-relative directory and fixes the target filename", () => {
    expect(normalizePublicationDirectory(" ./Trama\\index// ")).toBe("Trama/index");
    expect(normalizePublicationDirectory("/absolute")).toBe("Trama/index");
    const store = new PublicationStore(adapter(), { directory: " ./sync\\folder/" });
    expect(store.directory).toBe("sync/folder");
    expect(store.path).toBe("sync/folder/index.sqlite3");
    expect(store.temporaryPath("x/y")).toBe("sync/folder/index.sqlite3.trama-tmp-x_y");
  });

  it("stages, reads back, and atomically installs through the adapter", async () => {
    const storage = adapter();
    const store = new PublicationStore(storage, {
      directory: "Trama/index",
      temporaryToken: () => "fixed",
    });
    const result = await store.install(new Uint8Array([1, 2, 3]).buffer);
    expect(result.byteSize).toBe(3);
    expect(storage.files.has("Trama/index/index.sqlite3")).toBe(true);
    expect(storage.files.has("Trama/index/index.sqlite3.trama-tmp-fixed")).toBe(false);
    expect(storage.renamed).toEqual([
      ["Trama/index/index.sqlite3.trama-tmp-fixed", "Trama/index/index.sqlite3"],
    ]);
  });

  it("does not replace the target when adapter readback is corrupted", async () => {
    const storage = adapter();
    const original = storage.readBinary;
    storage.readBinary = async (path) => {
      const bytes = await original(path);
      if (path.includes("trama-tmp")) new Uint8Array(bytes)[0] ^= 1;
      return bytes;
    };
    const store = new PublicationStore(storage, { directory: "Trama/index" });
    await expect(store.install(new Uint8Array([1]).buffer)).rejects.toMatchObject({
      code: "internal",
    });
    expect(storage.files.has(store.path)).toBe(false);
  });

  it("requires atomic rename and preserves the old target when it is unavailable", async () => {
    const storage = adapter();
    const store = new PublicationStore(storage, { directory: "Trama/index" });
    storage.files.set(store.path, new Uint8Array([7, 7]));
    storage.rename = undefined;

    await expect(store.install(new Uint8Array([1, 2, 3]).buffer)).rejects.toMatchObject({
      code: "internal",
      retryable: true,
    });
    expect([...storage.files.get(store.path)!]).toEqual([7, 7]);
  });

  it("promotes over an existing target without rename-overwrite support", async () => {
    const storage = adapter();
    const rename = storage.rename!;
    storage.rename = async (from, to) => {
      if (storage.files.has(to)) throw new Error("destination exists");
      return rename(from, to);
    };
    const store = new PublicationStore(storage, { directory: "Trama/index" });
    storage.files.set(store.path, new Uint8Array([7, 7]));
    await store.install(new Uint8Array([1, 2, 3]).buffer, "next");
    expect([...storage.files.get(store.path)!]).toEqual([1, 2, 3]);
    expect(storage.files.has(store.backupPath)).toBe(false);
  });

  it("restores the old target after promotion failure and recovers an interrupted backup", async () => {
    const storage = adapter();
    const rename = storage.rename!;
    storage.rename = async (from, to) => {
      if (from.includes("trama-tmp") && to === "Trama/index/index.sqlite3")
        throw new Error("promote failed");
      return rename(from, to);
    };
    const store = new PublicationStore(storage, { directory: "Trama/index" });
    storage.files.set(store.path, new Uint8Array([7, 7]));
    await expect(store.install(new Uint8Array([1, 2, 3]).buffer, "bad")).rejects.toThrow(
      "promote failed"
    );
    expect([...storage.files.get(store.path)!]).toEqual([7, 7]);
    expect(storage.files.has(store.backupPath)).toBe(false);

    storage.files.set(store.backupPath, new Uint8Array([4, 5]));
    storage.files.delete(store.path);
    expect([...new Uint8Array((await store.read()) as ArrayBuffer)]).toEqual([4, 5]);
    expect(storage.files.has(store.backupPath)).toBe(false);
  });
});
