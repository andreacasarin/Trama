import { describe, expect, it, vi } from "vitest";
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { SqliteEmbeddingCache, embeddingCacheIdentity } from "@/index/SqliteEmbeddingCache";
import { VaultRetrieval } from "@/index/VaultRetrieval";
import { createLocalEmbeddings, EmbeddingProviderError } from "@/model/LocalModels";
import { ConsoleDebug } from "@/plugin/ConsoleDebug";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { NoteStoreClient } from "@/index/note-sqlite/client";
import type { NoteStoreCall } from "@/index/note-sqlite/protocol";
import { loadTestSqlite, TestNoteWorker as Worker } from "./note-sqlite-test-client";

class Embeddings implements EmbeddingsInterface<number[]> {
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) => (text.includes("alpha") ? [1, 0] : [0, 1]));
  }
  async embedQuery(text: string): Promise<number[]> {
    return text.includes("alpha") ? [1, 0] : [0, 1];
  }
}

async function fixture() {
  const sqlite = await loadTestSqlite();
  const db = new sqlite.oo1.DB(":memory:", "c");
  const database = new NoteSqliteDatabase(db);
  const client = new NoteStoreClient(new Worker(database), "a".repeat(64));
  const embeddings = new Embeddings();
  const notes = new Map<string, string>();
  const profile = { endpoint: "http://127.0.0.1:1234/v1", modelId: "test", dimensions: 2 };
  const store = new SqliteNoteVectorStore(
    embeddings,
    client.call,
    async (path) => notes.get(path) ?? null,
    profile
  );
  return { db, database, client, embeddings, notes, store, profile };
}

describe("SQLite note retrieval", () => {
  it("returns hybrid results when a valid query embedding cannot be cached because SQLite is full", async () => {
    const f = await fixture();
    const vector = [1, ...new Array<number>(1535).fill(0)];
    const bytes = new Uint8Array(new Float32Array(vector).buffer);
    const writeErrors: string[] = [];
    const call: NoteStoreCall = async (method, payload, signal) => {
      try {
        return await f.client.call(method, payload, signal);
      } catch (error) {
        if (method === "embeddingCacheSet") writeErrors.push((error as Error).message);
        throw error;
      }
    };
    const embedQuery = vi.fn(async () => vector);
    const cache = new SqliteEmbeddingCache(
      { embedDocuments: async () => [], embedQuery },
      call,
      embeddingCacheIdentity("full", 1536),
      1536
    );
    try {
      await f.database.call("noteStoreReplace", {
        uid: "a",
        path: "a.md",
        profile: "p",
        markdown: "alpha sentinel",
        vectors: [vector],
      });
      f.db.exec(`PRAGMA max_page_count=${Number(f.db.selectValue("PRAGMA page_count")) + 1}`);
      let full = false;
      for (let i = 0; i < 200; i++) {
        try {
          await f.database.call("embeddingCacheSet", {
            profile: cache.profileFingerprint,
            task: "query",
            dimensions: 1536,
            entries: [{ hash: i.toString(16).padStart(64, "0"), vector: bytes }],
            now: Date.now(),
          });
        } catch (error) {
          expect((error as Error).message).toContain("SQLITE_FULL");
          full = true;
          break;
        }
      }
      expect(full).toBe(true);
      const retrieval = new VaultRetrieval(call, cache, "p", async (path) => ({
        path,
        content: "alpha sentinel",
      }));
      const output = await retrieval.runnable.invoke({ query: "alpha", mode: "hybrid" });
      expect(writeErrors).toHaveLength(1);
      expect(writeErrors[0]).toContain("SQLITE_FULL");
      expect(embedQuery).toHaveBeenCalledOnce();
      expect(output.documents.map((document) => document.metadata.path)).toEqual(["a.md"]);
      expect(output.status).toMatchObject({ mode: "hybrid", degraded: false });
    } finally {
      await f.client.close();
      f.db.close();
    }
  });

  it("cancels non-view searches before cache clearing and permits subsequent searches", async () => {
    const f = await fixture();
    let release!: (vector: number[]) => void;
    const embedQuery = vi.fn(
      () =>
        new Promise<number[]>((resolve) => {
          release = resolve;
        })
    );
    const cache = new SqliteEmbeddingCache(
      { embedDocuments: async () => [], embedQuery },
      f.client.call,
      embeddingCacheIdentity("test", 2),
      2
    );
    const retrieval = new VaultRetrieval(f.client.call, cache, "profile", async () => null);
    try {
      const pending = retrieval.runnable.invoke({ query: "needle", mode: "hybrid" });
      await vi.waitFor(() => expect(embedQuery).toHaveBeenCalledOnce());
      retrieval.cancelSearches();
      await f.client.call("noteStoreClear", {});
      release([1, 0]);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(f.db.selectValue("SELECT count(*) FROM embedding_cache")).toBe(0);
      embedQuery.mockResolvedValue([1, 0]);
      await retrieval.runnable.invoke({ query: "needle", mode: "hybrid" });
      expect(f.db.selectValue("SELECT count(*) FROM embedding_cache")).toBe(1);
    } finally {
      f.db.close();
    }
  });

  it("falls back to actual lexical results for a malformed embedding provider entry", async () => {
    const f = await fixture();
    try {
      f.notes.set("alpha.md", "alpha sentinel");
      await f.store.addDocuments([
        new Document({
          id: "alpha.md",
          pageContent: "alpha sentinel",
          metadata: { path: "alpha.md" },
        }),
      ]);
      const provider = createLocalEmbeddings({
        endpoint: "http://127.0.0.1:1234/v1",
        modelId: "test",
        dimensions: 2,
        fetcher: async () => Response.json({ data: [null] }),
      });
      const retrieval = new VaultRetrieval(f.client.call, provider, "profile", async (path) => ({
        path,
        content: f.notes.get(path)!,
      }));
      const result = await retrieval.runnable.invoke({ query: "alpha", mode: "hybrid" });
      expect(result.status.degradationReason).toBe("query-embedding-failed");
      expect(result.documents.map((document) => document.metadata.path)).toEqual(["alpha.md"]);
    } finally {
      await f.client.close();
      f.db.close();
    }
  });

  it("logs a bounded warning when query embeddings fall back to lexical search", async () => {
    const debugWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const embeddings: EmbeddingsInterface<number[]> = {
      embedDocuments: async () => [],
      embedQuery: async () => {
        throw new EmbeddingProviderError("local embedding unavailable");
      },
    };
    const call = vi.fn(async () => ({ mode: "lexical" as const, degraded: true, hits: [] }));
    const retrieval = new VaultRetrieval(
      call as any,
      embeddings,
      "profile",
      async () => null,
      new ConsoleDebug(() => true)
    );
    const result = await retrieval.runnable.invoke({
      query: "private search text",
      mode: "hybrid",
    });
    expect(result.status.degradationReason).toBe("query-embedding-failed");
    expect(debugWarn).toHaveBeenCalledOnce();
    expect(debugWarn.mock.calls[0][0]).toContain("using lexical search");
    expect(debugWarn.mock.calls[0][1]).toMatchObject({ message: "local embedding unavailable" });
    expect(JSON.stringify(debugWarn.mock.calls)).not.toContain("private search text");
    debugWarn.mockRestore();
  });

  it("terminalizes failed and cancelled searches while preserving failures for the view", async () => {
    const debugInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugError = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = new Error("search transport failed");
    const failed = new VaultRetrieval(
      vi.fn(async () => {
        throw original;
      }) as any,
      undefined,
      "profile",
      async () => null,
      new ConsoleDebug(() => true)
    );
    await expect(failed.runnable.invoke({ query: "private text", mode: "lexical" })).rejects.toBe(
      original
    );
    expect(debugInfo.mock.calls.map(([label]) => label)).toContain("[Trama] Vault search failed");
    expect(debugInfo.mock.calls.at(-1)?.[1]).toMatchObject({ elapsedMs: expect.any(Number) });
    expect(debugError).not.toHaveBeenCalled();

    debugInfo.mockClear();
    const call = vi.fn(
      (_method: string, _payload: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
        )
    );
    const cancelled = new VaultRetrieval(
      call as any,
      undefined,
      "profile",
      async () => null,
      new ConsoleDebug(() => true)
    );
    const controller = new AbortController();
    const pending = cancelled.runnable.invoke(
      { query: "private text", mode: "lexical" },
      { signal: controller.signal }
    );
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(debugInfo.mock.calls.map(([label]) => label)).toContain(
      "[Trama] Vault search cancelled"
    );
    expect(debugInfo.mock.calls.at(-1)?.[1]).toMatchObject({ elapsedMs: expect.any(Number) });
    expect(debugError).not.toHaveBeenCalled();
    debugInfo.mockRestore();
    debugError.mockRestore();
  });

  it("terminalizes related lookup failures and consumer cancellation without duplicate errors", async () => {
    const debugInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugError = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = new Error("related query failed");
    const failed = new VaultRetrieval(
      vi.fn(async () => {
        throw original;
      }) as any,
      undefined,
      "profile",
      async () => null,
      new ConsoleDebug(() => true)
    );
    await expect(failed.related("source.md", new AbortController().signal)).rejects.toBe(original);
    expect(debugInfo.mock.calls.map(([label]) => label)).toContain(
      "[Trama] Filo related-note lookup failed"
    );
    const relatedTerminal = debugInfo.mock.calls.find(([label]) =>
      String(label).includes("related-note lookup failed")
    );
    expect(relatedTerminal?.[1]).toMatchObject({ elapsedMs: expect.any(Number) });
    expect(debugError).toHaveBeenCalledOnce();
    expect(debugError.mock.calls[0][1]).toBe(original);

    debugInfo.mockClear();
    debugError.mockClear();
    let resolveHits!: (value: unknown) => void;
    const pendingCall = vi.fn(() => new Promise((resolve) => (resolveHits = resolve)));
    const pendingRetrieval = new VaultRetrieval(
      pendingCall as any,
      undefined,
      "profile",
      async () => null,
      new ConsoleDebug(() => true)
    );
    const controller = new AbortController();
    const lookup = pendingRetrieval.related("source.md", controller.signal);
    controller.abort();
    await expect(lookup).rejects.toMatchObject({ name: "AbortError" });
    resolveHits({ hits: [], available: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(debugInfo.mock.calls.map(([label]) => label)).toContain(
      "[Trama] Filo related-note lookup cancelled"
    );
    expect(debugInfo.mock.calls.map(([label]) => label)).toContain(
      "[Trama] Filo related-note lookup completed"
    );
    expect(debugError).not.toHaveBeenCalled();
    debugInfo.mockRestore();
    debugError.mockRestore();
  });

  it("coalesces Filo and Voce related hits while isolating consumer cancellation", async () => {
    let resolveHits!: (value: unknown) => void;
    let workerSignal!: AbortSignal | undefined;
    const call = vi.fn((_method: string, _payload: unknown, signal?: AbortSignal) => {
      workerSignal = signal;
      return new Promise((resolve) => (resolveHits = resolve));
    });
    const readNote = vi.fn(async (path: string) => ({ path, content: `# ${path}` }));
    const retrieval = new VaultRetrieval(call as any, undefined, "profile", readNote);
    const cancelOne = new AbortController();
    const paths = retrieval.relatedPaths("source.md", cancelOne.signal, 7);
    const hydrated = retrieval.related("source.md", new AbortController().signal, 7);
    cancelOne.abort();
    await expect(paths).rejects.toMatchObject({ name: "AbortError" });
    expect(workerSignal?.aborted).toBe(false);
    resolveHits({ hits: [{ path: "related.md", score: 0.8 }], available: true });
    await expect(hydrated).resolves.toMatchObject({
      available: true,
      documents: [{ id: "related.md", pageContent: "" }],
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(readNote).not.toHaveBeenCalled();
  });

  it("returns path-only related suggestions without reading note bodies and refreshes after invalidation", async () => {
    const call = vi.fn(async () => ({
      hits: [{ path: "related.md", score: 0.8 }],
      available: true,
    }));
    const readNote = vi.fn(async (path: string) => ({ path, content: "private text" }));
    const retrieval = new VaultRetrieval(call as any, undefined, "profile", readNote);
    const signal = new AbortController().signal;
    await expect(retrieval.relatedPaths("source.md", signal, 7)).resolves.toEqual({
      paths: ["related.md"],
      available: true,
    });
    expect(readNote).not.toHaveBeenCalled();
    retrieval.invalidateRelated();
    await retrieval.relatedPaths("source.md", signal, 7);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("uses native hybrid ranks, safely tokenizes punctuation, hydrates live notes, and reports degradation", async () => {
    const f = await fixture();
    try {
      for (const [path, content] of [
        ["a.md", "# alpha\n\nalpha apple"],
        ["b.md", "# beta\n\nbeta apple"],
      ]) {
        f.notes.set(path, content);
        await f.store.addDocuments([
          new Document({ id: path, pageContent: content, metadata: { path } }),
        ]);
      }
      const retrieval = new VaultRetrieval(
        f.client.call,
        f.embeddings,
        f.store.embeddingProfile,
        async (path) => {
          const content = f.notes.get(path);
          return content === undefined ? null : { path, content };
        }
      );
      const result = await retrieval.runnable.invoke({ query: "alpha (c++)", mode: "hybrid" });
      expect(result.documents[0].metadata.path).toBe("a.md");
      expect(result.documents[0].pageContent).toContain("alpha apple");
      expect(result.status).toEqual({ mode: "hybrid", degraded: false });
      await expect(
        f.database.call("noteStoreHybrid", {
          query: "alpha",
          vector: [1, 0, 0],
          profile: f.store.embeddingProfile,
          k: 5,
        })
      ).rejects.toThrow("Query vector dimensions do not match the profile");
      const lexical = await f.database.call("noteStoreHybrid", { query: "alpha +++", k: 5 });
      expect(lexical).toMatchObject({ mode: "lexical", hits: [{ path: "a.md" }] });
      expect(JSON.stringify(lexical)).not.toContain("vector");
      const missingProfile = await f.database.call("noteStoreHybrid", {
        query: "alpha",
        vector: [1, 0],
        profile: "missing",
        k: 5,
      });
      expect(missingProfile).toMatchObject({
        mode: "lexical",
        degraded: true,
        degradationReason: "semantic-unavailable",
      });
    } finally {
      f.db.close();
    }
  });

  it("keeps the SQL candidate pool while hydrating only enough existing documents for the limit", async () => {
    const call = vi.fn(async (_method: string, _payload: unknown) => ({
      mode: "lexical" as const,
      degraded: false,
      hits: [
        { path: "missing.md", score: 3 },
        { path: "first.md", score: 2 },
        { path: "second.md", score: 1 },
      ],
    }));
    const readNote = vi.fn(async (path: string) =>
      path === "first.md" || path === "second.md" ? { path, content: path } : null
    );
    const retrieval = new VaultRetrieval(call as any, undefined, "profile", readNote);

    const result = await retrieval.runnable.invoke({ query: "needle", mode: "lexical", limit: 1 });

    expect(call).toHaveBeenCalledWith(
      "noteStoreHybrid",
      expect.objectContaining({ k: 20 }),
      expect.any(AbortSignal)
    );
    expect(result.documents.map((document) => document.id)).toEqual(["first.md"]);
    expect(readNote.mock.calls.map(([path]) => path)).toEqual(["missing.md", "first.md"]);
  });

  it("returns requestable SQLite search counts above the previous ceiling", async () => {
    const f = await fixture();
    try {
      const documents = Array.from({ length: 230 }, (_, index) => {
        const path = `notes/result-${String(index).padStart(3, "0")}.md`;
        const content = `# needle result ${index}\n\nSearchable needle content for result ${index}.`;
        f.notes.set(path, content);
        return new Document({ id: path, pageContent: content, metadata: { path } });
      });
      await f.store.addDocuments(documents);
      const retrieval = new VaultRetrieval(f.client.call, undefined, undefined, async (path) => {
        const content = f.notes.get(path);
        return content === undefined ? null : { path, content };
      });

      const result = await retrieval.runnable.invoke({
        query: "needle",
        mode: "lexical",
        limit: 210,
      });

      expect(result.documents).toHaveLength(210);
      expect(result.documents[0].metadata.path).toBe("notes/result-000.md");
      expect(result.documents.some(({ metadata }) => metadata.path === "notes/result-209.md")).toBe(
        true
      );
    } finally {
      f.db.close();
    }
  });
});
