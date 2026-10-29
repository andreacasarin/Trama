import { performance } from "node:perf_hooks";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { ManualIndex, type ManualIndexVault } from "@/index/ManualIndex";
import { SqliteNoteRecordManager } from "@/index/SqliteNoteRecordManager";
import { SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { VaultRetrieval } from "@/index/VaultRetrieval";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { NoteStoreClient } from "@/index/note-sqlite/client";
import type {} from "@/index/note-sqlite/protocol";
import { loadTestSqlite, TestNoteWorker as Worker } from "./note-sqlite-test-client";

class WorkloadEmbeddings implements EmbeddingsInterface<number[]> {
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) => vector(text));
  }
  async embedQuery(text: string): Promise<number[]> {
    return vector(text);
  }
}

describe("V1 same-corpus indexing and retrieval workload", () => {
  it("indexes the committed 24-note corpus and measures one native hybrid query", async () => {
    const corpus = resolve(
      fileURLToPath(new URL("../test-vaults/benchmark/trama-small/", import.meta.url))
    );
    const notes = new Map<string, string>();
    for (const file of await markdownFiles(corpus))
      notes.set(relative(corpus, file).split("\\").join("/"), await readFile(file, "utf8"));
    const sqlite = await loadTestSqlite();
    const db = new sqlite.oo1.DB(":memory:", "c");
    try {
      const database = new NoteSqliteDatabase(db);
      const client = new NoteStoreClient(new Worker(database), "a".repeat(64));
      const profile = {
        endpoint: "http://127.0.0.1:1234/v1",
        modelId: "workload-fixture",
        dimensions: 2,
      };
      const embeddings = new WorkloadEmbeddings();
      const store = new SqliteNoteVectorStore(
        embeddings,
        client.call,
        async (path) => notes.get(path) ?? null,
        profile
      );
      const vault: ManualIndexVault = {
        listMarkdownPaths: async () => [...notes.keys()].sort(),
        readMarkdown: async (path) => ({ path, content: notes.get(path)! }),
      };
      const started = performance.now();
      const indexed = await new ManualIndex(
        vault,
        store,
        new SqliteNoteRecordManager(client.call)
      ).update();
      const indexMs = performance.now() - started;
      expect(indexed.visited).toBe(24);
      expect(indexed.deleted).toBe(0);
      expect(Number(db.selectValue("SELECT count(*) FROM note_index"))).toBe(24);
      const databaseBytes =
        Number(db.selectValue("PRAGMA page_count")) * Number(db.selectValue("PRAGMA page_size"));
      expect(databaseBytes).toBeGreaterThan(0);
      expect(db.selectValue("SELECT body FROM note_fts LIMIT 1")).toBeNull();

      const retrieval = new VaultRetrieval(
        client.call,
        embeddings,
        store.embeddingProfile,
        async (path) => {
          const content = notes.get(path);
          return content === undefined ? null : { path, content };
        }
      );
      const queryStarted = performance.now();
      const result = await retrieval.runnable.invoke({ query: "anchor alpha", mode: "hybrid" });
      const queryMs = performance.now() - queryStarted;
      expect(result.status).toEqual({ mode: "hybrid", degraded: false });
      expect(result.documents.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain("vector");
      console.info(
        `V1 workload: ${notes.size} notes, ${Number(db.selectValue("SELECT count(*) FROM note_vectors"))} vectors, ${databaseBytes} SQLite bytes, index ${indexMs.toFixed(1)} ms, query ${queryMs.toFixed(1)} ms, ${result.documents.length} hydrated results`
      );
    } finally {
      db.close();
    }
  });
});

async function markdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(path);
  }
  return files.sort();
}

function vector(text: string): number[] {
  return text.toLowerCase().includes("anchor") || text.toLowerCase().includes("alpha")
    ? [1, 0]
    : [0, 1];
}
