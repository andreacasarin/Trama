import { it, expect } from "vitest";
import { ManualIndex } from "@/index/ManualIndex";
import { SqliteNoteRecordManager } from "@/index/SqliteNoteRecordManager";
import { SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { ObsidianIndexVault } from "@/vault/indexing/ObsidianIndexVault";
import { loadTestSqlite } from "./note-sqlite-test-client";
// @ts-expect-error Pinned workload is shared with the app benchmark.
import { createPerformanceCorpus } from "../scripts/benchmark/performance-fixture.mjs";

it("measures unchanged indexing on the pinned 3000-note workload", async () => {
  const sqlite = await loadTestSqlite();
  const connection = new sqlite.oo1.DB(":memory:", "c");
  const database = new NoteSqliteDatabase(connection);
  const { notes } = createPerformanceCorpus();
  const files = new Map<string, any>(
    notes.map((note: { path: string; content: string }) => [
      note.path,
      { ...note, stat: { mtime: 1, ctime: 1, size: note.content.length } },
    ])
  );
  let reads = 0;
  let providerCalls = 0;
  const vault = new ObsidianIndexVault({
    getMarkdownFiles: () => [...files.values()],
    getFileByPath: (path) => files.get(path) ?? null,
    read: async (file) => {
      reads++;
      return files.get(file.path).content;
    },
  });
  const embeddings = {
    embedDocuments: async (texts: string[]) => {
      providerCalls++;
      return texts.map(() => [1, 0]);
    },
    embedQuery: async () => [1, 0],
  };
  const store = new SqliteNoteVectorStore(
    embeddings,
    database.call.bind(database),
    async (path) => files.get(path)?.content ?? null,
    { endpoint: "http://localhost/v1", modelId: "benchmark", dimensions: 2 }
  );
  const records = new SqliteNoteRecordManager(database.call.bind(database));
  try {
    await new ManualIndex(vault, store, records).update();
    const calls = providerCalls;
    const samples = [];
    for (let sample = 0; sample < 3; sample++) {
      reads = 0;
      const started = performance.now();
      const result = await new ManualIndex(vault, store, records).update();
      samples.push(performance.now() - started);
      expect(result.numSkipped).toBe(3000);
      expect(reads).toBe(0);
      expect(providerCalls).toBe(calls);
    }
    console.log(
      JSON.stringify({
        workload: "3000 notes, 400 characters, 2 dimensions",
        samples,
        unchangedReads: reads,
      })
    );
    // Content reconciliation must still detect edits when file metadata is unchanged.
    const changed = files.get("notes/0000.md")!;
    changed.content = "Changed content with unchanged metadata";
    reads = 0;
    const reconciled = await new ManualIndex(vault, store, records).update(true);
    expect(reads).toBe(3000);
    expect(reconciled.numAdded).toBe(1);
    expect(reconciled.numSkipped).toBe(2999);
  } finally {
    connection.close();
  }
}, 30_000);
