import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/index/Identity";
import {
  PublicationManager,
  type PublicationIndexPort,
} from "@/index/publications/PublicationManager";
import { type PublicationDataAdapter } from "@/index/publications/PublicationStore";

function setup() {
  const files = new Map<string, Uint8Array>();
  const adapter: PublicationDataAdapter = {
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
      if (files.has(to)) throw new Error("destination exists");
      const bytes = files.get(from);
      if (!bytes) throw new Error("missing temp");
      files.set(to, bytes);
      files.delete(from);
    },
    remove: async (path) => {
      files.delete(path);
    },
    list: async (path) => ({
      files: [...files.keys()].filter((name) => name.startsWith(`${path}/`)),
      folders: [],
    }),
  };
  const data = new Uint8Array([9, 8, 7]).buffer;
  const digestPromise = sha256Hex(data);
  let exported = false;
  const ingested = new Set<string>();
  const index: PublicationIndexPort = {
    prepareCacheShard: vi.fn(async (after?: string) => {
      if (exported || after) return undefined;
      exported = true;
      return {
        bytes: data,
        digest: await digestPromise,
        nextActionKey: "key-1",
        rowCount: 1,
        profile: "a".repeat(64),
        actionKeys: ["key-1"],
        payloadBytes: 10,
      };
    }),
    ingestCacheShard: vi.fn(async (_bytes, digest) => {
      if (ingested.has(digest))
        return {
          imported: 0,
          duplicate: true,
          profile: "a".repeat(64),
          taskKind: "document" as const,
        };
      ingested.add(digest);
      return {
        imported: 1,
        duplicate: false,
        profile: "a".repeat(64),
        taskKind: "document" as const,
      };
    }),
  };
  return { files, adapter, index, data, digestPromise };
}

describe("PublicationManager cache shards", () => {
  it("leaves pending retirement sources and replacements alone during weekly compaction", async () => {
    const fixture = setup();
    const manager = new PublicationManager(fixture.index, fixture.adapter);
    const sources: string[] = [];
    for (let index = 0; index < 8; index++) {
      const bytes = new Uint8Array([index + 1]).buffer;
      const digest = await sha256Hex(bytes);
      sources.push(digest);
      await manager.store.installCacheShard(bytes, digest);
    }
    const replacement = await fixture.digestPromise;
    await manager.store.installCacheShard(fixture.data, replacement);
    const retirement = sources.map((sourceDigest) => ({
      sourceDigest,
      replacementSetId: "original",
      retireAfter: Date.now() + 30 * 24 * 60 * 60 * 1000,
      replacements: [replacement],
    }));
    fixture.index.maintainCache = vi.fn(async () => ({
      lastCompactionAt: 0,
      expiredSourceDigests: sources,
    }));
    fixture.index.listCacheRetirements = vi.fn(async () => retirement);
    fixture.index.completeCacheRetirement = vi.fn(async () => undefined);
    fixture.index.recordCacheRetirements = vi.fn(async () => undefined);
    vi.mocked(fixture.index.prepareCacheShard!).mockResolvedValue(undefined);
    await expect(manager.publish()).resolves.toMatchObject({ published: true });
    expect(fixture.index.recordCacheRetirements).not.toHaveBeenCalled();
    expect(fixture.index.ingestCacheShard).not.toHaveBeenCalled();
    expect(await manager.store.listCacheShards()).toHaveLength(9);
  });

  it("yields publication after the current shard is durable without exporting the next one", async () => {
    const fixture = setup();
    const manager = new PublicationManager(fixture.index, fixture.adapter);
    let interrupted = false;
    fixture.index.recordCacheShard = vi.fn(async () => {
      interrupted = true;
    });
    await expect(manager.publish(() => interrupted)).resolves.toEqual({ published: false });
    expect(await manager.store.listCacheShards()).toHaveLength(1);
    expect(fixture.index.recordCacheShard).toHaveBeenCalledOnce();
    expect(fixture.index.prepareCacheShard).toHaveBeenCalledOnce();
  });

  it("stages immutable SHA-named cache-only shards and leaves legacy snapshot untouched", async () => {
    const fixture = setup();
    const manager = new PublicationManager(fixture.index, fixture.adapter);
    fixture.files.set("Trama/index/index.sqlite3", new Uint8Array([1, 2]));
    await expect(manager.publish()).resolves.toMatchObject({ published: true });
    const digest = await fixture.digestPromise;
    expect(fixture.files.has(`Trama/index/cache-v1/cache-${digest}.sqlite3`)).toBe(true);
    expect([...fixture.files.get("Trama/index/index.sqlite3")!]).toEqual([1, 2]);
    expect([...fixture.files.keys()].some((path) => path.includes("trama-tmp"))).toBe(false);
  });

  it("ingests each listed shard additively and relies on receipt idempotence", async () => {
    const fixture = setup();
    const manager = new PublicationManager(fixture.index, fixture.adapter);
    await manager.publish();
    const first = await manager.adoptCurrent();
    const second = await manager.adoptCurrent();
    expect(first).toMatchObject({ adopted: true });
    expect(second).toMatchObject({ adopted: false, ignored: "same-id" });
    expect(fixture.index.ingestCacheShard).toHaveBeenCalledTimes(2);
  });

  it("yields between cache shards and resumes from receipts on the next check", async () => {
    const fixture = setup();
    const manager = new PublicationManager(fixture.index, fixture.adapter);
    await manager.publish();
    const extra = new Uint8Array([4, 5, 6]).buffer;
    const extraDigest = await sha256Hex(extra);
    fixture.files.set(`Trama/index/cache-v1/cache-${extraDigest}.sqlite3`, new Uint8Array(extra));
    let yieldRequested = false;
    const original = fixture.index.ingestCacheShard!;
    fixture.index.ingestCacheShard = vi.fn(async (bytes, digest) => {
      const result = await original(bytes, digest);
      yieldRequested = true;
      return result;
    });
    await expect(manager.adoptCurrent(() => yieldRequested)).resolves.toMatchObject({
      adopted: true,
    });
    expect(fixture.index.ingestCacheShard).toHaveBeenCalledTimes(1);
    await expect(manager.adoptCurrent()).resolves.toMatchObject({ adopted: true });
    expect(fixture.index.ingestCacheShard).toHaveBeenCalledTimes(3);
    await expect(manager.adoptCurrent()).resolves.toMatchObject({
      adopted: false,
      ignored: "same-id",
    });
  });

  it("reports staging errors without replacing the existing shard", async () => {
    const fixture = setup();
    const manager = new PublicationManager(fixture.index, fixture.adapter);
    const digest = await fixture.digestPromise;
    const destination = `Trama/index/cache-v1/cache-${digest}.sqlite3`;
    fixture.files.set(destination, new Uint8Array([1, 2, 3]));
    await expect(manager.publish()).resolves.toMatchObject({
      published: false,
      warning: { phase: "stage" },
    });
    expect([...fixture.files.get(destination)!]).toEqual([1, 2, 3]);
  });

  it("installs bounded compaction replacements before recording the captured retirement set", async () => {
    const fixture = setup();
    const manager = new PublicationManager(fixture.index, fixture.adapter);
    const ordered: string[] = [];
    fixture.index.maintainCache = vi.fn(async () => ({
      lastCompactionAt: 0,
      expiredSourceDigests: [],
      expiredRows: 0,
      unusedRows: 0,
    }));
    fixture.index.recordCacheShard = vi.fn(async () => {
      ordered.push("membership");
    });
    fixture.index.recordCacheRetirements = vi.fn(async (sources, replacements) => {
      expect(sources).toHaveLength(8);
      expect(replacements).toHaveLength(1);
      expect(
        fixture.files.has(`${manager.store.cacheDirectory}/cache-${replacements[0]}.sqlite3`)
      ).toBe(true);
      ordered.push("retirement");
    });
    for (let index = 0; index < 8; index++) {
      const bytes = new Uint8Array([index + 1]).buffer;
      await manager.store.installCacheShard(bytes, await sha256Hex(bytes));
    }
    await expect(manager.publish()).resolves.toMatchObject({ published: true });
    expect(fixture.index.maintainCache).toHaveBeenCalledWith(expect.any(Number));
    expect(ordered).toEqual(["membership", "retirement"]);
  });

  it("keeps every captured source when a later replacement batch fails and retries idempotently", async () => {
    const fixture = setup();
    const manager = new PublicationManager(fixture.index, fixture.adapter);
    fixture.index.maintainCache = vi.fn(async () => ({
      lastCompactionAt: 0,
      expiredSourceDigests: [],
      expiredRows: 0,
      unusedRows: 0,
    }));
    const recorded = vi.fn(async () => undefined);
    fixture.index.recordCacheRetirements = recorded;
    for (let index = 0; index < 8; index++) {
      const bytes = new Uint8Array([index + 1]).buffer;
      await manager.store.installCacheShard(bytes, await sha256Hex(bytes));
    }
    let failSecondBatch = true;
    vi.mocked(fixture.index.prepareCacheShard!).mockImplementation(
      async (cursor, _taskKind, _profile, sources) => {
        if (sources?.length) {
          if (cursor && failSecondBatch) throw new Error("replacement export interrupted");
          if (cursor) return undefined;
          return {
            bytes: fixture.data,
            digest: await fixture.digestPromise,
            nextActionKey: "replacement-cursor",
            rowCount: 1,
            profile: "a".repeat(64),
            actionKeys: ["replacement-key"],
            payloadBytes: 10,
          };
        }
        return undefined;
      }
    );
    const originalDigests = (await manager.store.listCacheShards()).map((file) => file.digest);
    await expect(manager.publish()).resolves.toMatchObject({ published: false });
    expect(recorded).not.toHaveBeenCalled();
    expect((await manager.store.listCacheShards()).map((file) => file.digest)).toEqual(
      expect.arrayContaining(originalDigests)
    );

    failSecondBatch = false;
    await expect(manager.publish()).resolves.toMatchObject({ published: true });
    expect(recorded).toHaveBeenCalledTimes(1);
    expect((await manager.store.listCacheShards()).map((file) => file.digest)).toEqual(
      expect.arrayContaining(originalDigests)
    );
  });

  it("does not retire a shard that arrives after the compaction inventory was captured", async () => {
    const fixture = setup();
    const manager = new PublicationManager(fixture.index, fixture.adapter);
    const fixedNow = 2_000_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    const arrival = new Uint8Array([99]).buffer;
    const arrivalDigest = await sha256Hex(arrival);
    const arrivalPath = `${manager.store.cacheDirectory}/cache-${arrivalDigest}.sqlite3`;
    let saved: import("@/index/sqlite/cache-shards").CacheRetirement[] = [];
    let injected = false;
    let lastCompactionAt = 0;
    fixture.index.maintainCache = vi.fn(async () => ({
      lastCompactionAt,
      expiredSourceDigests: [],
      expiredRows: 0,
      unusedRows: 0,
    }));
    const ingest = fixture.index.ingestCacheShard!;
    fixture.index.ingestCacheShard = vi.fn(async (bytes, digest) => {
      if (!injected) {
        injected = true;
        fixture.files.set(arrivalPath, new Uint8Array(arrival));
      }
      return ingest(bytes, digest);
    });
    fixture.index.recordCacheRetirements = vi.fn(
      async (sources: readonly string[], replacements: readonly string[], now: number) => {
        expect(sources).toHaveLength(8);
        expect(sources).not.toContain(arrivalDigest);
        lastCompactionAt = now;
        saved = sources.map((sourceDigest) => ({
          sourceDigest,
          replacementSetId: "captured-set",
          retireAfter: now + 30 * 24 * 60 * 60 * 1000,
          replacements,
        }));
      }
    );
    fixture.index.listCacheRetirements = vi.fn(async () => saved);
    fixture.index.completeCacheRetirement = vi.fn(async (digest) => {
      saved = saved.filter((item) => item.sourceDigest !== digest);
    });
    for (let index = 0; index < 8; index++) {
      const bytes = new Uint8Array([index + 1]).buffer;
      await manager.store.installCacheShard(bytes, await sha256Hex(bytes));
    }
    await expect(manager.publish()).resolves.toMatchObject({ published: true });
    expect(fixture.files.has(arrivalPath)).toBe(true);
    clock.mockReturnValue(fixedNow + 30 * 24 * 60 * 60 * 1000);
    await expect(manager.publish()).resolves.toMatchObject({ published: true });
    expect(fixture.files.has(arrivalPath)).toBe(true);
    clock.mockRestore();
  });

  it("does no work when the local cache has no new vectors", async () => {
    const fixture = setup();
    vi.mocked(fixture.index.prepareCacheShard!).mockResolvedValue(undefined);
    const manager = new PublicationManager(fixture.index, fixture.adapter);
    await expect(manager.publish()).resolves.toMatchObject({ published: true });
    expect(fixture.files.size).toBe(0);
  });
});
