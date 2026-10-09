import { describe, expect, it } from "vitest";
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { NoteStoreClient, type NoteStoreWorkerLike } from "@/index/note-sqlite/client";
import type { NoteStoreMethod, NoteStoreRpc } from "@/index/note-sqlite/protocol";
import { loadTestSqlite } from "./note-sqlite-test-client";

class DeterministicEmbeddings implements EmbeddingsInterface<number[]> {
  calls: string[][] = [];
  async embedDocuments(inputs: string[]): Promise<number[][]> {
    this.calls.push(inputs);
    return inputs.map((text) => (text.toLowerCase().includes("alpha") ? [1, 0] : [0, 1]));
  }
  async embedQuery(text: string): Promise<number[]> {
    return text.includes("alpha") ? [1, 0] : [0, 1];
  }
}

async function fixture() {
  const sqlite = await loadTestSqlite();
  const db = new sqlite.oo1.DB(":memory:", "c");
  const database = new NoteSqliteDatabase(db);
  const worker = new LocalNoteWorker(database);
  const client = new NoteStoreClient(worker, "a".repeat(64));
  const embeddings = new DeterministicEmbeddings();
  const store = new SqliteNoteVectorStore(
    embeddings,
    client.call,
    async (path) => notes.get(path) ?? null,
    {
      endpoint: "http://127.0.0.1:1234/v1",
      modelId: "test-model",
      dimensions: 2,
    }
  );
  const notes = new Map<string, string>();
  return { db, database, client, store, embeddings, notes };
}

class LocalNoteWorker implements NoteStoreWorkerLike {
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  private readonly requests = new Map<number, AbortController>();
  constructor(private readonly database: NoteSqliteDatabase) {}
  addEventListener(type: "message" | "error", listener: (event: any) => void): void {
    const group = this.listeners.get(type) ?? new Set();
    group.add(listener);
    this.listeners.set(type, group);
  }
  removeEventListener(type: "message" | "error", listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  postMessage(message: unknown): void {
    const request = message as { id: number; method: string; payload: unknown };
    if (request.method === "cancel") {
      this.requests.get((request.payload as { requestId: number }).requestId)?.abort();
      return;
    }
    if (request.method === "init" || request.method === "close") {
      this.emit("message", { id: request.id, ok: true, result: undefined });
      return;
    }
    const controller = new AbortController();
    this.requests.set(request.id, controller);
    void this.database
      .call(
        request.method as NoteStoreMethod,
        request.payload as NoteStoreRpc[NoteStoreMethod],
        controller.signal
      )
      .then((result) => this.emit("message", { id: request.id, ok: true, result }))
      .catch((error) =>
        this.emit("message", {
          id: request.id,
          ok: false,
          error: { name: error.name, message: error.message },
        })
      )
      .finally(() => this.requests.delete(request.id));
  }
  private emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

describe("SQLite note vector store", () => {
  it("writes default-split vectors once, skips only complete matches, and hydrates ranked live notes", async () => {
    const { db, store, embeddings, notes } = await fixture();
    try {
      const markdown = "# alpha\n\nalpha note body with searchable details.";
      notes.set("alpha.md", markdown);
      const note = new Document({
        id: "alpha.md",
        pageContent: markdown,
        metadata: { path: "alpha.md" },
      });
      expect(await store.addDocuments([note])).toEqual(["alpha.md"]);
      expect(embeddings.calls).toHaveLength(1);
      expect(await store.addDocuments([note])).toEqual(["alpha.md"]);
      expect(embeddings.calls).toHaveLength(1);
      const [hit] = await store.similaritySearchVectorWithScore([1, 0], 4);
      expect(hit[0].metadata.path).toBe("alpha.md");
      expect(hit[0].pageContent).toBe(markdown);
      expect(hit[1]).toBeCloseTo(1);
      expect(db.selectValue("SELECT body IS NULL FROM note_fts WHERE rowid=1")).toBe(1);
      expect(
        db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'searchable'")
      ).toBe(1);
      expect(db.selectValue("SELECT count(*) FROM note_vectors")).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("rolls back a failed replacement and removes vector/FTS rows when deleted", async () => {
    const { db, store, notes } = await fixture();
    try {
      const oldText = "# alpha\n\nold alpha text";
      notes.set("note.md", oldText);
      await store.addDocuments([
        new Document({ id: "note.md", pageContent: oldText, metadata: { path: "note.md" } }),
      ]);
      const priorHash = db.selectValue("SELECT source_hash FROM note_index WHERE path='note.md'");
      db.exec(
        "CREATE TRIGGER reject_note_vector BEFORE INSERT ON note_vectors BEGIN SELECT RAISE(ABORT,'fixture failure'); END"
      );
      const nextText = "# beta\n\nnew beta text";
      await expect(
        store.addDocuments([
          new Document({ id: "note.md", pageContent: nextText, metadata: { path: "note.md" } }),
        ])
      ).rejects.toThrow();
      db.exec("DROP TRIGGER reject_note_vector");
      const old = db.selectValue("SELECT source_hash FROM note_index WHERE path='note.md'");
      expect(old).toBe(priorHash);
      expect(db.selectValue("SELECT count(*) FROM note_vectors")).toBeGreaterThan(0);
      expect(db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'old'")).toBe(1);
      expect(db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'new'")).toBe(0);
      await store.delete({ ids: ["note.md"] });
      expect(db.selectValue("SELECT count(*) FROM note_index")).toBe(0);
      expect(db.selectValue("SELECT count(*) FROM note_vectors")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("stores zero-chunk notes without embedding and filters semantic results by profile", async () => {
    const { db, database, store, embeddings, notes } = await fixture();
    try {
      const blank = new Document({
        id: "blank.md",
        pageContent: "",
        metadata: { path: "blank.md" },
      });
      notes.set("blank.md", "");
      await store.addDocuments([blank]);
      expect(embeddings.calls).toHaveLength(0);
      expect(await database.call("noteStoreGet", { path: "blank.md" })).toMatchObject({
        chunkCount: 0,
        vectorCount: 0,
      });
      const profile = JSON.parse((store as any).profile);
      const other = JSON.stringify({ ...profile, modelId: "other" });
      expect(
        await database.call("noteStoreSemantic", { vector: [1, 0], profile: other, k: 5 })
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("re-embeds incomplete or profile-mismatched notes and keeps embedding batches bounded", async () => {
    const { db, database, store, embeddings, notes } = await fixture();
    try {
      const markdown = "# recovered\n\nalpha data";
      notes.set("recover.md", markdown);
      const note = new Document({
        id: "recover.md",
        pageContent: markdown,
        metadata: { path: "recover.md" },
      });
      await store.addDocuments([note]);
      db.exec("DELETE FROM note_vectors");
      await store.addDocuments([note]);
      expect(embeddings.calls).toHaveLength(2);
      const otherProfile = new SqliteNoteVectorStore(
        embeddings,
        (method, payload, signal) => database.call(method, payload, signal),
        async (path) => notes.get(path) ?? null,
        {
          endpoint: "http://127.0.0.1:1234/v1",
          modelId: "changed",
          dimensions: 2,
        }
      );
      await otherProfile.addDocuments([note]);
      expect(embeddings.calls).toHaveLength(3);

      const batchMarkdown = `# batch\n\n${("word ".repeat(200) + "\n\n").repeat(520)}`;
      notes.set("batch.md", batchMarkdown);
      await store.addDocuments([
        new Document({
          id: "batch.md",
          pageContent: batchMarkdown,
          metadata: { path: "batch.md" },
        }),
      ]);
      expect(embeddings.calls.slice(3).length).toBeGreaterThan(1);
      expect(embeddings.calls.slice(3).every((batch) => batch.length <= 512)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("honors cancellation before an atomic replacement", async () => {
    const { db, store, notes } = await fixture();
    try {
      const priorText = "# prior\n\nalpha prior content";
      notes.set("cancel.md", priorText);
      const note = new Document({
        id: "cancel.md",
        pageContent: priorText,
        metadata: { path: "cancel.md" },
      });
      await store.addDocuments([note]);
      const controller = new AbortController();
      controller.abort();
      const replacement = "# replacement\n\nbeta replacement";
      await expect(
        store.addDocuments(
          [
            new Document({
              id: "cancel.md",
              pageContent: replacement,
              metadata: { path: "cancel.md" },
            }),
          ],
          { signal: controller.signal }
        )
      ).rejects.toThrow();
      expect(db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'prior'")).toBe(1);
      expect(
        db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'replacement'")
      ).toBe(0);

      const afterCommit = new AbortController();
      const committed = "# committed\n\nalpha committed content";
      notes.set("committed.md", committed);
      await store.addDocuments(
        [
          new Document({
            id: "committed.md",
            pageContent: committed,
            metadata: { path: "committed.md" },
          }),
        ],
        { signal: afterCommit.signal }
      );
      afterCommit.abort();
      expect(db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'committed'")).toBe(
        1
      );
    } finally {
      db.close();
    }
  });

  it("rejects non-finite vectors without replacing a complete note", async () => {
    const { db, store, notes } = await fixture();
    try {
      const markdown = "# stable\n\nstable note contents";
      notes.set("stable.md", markdown);
      const note = new Document({
        id: "stable.md",
        pageContent: markdown,
        metadata: { path: "stable.md" },
      });
      await store.addDocuments([note]);
      const priorHash = db.selectValue("SELECT source_hash FROM note_index WHERE path='stable.md'");
      const chunk = new Document({
        pageContent: "stable note contents",
        metadata: { path: "stable.md", ordinal: 0 },
      });
      await expect(store.addVectors([[1, Number.NaN]], [chunk], { note })).rejects.toThrow(
        /finite/
      );
      expect(db.selectValue("SELECT source_hash FROM note_index WHERE path='stable.md'")).toBe(
        priorHash
      );
      expect(db.selectValue("SELECT count(*) FROM note_vectors")).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
