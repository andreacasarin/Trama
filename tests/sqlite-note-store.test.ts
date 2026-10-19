import { describe, expect, it, vi } from "vitest";
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { MarkdownTextSplitter } from "@langchain/textsplitters";
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

class LocalNoteWorker implements NoteStoreWorkerLike {
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  constructor(private readonly database: NoteSqliteDatabase) {}
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void) {
    const group = this.listeners.get(type) ?? new Set();
    group.add(listener);
    this.listeners.set(type, group);
  }
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  postMessage(raw: unknown): void {
    const request = raw as { id: number; method: string; payload: unknown };
    if (request.method === "init" || request.method === "close") {
      this.emit({ id: request.id, ok: true, result: undefined });
      return;
    }
    if (request.method === "cancel") return;
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
    for (const listener of this.listeners.get("message") ?? []) listener({ data });
  }
}

async function fixture() {
  const sqlite = await loadTestSqlite();
  const db = new sqlite.oo1.DB(":memory:", "c");
  const database = new NoteSqliteDatabase(db);
  const client = new NoteStoreClient(new LocalNoteWorker(database), "a".repeat(64));
  const embeddings = new DeterministicEmbeddings();
  const notes = new Map<string, string>();
  const profile = {
    endpoint: "http://127.0.0.1:1234/v1",
    modelId: "test-model",
    dimensions: 2,
  };
  const store = new SqliteNoteVectorStore(
    embeddings,
    client.call,
    async (path) => notes.get(path) ?? null,
    profile
  );
  return { db, database, client, store, embeddings, notes };
}

const note = (path: string, pageContent: string, embeddingProfile?: string) =>
  new Document({
    id: path,
    pageContent,
    metadata: { path, ...(embeddingProfile ? { embeddingProfile } : {}) },
  });

describe("SQLite note vector store", () => {
  it("uses the default Markdown split once, stores vectors in SQLite, and hydrates live notes", async () => {
    const { db, client, store, embeddings, notes } = await fixture();
    const split = vi.spyOn(MarkdownTextSplitter.prototype, "splitDocuments");
    try {
      const markdown = "# alpha\n\nalpha note body with searchable details.";
      notes.set("alpha.md", markdown);
      expect(await store.addDocuments([note("alpha.md", markdown)])).toEqual(["alpha.md"]);
      expect(split).toHaveBeenCalledOnce();
      expect(embeddings.calls).toHaveLength(1);
      expect(db.selectValue("SELECT body IS NULL FROM note_fts WHERE rowid=1")).toBe(1);
      expect(
        db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'searchable'")
      ).toBe(1);
      expect(db.selectValue("SELECT count(*) FROM note_vectors")).toBe(embeddings.calls[0].length);
      const [hit] = await store.similaritySearchVectorWithScore([1, 0], 4);
      expect(hit[0].metadata.path).toBe("alpha.md");
      expect(hit[0].pageContent).toBe(markdown);
      expect(hit[1]).toBeCloseTo(1);
    } finally {
      split.mockRestore();
      await client.close();
      db.close();
    }
  });

  it("replaces one UID atomically and deletes only the matching current UID", async () => {
    const { db, client, store, notes } = await fixture();
    try {
      const prior = "# alpha\n\nold alpha text";
      notes.set("note.md", prior);
      await store.addDocuments([note("note.md", prior)]);
      const firstUid = String(db.selectValue("SELECT current_uid FROM note_index"));
      const priorRecordTime = db.selectValue("SELECT updated_at FROM note_records WHERE uid=?", [
        firstUid,
      ]);
      const priorClock = db.selectValue("SELECT value FROM note_record_clock WHERE id=1");

      db.exec(
        "CREATE TRIGGER reject_note_vector BEFORE INSERT ON note_vectors BEGIN SELECT RAISE(ABORT,'fixture failure'); END"
      );
      await expect(
        store.addDocuments([note("note.md", "# beta\n\nnew beta text")])
      ).rejects.toThrow();
      db.exec("DROP TRIGGER reject_note_vector");
      expect(db.selectValue("SELECT current_uid FROM note_index")).toBe(firstUid);
      expect(db.selectValue("SELECT updated_at FROM note_records WHERE uid=?", [firstUid])).toBe(
        priorRecordTime
      );
      expect(db.selectValue("SELECT value FROM note_record_clock WHERE id=1")).toBe(priorClock);
      expect(db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'old'")).toBe(1);
      expect(db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'new'")).toBe(0);

      const replacement = "# beta\n\nnew beta text";
      notes.set("note.md", replacement);
      await store.addDocuments([note("note.md", replacement)]);
      const currentUid = String(db.selectValue("SELECT current_uid FROM note_index"));
      expect(currentUid).toBe(firstUid);
      await store.delete({ ids: ["stale-uid"] });
      expect(db.selectValue("SELECT current_uid FROM note_index")).toBe(currentUid);
      await store.delete({ ids: [currentUid] });
      expect(db.selectValue("SELECT count(*) FROM note_index")).toBe(0);
      expect(db.selectValue("SELECT count(*) FROM note_vectors")).toBe(0);
    } finally {
      await client.close();
      db.close();
    }
  });

  it("filters semantic results by profile and tolerates zero-chunk notes", async () => {
    const { db, client, database, store, embeddings, notes } = await fixture();
    try {
      notes.set("blank.md", "");
      await store.addDocuments([note("blank.md", "")]);
      expect(embeddings.calls).toHaveLength(0);
      expect(db.selectValue("SELECT embedding_profile FROM note_index WHERE path='blank.md'")).toBe(
        store.embeddingProfile
      );
      const other = `${store.embeddingProfile} other`;
      expect(
        await database.call("noteStoreSemantic", { vector: [1, 0], profile: other, k: 5 })
      ).toEqual([]);
    } finally {
      await client.close();
      db.close();
    }
  });

  it("rejects invalid vectors and addVectors whose count differs from the default split", async () => {
    const { db, client, store, notes } = await fixture();
    try {
      const markdown = `# long note\n\n${"counted note content ".repeat(900)}`;
      notes.set("long.md", markdown);
      const source = note("long.md", markdown);
      const split = await new MarkdownTextSplitter().splitDocuments([source]);
      expect(split.length).toBeGreaterThan(1);
      const chunks = split.map(
        (part, ordinal) =>
          new Document({
            pageContent: part.pageContent,
            metadata: { path: "long.md", ordinal },
          })
      );
      await expect(
        store.addVectors([[1, 0]], [chunks[0]], { note: source, ids: ["long"] })
      ).rejects.toThrow("Chunk and vector counts differ");
      await expect(
        store.addVectors(
          chunks.map(() => [1, Number.NaN]),
          chunks,
          { note: source }
        )
      ).rejects.toThrow(/finite/);
      expect(db.selectValue("SELECT count(*) FROM note_index")).toBe(0);
      await store.addVectors(
        chunks.map(() => [0, 1]),
        chunks,
        { note: source, ids: ["long"] }
      );
      expect(db.selectValue("SELECT count(*) FROM note_vectors")).toBe(chunks.length);
    } finally {
      await client.close();
      db.close();
    }
  });
});
