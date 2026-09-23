import { describe, expect, it, vi } from "vitest";
import { IndexManager, type IndexVaultPort } from "@/index/IndexManager";
import { SqliteWorkerClient } from "@/index/sqlite/client";
import {
  PublicationManager,
  type PublicationIndexPort,
} from "@/index/publications/PublicationManager";
import {
  PublicationStore,
  type PublicationDataAdapter,
} from "@/index/publications/PublicationStore";
import { createTestSqliteClient } from "./sqlite-test-client";

const vault: IndexVaultPort = {
  listMarkdownPaths: async () => ["one.md"],
  readMarkdown: async () => ({ path: "one.md", content: "alpha" }),
};
const embedding = {
  dimensions: 2,
  embed: async (texts: readonly string[]) => texts.map(() => [1, 0]),
};

function adapter() {
  const files = new Map<string, Uint8Array>();
  const renamed: string[][] = [];
  const value: PublicationDataAdapter & {
    files: typeof files;
    renamed: typeof renamed;
    failWrites: boolean;
    failRenames: boolean;
  } = {
    files,
    renamed,
    failWrites: false,
    failRenames: false,
    exists: async (path) => files.has(path),
    readBinary: async (path) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error("missing publication");
      return bytes.slice().buffer;
    },
    writeBinary: async (path, bytes) => {
      if (value.failWrites) throw new Error("publication write failed");
      files.set(path, new Uint8Array(bytes.slice(0)));
    },
    mkdir: async () => undefined,
    rename: async (from, to) => {
      if (value.failRenames) throw new Error("publication replace failed");
      const bytes = files.get(from);
      if (!bytes) throw new Error("missing staged publication");
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

function manager(identity: object, indexVault: IndexVaultPort = vault): IndexManager {
  return new IndexManager(indexVault, embedding, "http://embedding", "model", {
    publicationDirectory: "Trama/index",
    sqliteClient: createTestSqliteClient(identity),
  });
}

function publication(
  index: PublicationIndexPort,
  storage: PublicationDataAdapter,
  idFactory?: () => string
) {
  return new PublicationManager(
    index,
    new PublicationStore(storage, { directory: "Trama/index" }),
    idFactory ? { idFactory } : {}
  );
}

describe("single-file SQLite publications", () => {
  it("publishes one validated file with an opaque ID and resource metrics", async () => {
    const storage = adapter();
    const index = manager({});
    const publisher = publication(index, storage, () => "publication-1");

    await index.load();
    await index.build(new AbortController().signal);
    const before = await index.search("alpha", new AbortController().signal, 5);
    const state = await index.getState();
    expect(state?.incomplete).toBe(false);
    await expect(
      publisher.publishAfterSuccessfulOperation({
        operation: "update",
        changed: true,
        converged: false,
        state: state!,
      })
    ).resolves.toMatchObject({ published: false });
    const result = await publisher.publishAfterSuccessfulOperation({
      operation: "update",
      changed: true,
      converged: true,
      state: state!,
    });

    expect(result).toMatchObject({ published: true, publicationId: "publication-1" });
    expect(result.metrics).toMatchObject({
      publicationId: "publication-1",
      byteSize: expect.any(Number),
      copyBytes: expect.any(Number),
      durationMs: expect.any(Number),
    });
    expect(storage.files.has("Trama/index/index.sqlite3")).toBe(true);
    expect([...storage.files.keys()]).toEqual(["Trama/index/index.sqlite3"]);
    expect(storage.renamed).toHaveLength(1);
    expect(storage.files.has("Trama/index/index.sqlite3.trama-tmp-publication-1")).toBe(false);
    const publishedBytes = await storage.readBinary("Trama/index/index.sqlite3");
    expect(publishedBytes.byteLength).toBe(result.metrics?.byteSize);
    expect(await index.search("alpha", new AbortController().signal, 5)).toEqual(before);
  });

  it("does not automatically publish a converged no-op update", async () => {
    const storage = adapter();
    const index = manager({});
    const publisher = publication(index, storage, () => "no-op-publication");
    await index.build(new AbortController().signal);
    const state = await index.getState();

    await expect(
      publisher.publishAfterSuccessfulOperation({
        operation: "update",
        changed: false,
        converged: true,
        state: state!,
      })
    ).resolves.toEqual({ published: false });
    expect(storage.files.has("Trama/index/index.sqlite3")).toBe(false);
  });

  it("can prepare semantic vectors after publication reopens the live database", async () => {
    const storage = adapter();
    const index = manager({});
    const publisher = publication(index, storage, () => "reopen-publication");
    const signal = new AbortController().signal;

    await index.build(signal);
    await publisher.publish();
    await expect(index.prepareSemantic(signal)).resolves.toMatchObject({
      stored: 1,
      converged: true,
    });
    await expect(index.findRelated("one.md", signal, 5)).resolves.toEqual([]);
  });

  it("adopts a differing publication ID and ignores the same file on restart", async () => {
    const storage = adapter();
    const source = manager({});
    const publisher = publication(source, storage, () => "remote-1");
    await source.build(new AbortController().signal);
    await publisher.publish();

    const restarted = manager({});
    const receiver = publication(restarted, storage);
    await restarted.load();
    await expect(receiver.adoptCurrent()).resolves.toMatchObject({
      adopted: true,
      publicationId: "remote-1",
    });
    expect((await restarted.getState())?.publicationId).toBe("remote-1");
    expect(restarted.capabilities()).toMatchObject({
      lexical: { state: "ready", activity: "idle", searchable: true },
      freshness: "snapshot-loaded",
    });
    await expect(receiver.adoptCurrent()).resolves.toMatchObject({
      adopted: false,
      ignored: "same-id",
      publicationId: "remote-1",
    });
    expect(await restarted.search("alpha", new AbortController().signal, 5)).toHaveLength(1);
  });

  it("accepts a valid differing ID without ordering and never republishes adoption", async () => {
    const storage = adapter();
    const source = manager({});
    const sourcePublisher = publication(source, storage, () => "z-from-provider");
    await source.build(new AbortController().signal);
    await source.prepareSemantic(new AbortController().signal);
    await sourcePublisher.publish();

    const readMarkdown = vi.fn(async () => ({ path: "different.md", content: "different" }));
    const receiver = manager(
      {},
      {
        listMarkdownPaths: async () => ["different.md"],
        readMarkdown,
      }
    );
    await receiver.load();
    const receiverPublisher = publication(receiver, storage);
    const publish = vi.spyOn(receiver, "publishPublication");
    const adoption = await receiverPublisher.adoptCurrent();

    expect(adoption).toMatchObject({ adopted: true, publicationId: "z-from-provider" });
    expect(publish).not.toHaveBeenCalled();
    expect(readMarkdown).not.toHaveBeenCalled();
    expect((await receiver.getState())?.publicationId).toBe("z-from-provider");
    expect(await receiver.search("alpha", new AbortController().signal, 5)).toHaveLength(1);
    await expect(receiver.findRelated("one.md", new AbortController().signal, 5)).resolves.toEqual(
      []
    );
  });

  it("uses a changed configured folder and only publishes its exact target", async () => {
    const storage = adapter();
    const identity = {};
    const index = new IndexManager(vault, embedding, "http://embedding", "model", {
      publicationDirectory: "Mobile/TramaData",
      sqliteClient: createTestSqliteClient(identity),
    });
    const publisher = new PublicationManager(
      index,
      new PublicationStore(storage, {
        directory: "Mobile/TramaData",
        temporaryToken: () => "folder",
      }),
      { idFactory: () => "folder-publication" }
    );
    await index.build(new AbortController().signal);
    const result = await publisher.publish();

    expect(result.published).toBe(true);
    expect(storage.files.has("Mobile/TramaData/index.sqlite3")).toBe(true);
    expect(storage.files.has("Trama/index/index.sqlite3")).toBe(false);
  });

  it("keeps a successful local operation searchable when publication fails, then retries", async () => {
    const storage = adapter();
    const index = manager({});
    const publisher = publication(index, storage, () => "retry-publication");
    await index.build(new AbortController().signal);
    const before = await index.search("alpha", new AbortController().signal, 5);
    storage.failWrites = true;

    const failed = await publisher.publish();
    expect(failed).toMatchObject({ published: false, warning: { phase: "stage" } });
    expect(await index.search("alpha", new AbortController().signal, 5)).toEqual(before);

    storage.failWrites = false;
    await expect(publisher.publish()).resolves.toMatchObject({
      published: true,
      publicationId: "retry-publication",
    });
    expect(storage.files.has("Trama/index/index.sqlite3")).toBe(true);
  });

  it("rejects a corrupted temporary-file readback before replacing the publication", async () => {
    const storage = adapter();
    const index = manager({});
    const publisher = publication(index, storage, () => "corrupt-readback");
    await index.build(new AbortController().signal);
    const readBinary = storage.readBinary;
    storage.readBinary = async (path) => {
      const bytes = await readBinary(path);
      if (path.includes("trama-tmp")) new Uint8Array(bytes)[68] ^= 1;
      return bytes;
    };

    await expect(publisher.publish()).resolves.toMatchObject({
      published: false,
      warning: { phase: "inspect" },
    });
    expect(storage.files.has(publisher.store.path)).toBe(false);
    expect([...storage.files.keys()]).toEqual([]);
    expect(await index.search("alpha", new AbortController().signal, 5)).toHaveLength(1);
  });

  it("restores the previous vault file before unblocking writes if local ID finalization fails", async () => {
    const storage = adapter();
    const identity = {};
    const base = createTestSqliteClient(identity);
    let failFinalize = false;
    const client = new SqliteWorkerClient(undefined, async (method, payload, signal) => {
      if (failFinalize && method === "finalizePublication") throw new Error("finalize failed");
      return base.call(method, payload, signal);
    });
    const index = new IndexManager(vault, embedding, "http://embedding", "model", {
      publicationDirectory: "Trama/index",
      sqliteClient: client,
    });
    let nextId = 0;
    const publisher = publication(index, storage, () => `publication-${++nextId}`);
    await index.build(new AbortController().signal);
    expect((await publisher.publish()).published).toBe(true);
    const original = await publisher.store.read();
    failFinalize = true;

    await expect(publisher.publish()).resolves.toMatchObject({
      published: false,
      warning: { phase: "finalize" },
    });
    expect(await publisher.store.read()).toEqual(original);
    expect((await index.getState())?.publicationId).toBe("publication-1");
    expect(index.isInMaintenance()).toBe(false);
    expect(storage.files.has(publisher.store.backupPath)).toBe(false);
  });

  it("rejects tampered or mismatched candidates without changing the live database", async () => {
    const storage = adapter();
    const index = manager({});
    const publisher = publication(index, storage, () => "publication-2");
    await index.build(new AbortController().signal);
    await publisher.publish();
    const beforeState = await index.getState();
    const beforeSearch = await index.search("alpha", new AbortController().signal, 5);
    const bytes = await storage.readBinary("Trama/index/index.sqlite3");
    const tampered = bytes.slice(0);
    new Uint8Array(tampered)[68] ^= 1;

    await expect(index.inspectPublication(tampered)).rejects.toBeDefined();
    await expect(index.adoptPublication(tampered, "publication-2")).rejects.toBeDefined();
    await expect(index.inspectPublication(bytes)).resolves.toMatchObject({
      valid: true,
      publicationId: "publication-2",
    });
    await expect(index.adoptPublication(bytes, "wrong-id")).rejects.toMatchObject({
      error: { code: "incompatible_state" },
    });
    expect(await index.getState()).toEqual(beforeState);
    expect(await index.search("alpha", new AbortController().signal, 5)).toEqual(beforeSearch);
  });

  it("rejects inspection metadata from one publication when adoption bytes come from another", async () => {
    const storageA = adapter();
    const sourceA = manager({});
    await sourceA.build(new AbortController().signal);
    await publication(sourceA, storageA, () => "publication-a").publish();
    const bytesA = await storageA.readBinary("Trama/index/index.sqlite3");
    const inspectionA = await sourceA.inspectPublication(bytesA);

    const storageB = adapter();
    const sourceB = manager({});
    await sourceB.build(new AbortController().signal);
    await publication(sourceB, storageB, () => "publication-b").publish();
    const bytesB = await storageB.readBinary("Trama/index/index.sqlite3");

    const receiver = manager({});
    await receiver.load();
    const before = await receiver.getState();
    await expect(
      receiver.adoptPublication(bytesB, inspectionA.publicationId, inspectionA)
    ).rejects.toMatchObject({ error: { code: "incompatible_state" } });
    expect(await receiver.getState()).toEqual(before);
  }, 30_000);

  it("fences direct publication operations around active lexical runs", async () => {
    const client = createTestSqliteClient({});
    await client.call("boot", {
      corpusFingerprint: "a".repeat(64),
      embeddingFingerprint: "b".repeat(64),
      dimensions: 2,
    });
    const prepared = (await client.call("preparePublication", {
      publicationId: "before-run",
    })) as { bytes: ArrayBuffer };
    const run = (await client.call("beginLexicalRun", { summaries: [] })) as { runId: string };

    for (const request of [
      client.call("preparePublication", { publicationId: "blocked-prepare" }),
      client.call("inspectPublication", { bytes: prepared.bytes.slice(0) }),
      client.call("adoptPublication", {
        bytes: prepared.bytes.slice(0),
        expectedPublicationId: "before-run",
      }),
    ])
      await expect(request).rejects.toMatchObject({
        error: { code: "busy", retryable: true },
      });

    await client.call("abortLexicalRun", { runId: run.runId });
    await expect(client.call("getState", {})).resolves.toMatchObject({ incomplete: true });
    await expect(
      client.call("preparePublication", { publicationId: "after-abort" })
    ).resolves.toMatchObject({ publicationId: "after-abort" });
    await expect(
      client.call("inspectPublication", { bytes: prepared.bytes.slice(0) })
    ).resolves.toMatchObject({ publicationId: "before-run" });
    await expect(
      client.call("adoptPublication", {
        bytes: prepared.bytes.slice(0),
        expectedPublicationId: "before-run",
      })
    ).resolves.toMatchObject({ publicationId: "before-run" });

    const finished = (await client.call("beginLexicalRun", { summaries: [] })) as {
      runId: string;
    };
    await expect(client.call("finishLexicalRun", { runId: finished.runId })).resolves.toMatchObject(
      {
        complete: true,
      }
    );
    await expect(
      client.call("preparePublication", { publicationId: "after-finish" })
    ).resolves.toMatchObject({ publicationId: "after-finish" });
  });
});
