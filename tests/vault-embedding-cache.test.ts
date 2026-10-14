import { describe, expect, it } from "vitest";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { sha256 } from "@langchain/core/utils/hash";
import { ManualIndex, type ManualIndexNote, type ManualIndexVault } from "@/index/ManualIndex";
import { embeddingCacheIdentity, SqliteEmbeddingCache } from "@/index/SqliteEmbeddingCache";
import { SqliteNoteRecordManager } from "@/index/SqliteNoteRecordManager";
import { SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { NoteStoreClient, type NoteStoreWorkerLike } from "@/index/note-sqlite/client";
import type { NoteStoreMethod, NoteStoreRpc, SqliteConnection } from "@/index/note-sqlite/protocol";
import { EMBEDDING_ARTIFACT_MAX_FILE_BYTES } from "@/index/note-sqlite/protocol";
import { VaultEmbeddingCache } from "@/plugin/VaultEmbeddingCache";
import { loadTestSqlite } from "./note-sqlite-test-client";

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
      folders: [],
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

class LocalWorker implements NoteStoreWorkerLike {
  private listeners = new Set<(event: any) => void>();
  constructor(private readonly database: NoteSqliteDatabase) {}
  addEventListener(_type: "message" | "error" | "messageerror", listener: (event: any) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "message" | "error" | "messageerror", listener: (event: any) => void) {
    this.listeners.delete(listener);
  }
  postMessage(raw: unknown): void {
    const request = raw as { id: number; method: string; payload: unknown };
    if (request.method === "init" || request.method === "close" || request.method === "cancel") {
      this.emit({ id: request.id, ok: true, result: undefined });
      return;
    }
    void this.database
      .call(request.method as NoteStoreMethod, request.payload as NoteStoreRpc[NoteStoreMethod])
      .then((result) => this.emit({ id: request.id, ok: true, result }))
      .catch((error) =>
        this.emit({
          id: request.id,
          ok: false,
          error: { name: error.name, message: error.message },
        })
      );
  }
  private emit(data: unknown): void {
    for (const listener of this.listeners) listener({ data });
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
  embeddingProfile = profile
) {
  const sqlite = await loadTestSqlite();
  const db = new sqlite.oo1.DB(":memory:", "c");
  const database = new NoteSqliteDatabase(db);
  const client = new NoteStoreClient(new LocalWorker(database), "b".repeat(64));
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
    embeddingProfile.dimensions
  );
  const manual = new ManualIndex(
    new MemoryVault(notes),
    store,
    new SqliteNoteRecordManager(client.call),
    shared
  );
  return { db, client, manual, shared, cachedEmbeddings };
}

describe("vault-shared document embedding artifacts", () => {
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
        new RegExp(`^Trama/embedding-cache-v2/${profileHash}/[0-9a-f]{64}\\.sqlite3$`)
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
    const folder = `Trama/embedding-cache-v2/${profileHash}`;
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
    const result = await setup(adapter, new Map([["note.md", markdown]]), provider);
    try {
      await result.cachedEmbeddings.embedDocuments(
        Array.from({ length: 129 }, (_, index) => `shared cache entry ${index}`)
      );
      adapter.failRenameCall = 2;

      const first = await result.manual.update();
      expect(first.numAdded).toBe(1);
      expect(first.sharing).toBe("incomplete");
      expect(adapter.files.size).toBe(1);
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
