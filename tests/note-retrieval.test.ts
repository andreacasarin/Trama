import { describe, expect, it } from "vitest";
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { VaultRetrieval } from "@/index/VaultRetrieval";
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
