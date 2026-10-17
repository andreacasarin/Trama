import { describe, expect, it, vi } from "vitest";
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { VaultRetrieval } from "@/index/VaultRetrieval";
import { EmbeddingProviderError } from "@/model/LocalModels";
import { ConsoleDebug } from "@/plugin/ConsoleDebug";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { NoteStoreClient, type NoteStoreWorkerLike } from "@/index/note-sqlite/client";
import type { NoteStoreMethod, NoteStoreRpc } from "@/index/note-sqlite/protocol";
import { loadTestSqlite } from "./note-sqlite-test-client";

class Embeddings implements EmbeddingsInterface<number[]> {
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) => (text.includes("alpha") ? [1, 0] : [0, 1]));
  }
  async embedQuery(text: string): Promise<number[]> {
    return text.includes("alpha") ? [1, 0] : [0, 1];
  }
}

class Worker implements NoteStoreWorkerLike {
  private listeners = new Set<(event: any) => void>();
  addEventListener(_type: "message" | "error", listener: (event: any) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "message" | "error", listener: (event: any) => void): void {
    this.listeners.delete(listener);
  }
  postMessage(raw: unknown): void {
    const request = raw as { id: number; method: string; payload: unknown };
    if (request.method === "init" || request.method === "close") {
      this.emit({ id: request.id, ok: true, result: undefined });
      return;
    }
    if (request.method === "cancel") return;
    void this.db
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
  constructor(private db: NoteSqliteDatabase) {}
  private emit(data: unknown): void {
    for (const listener of this.listeners) listener({ data });
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
      documents: [{ id: "related.md", pageContent: "# related.md" }],
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(readNote).toHaveBeenCalledTimes(1);
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
});
