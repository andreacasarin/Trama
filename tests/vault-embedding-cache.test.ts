import { describe, expect, it, vi } from "vitest";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { sha256 } from "@langchain/core/utils/hash";
import { ManualIndex, type ManualIndexNote, type ManualIndexVault } from "@/index/ManualIndex";
import { embeddingCacheIdentity, SqliteEmbeddingCache } from "@/index/SqliteEmbeddingCache";
import { SqliteNoteRecordManager } from "@/index/SqliteNoteRecordManager";
import { SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { NoteStoreClient } from "@/index/note-sqlite/client";
import type { SqliteConnection } from "@/index/note-sqlite/protocol";
import { EMBEDDING_ARTIFACT_MAX_FILE_BYTES } from "@/index/note-sqlite/protocol";
import { VaultEmbeddingCache } from "@/plugin/VaultEmbeddingCache";
import { ConsoleDebug } from "@/plugin/ConsoleDebug";
import { loadTestSqlite, TestNoteWorker as LocalWorker } from "./note-sqlite-test-client";

const profile = {
  endpoint: "http://127.0.0.1:1234/v1",
  modelId: "shared-test",
  dimensions: 2,
};
const profileHash = sha256(embeddingCacheIdentity(profile.modelId, profile.dimensions));
const markdown = "# shared note\n\nA unique reusable vector body.";

class TestEmbeddings implements EmbeddingsInterface<number[]> {
  constructor(private readonly dimensions = 2) {}

  calls: string[][] = [];
  fail = false;
  waitUntilAbort = false;
  started?: () => void;

  async embedDocuments(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    this.calls.push([...inputs]);
    if (this.fail) throw new Error("provider unavailable");
    if (this.waitUntilAbort) {
      this.started?.();
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) reject(new DOMException("Cancelled", "AbortError"));
        else
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true }
          );
      });
    }
    return inputs.map(() =>
      Array.from({ length: this.dimensions }, (_, index) => [0.6, 0.8][index] ?? 0)
    );
  }

  async embedQuery(): Promise<number[]> {
    return [0.6, 0.8];
  }

  withSignal(signal?: AbortSignal): EmbeddingsInterface<number[]> {
    return {
      embedDocuments: (inputs) => this.embedDocuments(inputs, signal),
      embedQuery: () => this.embedQuery(),
    };
  }
}

class MemoryVault implements ManualIndexVault {
  constructor(private readonly notes: Map<string, string>) {}
  async listMarkdownPaths(): Promise<string[]> {
    return [...this.notes.keys()].sort();
  }
  async readMarkdown(path: string): Promise<ManualIndexNote> {
    const content = this.notes.get(path);
    if (content === undefined) throw new Error(`Missing ${path}`);
    return { path, content };
  }
}

class MemoryAdapter {
  readonly files = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();
  readonly reads = new Map<string, number>();
  oversizedMetadata = false;
  renameCalls = 0;
  failRenameCall?: number;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()].filter((file) => file.startsWith(prefix)),
      folders: [...this.folders].filter((folder) => folder.startsWith(prefix)),
    };
  }
  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }
  async stat(path: string) {
    if (this.folders.has(path)) return { type: "folder" as const, ctime: 0, mtime: 0, size: 0 };
    const bytes = this.files.get(path);
    return bytes
      ? {
          type: "file" as const,
          ctime: 0,
          mtime: 0,
          size: this.oversizedMetadata ? EMBEDDING_ARTIFACT_MAX_FILE_BYTES : bytes.byteLength,
        }
      : null;
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
    const bytes = this.files.get(path);
    if (!bytes) throw new Error("Missing file");
    return bytes.slice().buffer;
  }
  async writeBinary(path: string, buffer: ArrayBuffer): Promise<void> {
    this.files.set(path, new Uint8Array(buffer.slice(0)));
  }
  async rename(from: string, to: string): Promise<void> {
    this.renameCalls++;
    if (this.renameCalls === this.failRenameCall) throw new Error("sharing write failed");
    const bytes = this.files.get(from);
    if (!bytes) throw new Error("Missing temporary file");
    this.files.delete(from);
    this.files.set(to, bytes);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

function queryRows(
  db: SqliteConnection,
  sql: string,
  bind: readonly unknown[] = []
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  db.exec({ sql, bind, rowMode: "object", callback: (row) => result.push(row) });
  return result;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer)
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const shardFixtures = new Map<
  string,
  {
    readonly profile: string;
    readonly dimensions: number;
    readonly entries: readonly { hash: string; vector: Uint8Array }[];
  }
>();

function testShardCache(
  cache: SqliteEmbeddingCache,
  database: NoteSqliteDatabase,
  db: SqliteConnection,
  dimensions: number
) {
  const profileFingerprint = cache.profileFingerprint;
  return {
    profileFingerprint,
    unimportedSqliteShards: cache.unimportedSqliteShards.bind(cache),
    reconcileDocumentShards: cache.reconcileDocumentShards.bind(cache),
    async exportNextDocumentShard(limit: number) {
      const hashes = (await database.call("embeddingCacheKeys", {
        profile: profileFingerprint,
        task: "document",
        limit: 512,
      })) as string[];
      const published = new Set(
        queryRows(db, "SELECT hash FROM embedding_cache_sqlite_publications WHERE profile=?", [
          profileFingerprint,
        ]).map((row) => String(row.hash))
      );
      const selected = hashes.filter((hash) => !published.has(hash)).slice(0, limit);
      if (!selected.length) return undefined;
      const vectors = (await database.call("embeddingCacheGet", {
        profile: profileFingerprint,
        task: "document",
        hashes: selected,
        now: Date.now(),
      })) as (Uint8Array | undefined)[];
      const entries = selected.map((hash, index) => ({ hash, vector: vectors[index]! }));
      const bytes = new TextEncoder().encode(
        `SQLite format 3\0test-fixture\n${selected.join("\n")}`
      );
      const checksum = await sha256Bytes(bytes);
      shardFixtures.set(checksum, { profile: profileFingerprint, dimensions, entries });
      return { bytes, hashes: selected };
    },
    async importDocumentShard(checksum: string, bytes: Uint8Array) {
      const fixture = shardFixtures.get(checksum);
      if (!fixture || (await sha256Bytes(bytes)) !== checksum)
        throw new TypeError("Invalid test shard fixture");
      const cached = (await database.call("embeddingCacheGet", {
        profile: fixture.profile,
        task: "document",
        hashes: fixture.entries.map(({ hash }) => hash),
        now: Date.now(),
      })) as (Uint8Array | undefined)[];
      const missing = fixture.entries.filter((_, index) => !cached[index]);
      if (missing.length)
        await database.call("embeddingCacheSet", {
          profile: fixture.profile,
          task: "document",
          dimensions: fixture.dimensions,
          entries: missing,
          now: Date.now(),
        });
      await database.call("embeddingCacheSqliteMarkPublished", {
        profile: fixture.profile,
        checksum,
        hashes: fixture.entries.map(({ hash }) => hash),
        now: Date.now(),
      });
      return { imported: missing.length, alreadyImported: false };
    },
    markDocumentShardPublished: cache.markDocumentShardPublished.bind(cache),
  };
}

async function setup(
  adapter: MemoryAdapter,
  notes: Map<string, string>,
  provider: TestEmbeddings,
  embeddingProfile = profile,
  consoleDebug?: ConsoleDebug,
  storageFolder = ".trama",
  deviceNamespace = "b".repeat(64)
) {
  const sqlite = await loadTestSqlite();
  const db = new sqlite.oo1.DB(":memory:", "c");
  const database = new NoteSqliteDatabase(db);
  const client = new NoteStoreClient(new LocalWorker(database), deviceNamespace);
  const cachedEmbeddings = new SqliteEmbeddingCache(
    provider,
    client.call,
    embeddingCacheIdentity(embeddingProfile.modelId, embeddingProfile.dimensions),
    embeddingProfile.dimensions
  );
  const store = new SqliteNoteVectorStore(
    cachedEmbeddings,
    client.call,
    async (path) => notes.get(path) ?? null,
    embeddingProfile
  );
  const shared = new VaultEmbeddingCache(
    adapter,
    testShardCache(cachedEmbeddings, database, db, embeddingProfile.dimensions),
    embeddingProfile.dimensions,
    consoleDebug,
    storageFolder
  );
  const manual = new ManualIndex(
    new MemoryVault(notes),
    store,
    new SqliteNoteRecordManager(client.call),
    shared,
    consoleDebug
  );
  return { db, client, database, manual, shared, cachedEmbeddings };
}

describe("vault-shared document embedding artifacts", () => {
  it.each(["mkdir", "list"] as const)(
    "indexes and rebuilds locally when shared-cache %s fails, then retries sharing",
    async (operation) => {
      const adapter = new MemoryAdapter();
      const provider = new TestEmbeddings();
      const f = await setup(adapter, new Map([["a.md", markdown]]), provider);
      const failure = vi
        .spyOn(adapter, operation)
        .mockRejectedValue(new Error("Shared cache unavailable"));
      try {
        for (const run of [() => f.manual.update(), () => f.manual.rebuild()]) {
          expect(await run()).toMatchObject({ visited: 1, numAdded: 1, sharing: "incomplete" });
          expect(f.db.selectValue("SELECT count(*) FROM note_index")).toBe(1);
        }
        expect(provider.calls).toHaveLength(1);
        failure.mockRestore();
        expect((await f.manual.update()).sharing).toBe("complete");
        expect([...adapter.files.keys()].some((path) => path.endsWith(".sqlite3"))).toBe(true);
        expect(provider.calls).toHaveLength(1);
      } finally {
        await f.client.close();
        f.db.close();
      }
    }
  );

  it.each(["mkdir", "list"] as const)(
    "propagates cancellation from shared-cache %s",
    async (operation) => {
      const adapter = new MemoryAdapter();
      const provider = new TestEmbeddings();
      const f = await setup(adapter, new Map([["a.md", markdown]]), provider);
      adapter[operation] = async () => {
        throw new DOMException("Cancelled", "AbortError");
      };
      try {
        await expect(f.manual.update()).rejects.toMatchObject({ name: "AbortError" });
        expect(provider.calls).toHaveLength(0);
        expect(f.db.selectValue("SELECT count(*) FROM note_index")).toBe(0);
      } finally {
        await f.client.close();
        f.db.close();
      }
    }
  );

  it("stops indexing when an aborted directory read rejects with an ordinary I/O error", async () => {
    const adapter = new MemoryAdapter();
    const provider = new TestEmbeddings();
    const f = await setup(adapter, new Map([["a.md", markdown]]), provider);
    let started!: () => void;
    let fail!: (error: Error) => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    adapter.list = async () => {
      started();
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    };
    try {
      const pending = f.manual.update();
      await reading;
      f.manual.cancel();
      fail(new Error("Directory read interrupted"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(provider.calls).toHaveLength(0);
      expect(f.db.selectValue("SELECT count(*) FROM note_index")).toBe(0);
      expect(adapter.files.size).toBe(0);
    } finally {
      await f.client.close();
      f.db.close();
    }
  });

  it("republishes an accidentally deleted shard without another provider call", async () => {
    const adapter = new MemoryAdapter();
    const provider = new TestEmbeddings();
    const { manual, shared, client, db } = await setup(
      adapter,
      new Map([["a.md", markdown]]),
      provider
    );
    try {
      await manual.update();
      const shard = [...adapter.files.keys()].find((path) => path.endsWith(".sqlite3"))!;
      expect(shard).toBeDefined();
      const calls = provider.calls.length;
      adapter.files.delete(shard);
      const exec = vi.spyOn(db, "exec");
      await shared.importAvailable(new AbortController().signal);
      const reconcile = exec.mock.calls
        .map(([statement]) => statement as any)
        .find((statement) =>
          statement.sql?.includes("DELETE FROM embedding_cache_sqlite_publications")
        );
      expect(reconcile.sql).toContain("json_each");
      expect(reconcile.sql).not.toContain("SELECT vector");
      const plan = queryRows(db, `EXPLAIN QUERY PLAN ${reconcile.sql}`, reconcile.bind);
      expect(plan.map((row) => row.detail).join("\n")).toContain(
        "embedding_cache_sqlite_publication_shards (profile=? AND checksum=?)"
      );
      await shared.publishAvailable(new AbortController().signal);
      expect(adapter.files.has(shard)).toBe(true);
      expect(provider.calls).toHaveLength(calls);
    } finally {
      await client.close();
    }
  });

  it("does not restore intentionally cleared shards from another device's local cache", async () => {
    const adapter = new MemoryAdapter();
    const notes = new Map([["a.md", markdown]]);
    const first = await setup(adapter, notes, new TestEmbeddings());
    const second = await setup(adapter, notes, new TestEmbeddings());
    try {
      await first.manual.update();
      await second.manual.update();
      const shard = [...adapter.files.keys()].find((path) => path.endsWith(".sqlite3"))!;
      await first.database.call("noteStoreClear", {});
      await VaultEmbeddingCache.clearManagedFiles(adapter, new AbortController().signal);
      expect(adapter.files.has(shard.replace(/\.sqlite3$/, ".cleared"))).toBe(true);
      await second.manual.update();
      expect([...adapter.files.keys()].some((path) => path.endsWith(".sqlite3"))).toBe(false);
      // An explicit rebuild after Clear can generate and publish the vectors again.
      await first.manual.update();
      expect([...adapter.files.keys()].some((path) => path.endsWith(".sqlite3"))).toBe(true);
    } finally {
      await first.client.close();
      await second.client.close();
    }
  });

  it("skips a shard lost between stat and read, indexes locally, and retries import later", async () => {
    const adapter = new MemoryAdapter();
    const notes = new Map([["a.md", markdown]]);
    const first = await setup(adapter, notes, new TestEmbeddings());
    const provider = new TestEmbeddings();
    const second = await setup(adapter, notes, provider);
    try {
      await first.manual.update();
      const read = adapter.readBinary.bind(adapter);
      let fail = true;
      adapter.readBinary = async (path) => {
        if (fail && path.endsWith(".sqlite3")) throw new Error("File disappeared during sync");
        return read(path);
      };
      expect((await second.manual.update()).sharing).toBe("incomplete");
      expect(
        queryRows(second.db, "SELECT count(*) AS count FROM embedding_cache_sqlite_imports")[0]
          .count
      ).toBe(0);
      fail = false;
      expect(provider.calls).toHaveLength(1);
      expect(queryRows(second.db, "SELECT count(*) AS count FROM note_index")[0].count).toBe(1);
      await second.shared.importAvailable(new AbortController().signal);
      expect(
        queryRows(second.db, "SELECT count(*) AS count FROM embedding_cache_sqlite_imports")[0]
          .count
      ).toBeGreaterThan(0);
    } finally {
      await first.client.close();
      await second.client.close();
    }
  });

  it("propagates cancellation from an individual shard read", async () => {
    const adapter = new MemoryAdapter();
    const first = await setup(adapter, new Map([["a.md", markdown]]), new TestEmbeddings());
    const second = await setup(adapter, new Map(), new TestEmbeddings());
    try {
      await first.manual.update();
      adapter.readBinary = async () => {
        throw new DOMException("Cancelled", "AbortError");
      };
      await expect(
        second.shared.importAvailable(new AbortController().signal)
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await first.client.close();
      await second.client.close();
    }
  });

  it("clears SQLite index and cache atomically while ordinary reset retains reusable cache", async () => {
    const adapter = new MemoryAdapter();
    const notes = new Map([["clear.md", markdown]]);
    const provider = new TestEmbeddings();
    const { db, client, database, manual, cachedEmbeddings } = await setup(
      adapter,
      notes,
      provider
    );
    const cacheHash = "a".repeat(64);
    const checksum = "b".repeat(64);
    const profileFingerprint = cachedEmbeddings.profileFingerprint;
    const vector = new Uint8Array(new Float32Array([0.6, 0.8]).buffer);
    try {
      await manual.update();
      await client.call("embeddingCacheSet", {
        profile: profileFingerprint,
        task: "query",
        dimensions: 2,
        entries: [{ hash: cacheHash, vector }],
        now: Date.now(),
      });
      db.exec({
        sql: "INSERT INTO embedding_cache_sqlite_imports(profile,checksum,imported_at) VALUES(?,?,?)",
        bind: [profileFingerprint, checksum, Date.now()],
      });
      db.exec({
        sql: "INSERT INTO embedding_cache_sqlite_publications(profile,hash,checksum,published_at) VALUES(?,?,?,?)",
        bind: [profileFingerprint, cacheHash, checksum, Date.now()],
      });
      const callsBeforeReset = provider.calls.length;
      const importsBeforeReset = Number(
        db.selectValue("SELECT count(*) FROM embedding_cache_sqlite_imports")
      );
      const publicationsBeforeReset = Number(
        db.selectValue("SELECT count(*) FROM embedding_cache_sqlite_publications")
      );

      await client.call("noteStoreReset", {});
      expect(Number(db.selectValue("SELECT count(*) FROM note_index"))).toBe(0);
      expect(Number(db.selectValue("SELECT count(*) FROM embedding_cache"))).toBeGreaterThan(0);
      expect(Number(db.selectValue("SELECT count(*) FROM embedding_cache_sqlite_imports"))).toBe(
        importsBeforeReset
      );
      expect(
        Number(db.selectValue("SELECT count(*) FROM embedding_cache_sqlite_publications"))
      ).toBe(publicationsBeforeReset);
      await manual.update();
      expect(provider.calls.length).toBe(callsBeforeReset);
      const importsBeforeClear = Number(
        db.selectValue("SELECT count(*) FROM embedding_cache_sqlite_imports")
      );
      const publicationsBeforeClear = Number(
        db.selectValue("SELECT count(*) FROM embedding_cache_sqlite_publications")
      );

      const abort = new AbortController();
      const clearing = database.call("noteStoreClear", {}, abort.signal);
      abort.abort();
      await expect(clearing).rejects.toMatchObject({ name: "AbortError" });
      expect(Number(db.selectValue("SELECT count(*) FROM note_index"))).toBeGreaterThan(0);
      expect(Number(db.selectValue("SELECT count(*) FROM embedding_cache"))).toBeGreaterThan(0);
      expect(Number(db.selectValue("SELECT count(*) FROM embedding_cache_sqlite_imports"))).toBe(
        importsBeforeClear
      );
      expect(
        Number(db.selectValue("SELECT count(*) FROM embedding_cache_sqlite_publications"))
      ).toBe(publicationsBeforeClear);

      await client.call("noteStoreClear", {});
      expect(Number(db.selectValue("SELECT count(*) FROM note_index"))).toBe(0);
      expect(Number(db.selectValue("SELECT count(*) FROM note_vectors"))).toBe(0);
      expect(Number(db.selectValue("SELECT count(*) FROM note_records"))).toBe(0);
      expect(Number(db.selectValue("SELECT value FROM note_record_clock WHERE id=1"))).toBe(0);
      expect(Number(db.selectValue("SELECT count(*) FROM embedding_cache"))).toBe(0);
      expect(Number(db.selectValue("SELECT count(*) FROM embedding_cache_sqlite_imports"))).toBe(0);
      expect(
        Number(db.selectValue("SELECT count(*) FROM embedding_cache_sqlite_publications"))
      ).toBe(0);
    } finally {
      await client.close();
      db.close();
    }
  });

  it("clears only managed shared cache files across direct profile folders", async () => {
    const adapter = new MemoryAdapter();
    const otherProfile = "c".repeat(64);
    const checksum = "d".repeat(64);
    const temp = ".tmp-" + checksum + "-123e4567-e89b-42d3-a456-426614174000";
    const root = ".trama/embeddings";
    const paths = [
      root + "/" + profileHash + "/" + checksum + ".sqlite3",
      root + "/" + profileHash + "/" + temp,
      root + "/" + otherProfile + "/" + "e".repeat(64) + ".sqlite3",
      root + "/unrelated.bin",
      root + "/" + "f".repeat(63) + "/" + "a".repeat(64) + ".sqlite3",
      root + "/" + profileHash + "/unknown.txt",
      root + "/" + profileHash + "/nested/" + "b".repeat(64) + ".sqlite3",
    ];
    for (const path of paths) {
      const parent = path.slice(0, path.lastIndexOf("/"));
      adapter.folders.add(parent);
      adapter.files.set(path, new Uint8Array([1]));
    }
    adapter.folders.add(root);

    const removed = await VaultEmbeddingCache.clearManagedFiles(
      adapter as any,
      new AbortController().signal
    );
    expect(removed).toBe(3);
    expect([...adapter.files.keys()]).toEqual(expect.arrayContaining(paths.slice(3)));
    expect([...adapter.files.keys()]).not.toEqual(expect.arrayContaining(paths.slice(0, 3)));
  });

  it("clears managed files only under the selected custom storage folder", async () => {
    const adapter = new MemoryAdapter();
    const root = "Sync/Trama/embeddings";
    const selected = `${root}/${profileHash}/${"a".repeat(64)}.sqlite3`;
    const other = `.trama/embeddings/${profileHash}/${"b".repeat(64)}.sqlite3`;
    for (const path of [selected, other]) {
      adapter.folders.add(path.slice(0, path.lastIndexOf("/")));
      adapter.files.set(path, new Uint8Array([1]));
    }
    adapter.folders.add(root);
    expect(
      await VaultEmbeddingCache.clearManagedFiles(
        adapter as any,
        new AbortController().signal,
        "Sync/Trama"
      )
    ).toBe(1);
    expect(adapter.files.has(selected)).toBe(false);
    expect(adapter.files.has(other)).toBe(true);
  });

  it("cancels shared-file cleanup after a deletion and safely retries remaining files", async () => {
    const adapter = new MemoryAdapter();
    const root = ".trama/embeddings";
    const folder = root + "/" + profileHash;
    const files = ["a", "b"].map((letter) => folder + "/" + letter.repeat(64) + ".sqlite3");
    adapter.folders.add(root);
    adapter.folders.add(folder);
    for (const path of files) adapter.files.set(path, new Uint8Array([1]));
    const controller = new AbortController();
    const remove = adapter.remove.bind(adapter);
    adapter.remove = async (path) => {
      await remove(path);
      controller.abort();
    };

    await expect(
      VaultEmbeddingCache.clearManagedFiles(adapter as any, controller.signal)
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect([...adapter.files.keys()].filter((path) => path.endsWith(".sqlite3"))).toHaveLength(1);
    adapter.remove = remove;
    expect(
      await VaultEmbeddingCache.clearManagedFiles(adapter as any, new AbortController().signal)
    ).toBe(1);
    expect([...adapter.files.keys()].filter((path) => path.endsWith(".sqlite3"))).toHaveLength(0);
  });

  it("imports compatible vectors across endpoint changes into an independent index", async () => {
    const adapter = new MemoryAdapter();
    const notes = new Map([["folder/shared.md", markdown]]);
    const firstProvider = new TestEmbeddings();
    const first = await setup(adapter, notes, firstProvider);
    const secondProvider = new TestEmbeddings();
    const second = await setup(adapter, notes, secondProvider, {
      ...profile,
      endpoint: "http://127.0.0.1:4321/v1",
    });
    try {
      expect((await first.manual.update()).numAdded).toBe(1);
      expect(firstProvider.calls.flat()).not.toHaveLength(0);
      const paths = [...adapter.files.keys()];
      expect(paths).toHaveLength(1);
      expect(paths[0]).toMatch(
        new RegExp(`^.trama/embeddings/${profileHash}/[0-9a-f]{64}\\.sqlite3$`)
      );
      const artifact = adapter.files.get(paths[0])!;
      expect(new TextDecoder().decode(artifact.slice(0, 15))).toBe("SQLite format 3");
      expect(new TextDecoder().decode(artifact)).not.toContain(markdown);
      expect(new TextDecoder().decode(artifact)).not.toContain("127.0.0.1");
      expect(new TextDecoder().decode(artifact)).not.toContain("shared-test");
      expect(artifact.byteLength).toBeLessThan(EMBEDDING_ARTIFACT_MAX_FILE_BYTES);

      const firstProviderCalls = firstProvider.calls.length;
      const readsAfterPublish = new Map(adapter.reads);
      expect((await first.manual.update()).numSkipped).toBe(1);
      expect(adapter.reads).toEqual(readsAfterPublish);
      expect((await first.manual.rebuild()).numAdded).toBe(1);
      expect(firstProvider.calls).toHaveLength(firstProviderCalls);

      expect((await second.manual.update()).numAdded).toBe(1);
      expect(secondProvider.calls).toEqual([]);
      expect(Number(second.db.selectValue("SELECT count(*) FROM note_index"))).toBe(1);
      expect(Number(second.db.selectValue("SELECT count(*) FROM note_vectors"))).toBeGreaterThan(0);
      expect(Number(second.db.selectValue("SELECT count(*) FROM note_records"))).toBe(1);
      expect(
        Number(
          second.db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'reusable'")
        )
      ).toBe(1);

      const readsAfterImport = new Map(adapter.reads);
      expect((await second.manual.update()).numSkipped).toBe(1);
      expect(adapter.reads).toEqual(readsAfterImport);
    } finally {
      await first.client.close();
      await second.client.close();
      first.db.close();
      second.db.close();
    }
  });

  it("publishes and reuses custom-folder shards across independent device identities", async () => {
    const adapter = new MemoryAdapter();
    const notes = new Map([["folder/shared.md", markdown]]);
    const firstProvider = new TestEmbeddings();
    const first = await setup(
      adapter,
      notes,
      firstProvider,
      profile,
      undefined,
      "Sync/Trama",
      "a".repeat(64)
    );
    const secondProvider = new TestEmbeddings();
    const second = await setup(
      adapter,
      notes,
      secondProvider,
      profile,
      undefined,
      "Sync/Trama",
      "b".repeat(64)
    );
    try {
      expect((await first.manual.update()).sharing).toBe("complete");
      expect([...adapter.files.keys()]).toHaveLength(1);
      expect([...adapter.files.keys()][0]).toMatch(
        new RegExp(`^Sync/Trama/embeddings/${profileHash}/[0-9a-f]{64}\\.sqlite3$`)
      );
      expect((await second.manual.update()).numAdded).toBe(1);
      expect(secondProvider.calls).toEqual([]);
      expect(Number(second.db.selectValue("SELECT count(*) FROM note_vectors"))).toBeGreaterThan(0);
    } finally {
      await first.client.close();
      first.db.close();
      await second.client.close();
      second.db.close();
    }
  });

  it("cancels a custom-folder publication before a storage switch can redirect its write", async () => {
    const adapter = new MemoryAdapter();
    const provider = new TestEmbeddings();
    const result = await setup(
      adapter,
      new Map([["note.md", markdown]]),
      provider,
      profile,
      undefined,
      "Sync/Trama"
    );
    let releaseWrite!: () => void;
    let startedWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => (startedWrite = resolve));
    const writeGate = new Promise<void>((resolve) => (releaseWrite = resolve));
    const write = adapter.writeBinary.bind(adapter);
    adapter.writeBinary = async (path, bytes) => {
      if (path.startsWith("Sync/Trama/embeddings/") && path.includes(".tmp-")) {
        startedWrite();
        await writeGate;
      }
      await write(path, bytes);
    };
    try {
      const update = result.manual.update();
      await writeStarted;
      result.manual.cancel();
      releaseWrite();
      await expect(update).resolves.toMatchObject({ sharing: "cancelled" });
      expect(
        [...adapter.files.keys()].some(
          (path) =>
            path.startsWith("Sync/Trama/embeddings/") &&
            (path.endsWith(".sqlite3") || path.includes(".tmp-"))
        )
      ).toBe(false);
    } finally {
      await result.client.close();
      result.db.close();
    }
  });

  it("keeps a conflicting local vector and commits the shard receipt", async () => {
    const adapter = new MemoryAdapter();
    const notes = new Map([["folder/shared.md", markdown]]);
    const sourceProvider = new TestEmbeddings();
    const source = await setup(adapter, notes, sourceProvider);
    const targetProvider = new TestEmbeddings();
    const target = await setup(adapter, notes, targetProvider, {
      ...profile,
      endpoint: "http://127.0.0.1:4321/v1",
    });
    try {
      await source.manual.update();
      const documentHash = sha256(sourceProvider.calls.flat()[0]);
      const localVector = new Uint8Array(8);
      new DataView(localVector.buffer).setFloat32(0, 0.875, true);
      new DataView(localVector.buffer).setFloat32(4, 0.125, true);
      await target.client.call("embeddingCacheSet", {
        profile: target.cachedEmbeddings.profileFingerprint,
        task: "document",
        dimensions: 2,
        entries: [{ hash: documentHash, vector: localVector }],
        now: Date.now(),
      });

      expect((await target.manual.update()).numAdded).toBe(1);
      expect(targetProvider.calls).toEqual([]);
      const cached = queryRows(
        target.db,
        "SELECT vector FROM embedding_cache WHERE profile=? AND task='document' AND hash=?",
        [target.cachedEmbeddings.profileFingerprint, documentHash]
      );
      expect(new Uint8Array(cached[0].vector as Uint8Array)).toEqual(localVector);
      expect(
        Number(target.db.selectValue("SELECT count(*) FROM embedding_cache_sqlite_imports"))
      ).toBe(1);
      expect(
        Number(target.db.selectValue("SELECT count(*) FROM embedding_cache_sqlite_publications"))
      ).toBeGreaterThan(0);
    } finally {
      await source.client.close();
      await target.client.close();
      source.db.close();
      target.db.close();
    }
  });

  it("does not share document vectors across model or dimension changes", async () => {
    const adapter = new MemoryAdapter();
    const notes = new Map([["folder/shared.md", markdown]]);
    const publisher = await setup(adapter, notes, new TestEmbeddings());
    const otherModelProvider = new TestEmbeddings();
    const otherModel = await setup(adapter, notes, otherModelProvider, {
      ...profile,
      endpoint: "http://127.0.0.1:4321/v1",
      modelId: "another-model",
    });
    const otherDimensionsProvider = new TestEmbeddings(3);
    const otherDimensions = await setup(adapter, notes, otherDimensionsProvider, {
      ...profile,
      endpoint: "http://127.0.0.1:4321/v1",
      dimensions: 3,
    });
    try {
      await publisher.manual.update();
      await otherModel.manual.update();
      const dimensionChange = await otherDimensions.manual.update();
      expect(otherModelProvider.calls.flat()).toContain(markdown);
      expect(otherDimensionsProvider.calls.flat()).toContain(markdown);
      expect(dimensionChange.sharing).toBe("complete");
      expect(Number(otherDimensions.db.selectValue("SELECT count(*) FROM note_vectors"))).toBe(1);
    } finally {
      await publisher.client.close();
      await otherModel.client.close();
      await otherDimensions.client.close();
      publisher.db.close();
      otherModel.db.close();
      otherDimensions.db.close();
    }
  });

  it("treats corrupt and oversized SQLite files as cache misses", async () => {
    const adapter = new MemoryAdapter();
    const folder = `.trama/embeddings/${profileHash}`;
    adapter.folders.add(folder);
    const corrupt = new TextEncoder().encode("not a SQLite shard");
    const corruptHash = sha256(new TextDecoder().decode(corrupt));
    adapter.files.set(`${folder}/${corruptHash}.sqlite3`, corrupt);
    const oversized = new Uint8Array(EMBEDDING_ARTIFACT_MAX_FILE_BYTES);
    const oversizedHash = sha256(new TextDecoder().decode(oversized));
    adapter.files.set(`${folder}/${oversizedHash}.sqlite3`, oversized);
    const provider = new TestEmbeddings();
    const setupResult = await setup(adapter, new Map([["note.md", markdown]]), provider);
    try {
      expect((await setupResult.manual.update()).numAdded).toBe(1);
      expect(provider.calls.flat().length).toBeGreaterThan(0);
      expect(adapter.reads.get(`${folder}/${oversizedHash}.sqlite3`) ?? 0).toBe(0);
      expect(
        Number(setupResult.db.selectValue("SELECT count(*) FROM note_vectors"))
      ).toBeGreaterThan(0);
    } finally {
      await setupResult.client.close();
      setupResult.db.close();
    }
  });

  it("summarizes shard import failures in one bounded warning", async () => {
    const adapter = new MemoryAdapter();
    const folder = `.trama/embeddings/${profileHash}`;
    adapter.folders.add(folder);
    const bytes = new TextEncoder().encode("invalid sqlite artifact");
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer)
    );
    const checksum = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const filename = `${folder}/${checksum}.sqlite3`;
    adapter.files.set(filename, bytes);
    const cache = {
      profileFingerprint: profileHash,
      reconcileDocumentShards: vi.fn(async () => {}),
      unimportedSqliteShards: vi.fn(async (values: string[]) => values),
      importDocumentShard: vi.fn(async () => {
        throw new Error("SQLite shard import failed");
      }),
      exportNextDocumentShard: vi.fn(),
      markDocumentShardPublished: vi.fn(),
    };
    const debugWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const shared = new VaultEmbeddingCache(
      adapter as any,
      cache as any,
      2,
      new ConsoleDebug(() => true)
    );
    await shared.importAvailable(new AbortController().signal);
    expect(debugWarn).toHaveBeenCalledOnce();
    expect(debugWarn.mock.calls[0][0]).toContain("Embedding cache import completed-with-skips");
    expect(debugWarn.mock.calls[0][1]).toMatchObject({ message: "SQLite shard import failed" });
    expect(debugWarn.mock.calls[0][2]).toMatchObject({ failures: 1, imported: 0 });
    expect(JSON.stringify(debugWarn.mock.calls)).not.toContain(checksum);
    debugWarn.mockRestore();
  });

  it("reports an aborted cache import as a normal timed cancellation", async () => {
    const adapter = new MemoryAdapter();
    const controller = new AbortController();
    const aborted = new DOMException("Import cancelled", "AbortError");
    adapter.list = vi.fn(async () => {
      controller.abort();
      throw aborted;
    });
    const cache = {
      profileFingerprint: profileHash,
      reconcileDocumentShards: vi.fn(async () => {}),
      unimportedSqliteShards: vi.fn(),
      importDocumentShard: vi.fn(),
      exportNextDocumentShard: vi.fn(),
      markDocumentShardPublished: vi.fn(),
    };
    const debugInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const debugError = vi.spyOn(console, "error").mockImplementation(() => {});
    const shared = new VaultEmbeddingCache(
      adapter as any,
      cache as any,
      2,
      new ConsoleDebug(() => true)
    );
    await expect(shared.importAvailable(controller.signal)).rejects.toBe(aborted);
    expect(debugInfo.mock.calls.map(([label]) => label)).toContain(
      "[Trama] Embedding cache import cancelled"
    );
    expect(debugInfo.mock.calls.at(-1)?.[1]).toMatchObject({ elapsedMs: expect.any(Number) });
    expect(debugWarn).not.toHaveBeenCalled();
    expect(debugError).not.toHaveBeenCalled();
    debugInfo.mockRestore();
    debugWarn.mockRestore();
    debugError.mockRestore();
  });

  it("checks file metadata before reading a published artifact for verification", async () => {
    const adapter = new MemoryAdapter();
    const provider = new TestEmbeddings();
    const result = await setup(adapter, new Map([["note.md", markdown]]), provider);
    try {
      await result.cachedEmbeddings.embedDocuments([markdown]);
      adapter.oversizedMetadata = true;
      await expect(result.shared.publishAvailable(new AbortController().signal)).rejects.toThrow(
        "Published SQLite embedding shard failed its checksum."
      );
      expect(adapter.reads).toEqual(new Map());
    } finally {
      await result.client.close();
      result.db.close();
    }
  });

  it("keeps a published artifact when a later artifact fails and retries on the next update", async () => {
    const adapter = new MemoryAdapter();
    const provider = new TestEmbeddings();
    const debugWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await setup(
      adapter,
      new Map([["note.md", markdown]]),
      provider,
      profile,
      new ConsoleDebug(() => true)
    );
    try {
      await result.cachedEmbeddings.embedDocuments(
        Array.from({ length: 129 }, (_, index) => `shared cache entry ${index}`)
      );
      adapter.failRenameCall = 2;

      const first = await result.manual.update();
      expect(first.numAdded).toBe(1);
      expect(first.sharing).toBe("incomplete");
      expect(debugWarn).toHaveBeenCalledOnce();
      expect(debugWarn.mock.calls[0][0]).toContain("Embedding cache publication incomplete");
      expect(debugWarn.mock.calls[0][1]).toMatchObject({ message: "sharing write failed" });
      expect([...adapter.files.keys()].filter((path) => path.endsWith(".sqlite3"))).toHaveLength(1);
      expect(Number(result.db.selectValue("SELECT count(*) FROM note_index"))).toBe(1);
      expect(
        Number(result.db.selectValue("SELECT count(*) FROM embedding_cache_sqlite_imports"))
      ).toBe(1);

      const providerCalls = provider.calls.length;
      const retry = await result.manual.update();
      expect(retry.numSkipped).toBe(1);
      expect(retry.sharing).toBe("complete");
      expect(adapter.files.size).toBe(2);
      expect(provider.calls).toHaveLength(providerCalls);
    } finally {
      await result.client.close();
      result.db.close();
      debugWarn.mockRestore();
    }
  });

  it("does not publish artifacts when indexing fails", async () => {
    const adapter = new MemoryAdapter();
    const provider = new TestEmbeddings();
    provider.fail = true;
    const result = await setup(adapter, new Map([["note.md", markdown]]), provider);
    try {
      await expect(result.manual.update()).rejects.toThrow("provider unavailable");
      expect([...adapter.files.keys()]).toEqual([]);
    } finally {
      await result.client.close();
      result.db.close();
    }
  });

  it("does not publish artifacts when a run is cancelled during embedding", async () => {
    const adapter = new MemoryAdapter();
    const provider = new TestEmbeddings();
    provider.waitUntilAbort = true;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    provider.started = markStarted;
    const result = await setup(adapter, new Map([["note.md", markdown]]), provider);
    try {
      const run = result.manual.update();
      await started;
      result.manual.cancel();
      await expect(run).rejects.toMatchObject({ name: "AbortError" });
      expect([...adapter.files.keys()]).toEqual([]);
    } finally {
      await result.client.close();
      result.db.close();
    }
  });
});
