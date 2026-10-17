import { MarkdownTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { NoteStoreClient, type NoteStoreWorkerLike } from "@/index/note-sqlite/client";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import type { SqliteConnection } from "@/index/note-sqlite/protocol";
import { attachNoteStoreWorker } from "@/index/note-sqlite/worker";
import { loadTestSqlite } from "./note-sqlite-test-client";

type Response = {
  readonly id: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: any;
};

class QueuedWorkerHarness implements NoteStoreWorkerLike {
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly responses: Response[] = [];
  terminated = false;
  closed = false;
  private readonly scope: {
    onmessage: ((event: MessageEvent<any>) => void) | null;
    postMessage(message: unknown): void;
    close(): void;
  };

  constructor(
    open: (namespace: string) => Promise<{
      database: Pick<NoteSqliteDatabase, "call">;
      close(): void;
    }>
  ) {
    this.scope = {
      onmessage: null,
      postMessage: (message) => {
        queueMicrotask(() => {
          this.responses.push(message as Response);
          for (const listener of this.listeners.get("message") ?? []) listener({ data: message });
        });
      },
      close: () => {
        this.closed = true;
      },
    };
    attachNoteStoreWorker(this.scope, open);
  }

  addEventListener(type: "message" | "error", listener: (event: any) => void): void {
    const group = this.listeners.get(type) ?? new Set();
    group.add(listener);
    this.listeners.set(type, group);
  }

  removeEventListener(type: "message" | "error", listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown): void {
    this.scope.onmessage?.({ data: message } as MessageEvent<any>);
  }

  terminate(): void {
    this.terminated = true;
  }

  async response(id: number): Promise<Response> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = this.responses.find((message) => message.id === id);
      if (found) return found;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`Worker response ${id} was not received`);
  }
}

const namespaceA = "a".repeat(64);
const namespaceB = "b".repeat(64);
const entry = (path: string, markdown: string) => ({
  uid: path,
  path,
  profile: null,
  markdown,
  vectors: [],
});

describe("SQLite note worker transport", () => {
  it("rejects initialization on a worker module error and closes the failed candidate", async () => {
    const listeners = new Map<string, Set<(event: any) => void>>();
    let terminated = false;
    const worker: NoteStoreWorkerLike = {
      postMessage: (message: any) => {
        if (message.method === "init")
          queueMicrotask(() => {
            for (const listener of listeners.get("error") ?? [])
              listener({
                message: "worker module failed",
                error: new Error("worker module failed"),
              });
          });
      },
      addEventListener(type, listener) {
        const group = listeners.get(type) ?? new Set();
        group.add(listener);
        listeners.set(type, group);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
      terminate() {
        terminated = true;
      },
    };
    const client = new NoteStoreClient(worker, namespaceA);
    await expect(client.initialize()).rejects.toThrow("worker module failed");
    await client.close();
    expect(terminated).toBe(true);
  });

  it("isolates initialized vault namespaces and rejects requests before initialization", async () => {
    const sqlite = await loadTestSqlite();
    const opened: string[] = [];
    const createWorker = () =>
      new QueuedWorkerHarness(async (namespace) => {
        opened.push(namespace);
        const db = new sqlite.oo1.DB(":memory:", "c");
        return { database: new NoteSqliteDatabase(db), close: () => db.close() };
      });
    const uninitialized = createWorker();
    uninitialized.postMessage({ id: 70, method: "noteStoreHybrid", payload: { query: "a", k: 1 } });
    expect((await uninitialized.response(70)).error.message).toMatch(/not initialized/);
    expect(opened).toEqual([]);

    const firstWorker = createWorker();
    const secondWorker = createWorker();
    const first = new NoteStoreClient(firstWorker, namespaceA);
    const second = new NoteStoreClient(secondWorker, namespaceB);
    expect(await first.call("noteStoreHasNotes", {})).toBe(false);
    await Promise.all([
      first.call("noteStoreReplace", entry("alpha.md", "# alpha\n\nalpha note")),
      second.call("noteStoreReplace", entry("beta.md", "# beta\n\nbeta note")),
    ]);
    expect(await first.call("noteStoreHasNotes", {})).toBe(true);
    expect(opened).toEqual([namespaceA, namespaceB]);
    expect(await first.call("noteStoreHybrid", { query: "alpha", k: 10 })).toMatchObject({
      hits: [{ path: "alpha.md" }],
    });
    expect(await second.call("noteStoreHybrid", { query: "alpha", k: 10 })).toMatchObject({
      hits: [],
    });
    expect(await second.call("noteStoreHybrid", { query: "beta", k: 10 })).toMatchObject({
      hits: [{ path: "beta.md" }],
    });

    firstWorker.postMessage({ id: 71, method: "init", payload: { namespace: namespaceB } });
    expect((await firstWorker.response(71)).error.message).toMatch(/cannot change vault namespace/);
    await first.call("noteStoreReset", {});
    expect(await first.call("noteStoreHasNotes", {})).toBe(false);
    expect(await first.call("noteStoreHybrid", { query: "alpha", k: 10 })).toMatchObject({
      hits: [],
    });
    expect(await second.call("noteStoreHybrid", { query: "beta", k: 10 })).toMatchObject({
      hits: [{ path: "beta.md" }],
    });
    const firstClose = first.close();
    expect(first.close()).toBe(firstClose);
    await Promise.all([firstClose, second.close()]);
    expect(firstWorker.closed && firstWorker.terminated).toBe(true);
    expect(secondWorker.closed && secondWorker.terminated).toBe(true);
  });

  it("queues SQL through an actual WASM transaction, delivers cancellation mid-write, and preserves the prior note", async () => {
    const sqlite = await loadTestSqlite();
    let databaseClosed = false;
    let firstInsert!: () => void;
    const firstInsertSeen = new Promise<void>((resolve) => (firstInsert = resolve));
    let watchInsert = false;
    const worker = new QueuedWorkerHarness(async () => {
      const db = new sqlite.oo1.DB(":memory:", "c");
      const connection: SqliteConnection = {
        exec(statement) {
          if (
            watchInsert &&
            typeof statement !== "string" &&
            statement.sql.startsWith("INSERT INTO note_vectors")
          ) {
            watchInsert = false;
            firstInsert();
          }
          db.exec(statement as any);
        },
        close() {
          databaseClosed = true;
          db.close();
        },
      };
      const database = new NoteSqliteDatabase(connection);
      return { database, close: () => connection.close() };
    });
    const client = new NoteStoreClient(worker, namespaceA);
    await client.call("noteStoreReplace", entry("note.md", "# prior\n\nprior complete note"));

    const markdown = `# replacement\n\n${Array.from({ length: 1400 }, () => "transactional content for cancellation testing").join(" ")}`;
    const chunks = await new MarkdownTextSplitter().splitDocuments([
      new Document({ pageContent: markdown, metadata: { path: "note.md" } }),
    ]);
    expect(chunks.length).toBeGreaterThan(16);
    watchInsert = true;
    const controller = new AbortController();
    const replacement = client.call(
      "noteStoreReplace",
      {
        uid: "note-v2",
        path: "note.md",
        profile: "local-model",
        markdown,
        vectors: chunks.map(() => [1, 0]),
      },
      controller.signal
    );
    await firstInsertSeen;
    const queuedLookup = client.call("noteStoreHybrid", { query: "prior", k: 1 });
    controller.abort();
    await expect(replacement).rejects.toMatchObject({ name: "AbortError" });
    expect(await queuedLookup).toMatchObject({ hits: [{ path: "note.md" }] });
    await client.close();
    expect(worker.closed).toBe(true);
    expect(worker.terminated).toBe(true);
    expect(databaseClosed).toBe(true);
  });

  it("rolls back queued delete and reset when worker-message cancellation arrives mid-transaction", async () => {
    const sqlite = await loadTestSqlite();
    let cancelNextYield: (() => void) | undefined;
    const worker = new QueuedWorkerHarness(async () => {
      const db = new sqlite.oo1.DB(":memory:", "c");
      const connection: SqliteConnection = {
        exec(statement) {
          const sql = typeof statement === "string" ? statement : statement.sql;
          if (sql === "DELETE FROM note_fts" || sql.startsWith("DELETE FROM note_fts WHERE")) {
            const cancel = cancelNextYield;
            cancelNextYield = undefined;
            if (cancel) setTimeout(cancel, 0);
          }
          db.exec(statement as any);
        },
        close: () => db.close(),
      };
      return { database: new NoteSqliteDatabase(connection), close: connection.close };
    });
    const client = new NoteStoreClient(worker, namespaceA);
    await client.initialize();
    const paths = Array.from(
      { length: 20 },
      (_, index) => `${index.toString().padStart(2, "0")}.md`
    );
    await Promise.all(
      paths.map((path) =>
        client.call("noteStoreReplace", {
          ...entry(path, `# ${path}\n\nshared searchable body`),
          profile: "worker-test",
          vectors: [[1, 0]],
        })
      )
    );

    const deleteController = new AbortController();
    cancelNextYield = () => deleteController.abort();
    await expect(
      client.call("noteStoreDelete", { uids: paths }, deleteController.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await client.call("noteStoreHybrid", { query: "shared", k: 100 })).toMatchObject({
      hits: expect.arrayContaining(paths.map((path) => expect.objectContaining({ path }))),
    });

    const cachedHash = "a".repeat(64);
    const cacheProfile = "b".repeat(64);
    const cachedVector = new Uint8Array(new Float32Array([1, 0]).buffer);
    await client.call("embeddingCacheSet", {
      profile: cacheProfile,
      task: "document",
      dimensions: 2,
      entries: [{ hash: cachedHash, vector: cachedVector }],
      now: 1,
    });

    const resetController = new AbortController();
    cancelNextYield = () => resetController.abort();
    await expect(client.call("noteStoreReset", {}, resetController.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await client.call("noteStoreHybrid", { query: "shared", k: 100 })).toMatchObject({
      hits: expect.arrayContaining(paths.map((path) => expect.objectContaining({ path }))),
    });
    expect(
      await client.call("embeddingCacheGet", {
        profile: cacheProfile,
        task: "document",
        hashes: [cachedHash],
        now: 2,
      })
    ).toEqual([expect.any(Uint8Array)]);
    await client.call("noteStoreReset", {});
    expect(await client.call("noteStoreHybrid", { query: "shared", k: 100 })).toMatchObject({
      hits: [],
    });
    expect(
      await client.call("embeddingCacheGet", {
        profile: cacheProfile,
        task: "document",
        hashes: [cachedHash],
        now: 3,
      })
    ).toEqual([expect.any(Uint8Array)]);
    await client.close();
  });
});
