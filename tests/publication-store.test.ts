import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/index/Identity";
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
    stat: async (path) => (files.has(path) ? { size: files.get(path)!.byteLength } : null),
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
    list: async (path) => ({
      files: [...files.keys()].filter((name) => name.startsWith(`${path}/`)),
      folders: [],
    }),
  };
  return value;
}

describe("PublicationStore", () => {
  it("normalizes a captured vault-relative directory and fixes the target filename", () => {
    expect(normalizePublicationDirectory(" ./Trama\\index// ")).toBe("Trama/index");
    expect(normalizePublicationDirectory("/absolute")).toBe("Trama/index");
    const store = new PublicationStore(adapter(), { directory: " ./sync\\folder/" });
    expect(store.directory).toBe("sync/folder");
  });

  it("installs immutable digest-named shards after readback hashing and lists only final artifacts", async () => {
    const storage = adapter();
    const store = new PublicationStore(storage, {
      directory: "Trama/index",
      temporaryToken: () => "fixed",
    });
    const bytes = new TextEncoder().encode("shard").buffer;
    const digest = await sha256Hex(bytes);
    await expect(store.installCacheShard(bytes, digest)).resolves.toBe(true);
    await expect(store.installCacheShard(bytes, digest)).resolves.toBe(false);
    expect(await store.listCacheShards()).toEqual([
      { path: `Trama/index/cache-v1/cache-${digest}.sqlite3`, digest },
    ]);
    storage.files.set(
      `${store.cacheDirectory}/cache-${"0".repeat(64)}.sqlite3.trama-tmp-x`,
      new Uint8Array([1])
    );
    storage.files.set(`${store.cacheDirectory}/unrecognized.sqlite3`, new Uint8Array([1]));
    expect(await store.listCacheShards()).toHaveLength(1);
    expect([...storage.files.get(`Trama/index/cache-v1/cache-${digest}.sqlite3`)!]).toEqual([
      ...new Uint8Array(bytes),
    ]);
  });

  it.each([4_194_305, 0, -1, NaN])(
    "rejects invalid shard metadata (%s) before reading bytes",
    async (size) => {
      const storage = adapter();
      storage.stat = async () => ({ size });
      const read = vi.spyOn(storage, "readBinary");
      const store = new PublicationStore(storage);
      await expect(
        store.readCacheShard(`${store.cacheDirectory}/cache-${"a".repeat(64)}.sqlite3`)
      ).rejects.toThrow("Cache shard size is invalid");
      expect(read).not.toHaveBeenCalled();
    }
  );

  it("checks bytes again when a shard grows after the metadata check", async () => {
    const storage = adapter();
    storage.stat = async () => ({ size: 1 });
    storage.readBinary = vi.fn(async () => new ArrayBuffer(4_194_305));
    const store = new PublicationStore(storage);
    await expect(
      store.readCacheShard(`${store.cacheDirectory}/cache-${"a".repeat(64)}.sqlite3`)
    ).rejects.toThrow("Cache shard size is invalid");
    expect(storage.readBinary).toHaveBeenCalledOnce();
  });

  it("treats a missing cache directory as empty without listing it", async () => {
    const storage = adapter();
    storage.exists = vi.fn(async (path) => path !== "Trama/index/cache-v1");
    const list = vi.fn(storage.list);
    storage.list = list;
    const store = new PublicationStore(storage);

    await expect(store.listCacheShards()).resolves.toEqual([]);
    await expect(store.clearCacheShards()).resolves.toBeUndefined();
    expect(storage.exists).toHaveBeenCalledWith("Trama/index/cache-v1");
    expect(list).not.toHaveBeenCalled();
  });

  it("propagates cache listing errors when the directory exists", async () => {
    const storage = adapter();
    storage.exists = async () => true;
    storage.list = async () => {
      throw new Error("listing failed");
    };
    const store = new PublicationStore(storage);

    await expect(store.clearCacheShards()).rejects.toThrow("listing failed");
  });
});
