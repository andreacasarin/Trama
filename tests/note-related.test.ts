import { describe, expect, it } from "vitest";
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { NoteStoreClient } from "@/index/note-sqlite/client";
import type {} from "@/index/note-sqlite/protocol";
import { loadTestSqlite, TestNoteWorker as Worker } from "./note-sqlite-test-client";

class Embeddings implements EmbeddingsInterface<number[]> {
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) => (text.includes("alpha") ? [1, 0] : [0, 1]));
  }
  async embedQuery(): Promise<number[]> {
    return [1, 0];
  }
}

describe("SQLite related notes", () => {
  it("ranks native note centroids, excludes the source, and transfers no vectors", async () => {
    const sqlite = await loadTestSqlite();
    const db = new sqlite.oo1.DB(":memory:", "c");
    try {
      const queries: string[] = [];
      const connection = {
        exec(statement: string | { sql: string; [key: string]: unknown }) {
          if (typeof statement !== "string") queries.push(statement.sql);
          db.exec(statement as any);
        },
        close: () => db.close(),
      };
      const database = new NoteSqliteDatabase(connection);
      const client = new NoteStoreClient(new Worker(database), "a".repeat(64));
      const notes = new Map<string, string>();
      const store = new SqliteNoteVectorStore(
        new Embeddings(),
        client.call,
        async (path) => notes.get(path) ?? null,
        { endpoint: "http://127.0.0.1:1234/v1", modelId: "test", dimensions: 2 }
      );
      for (const [path, content] of [
        ["source.md", "# alpha\n\nalpha source"],
        ["same.md", "# alpha\n\nalpha related"],
        ["other.md", "# beta\n\nbeta related"],
      ]) {
        notes.set(path, content);
        await store.addDocuments([
          new Document({ id: path, pageContent: content, metadata: { path } }),
        ]);
      }
      const result = await database.call("noteStoreRelated", {
        sourcePath: "source.md",
        profile: store.embeddingProfile,
        k: 10,
      });
      expect(result).toMatchObject({
        available: true,
        hits: [
          { path: "same.md", score: 1 },
          { path: "other.md", score: 0 },
        ],
      });
      expect(JSON.stringify(result)).not.toContain("vector");
      expect(result).not.toHaveProperty("centroid");
      expect(queries.some((sql) => /SELECT\s+(?:other\.)?centroid\b/i.test(sql))).toBe(false);
      expect(
        await database.call("noteStoreRelated", {
          sourcePath: "source.md",
          profile: store.embeddingProfile,
          k: 0,
        })
      ).toEqual({ hits: [], available: true });
      expect(
        await database.call("noteStoreRelated", {
          sourcePath: "source.md",
          profile: "other-profile",
          k: 5,
        })
      ).toEqual({ hits: [], available: false });
      expect(
        await database.call("noteStoreRelated", {
          sourcePath: "absent.md",
          profile: store.embeddingProfile,
          k: 10,
        })
      ).toEqual({ hits: [], available: false });
    } finally {
      db.close();
    }
  });
});
