import { describe, expect, it } from "vitest";
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { prepareNote } from "@/index/NotePassages";
import { noteEmbeddingProfile, SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { SqliteEmbeddingCache } from "@/index/SqliteEmbeddingCache";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { NoteStoreClient } from "@/index/note-sqlite/client";
import type {} from "@/index/note-sqlite/protocol";
import { loadTestSqlite, TestNoteWorker as LocalNoteWorker } from "./note-sqlite-test-client";

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

async function fixture(legacyMetadata = false) {
  const sqlite = await loadTestSqlite();
  const db = new sqlite.oo1.DB(":memory:", "c");
  if (legacyMetadata)
    db.exec(`CREATE TABLE note_index(
      note_id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, current_uid TEXT NOT NULL UNIQUE,
      embedding_profile TEXT, centroid BLOB, metadata TEXT
    )`);
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
  it("distinguishes endpoint variants without storing their raw values", () => {
    const base = "https://user:private-secret@embed.example.com/v1";
    const first = noteEmbeddingProfile({
      endpoint: `${base}?tenant=alpha#fragment-one`,
      modelId: " test-model ",
      dimensions: 2,
    });
    for (const endpoint of [
      `${base}?tenant=beta#fragment-one`,
      `${base}?tenant=alpha#fragment-two`,
      "https://user:other-secret@embed.example.com/v1?tenant=alpha#fragment-one",
    ]) {
      expect(noteEmbeddingProfile({ endpoint, modelId: " test-model ", dimensions: 2 })).not.toBe(
        first
      );
    }
    expect(first).not.toContain("private-secret");
    expect(first).not.toContain("tenant=alpha");
    expect(first).not.toContain("fragment-one");

    expect(
      noteEmbeddingProfile({
        endpoint: "http://127.0.0.1:1234/v1",
        modelId: " test-model ",
        dimensions: 2,
      })
    ).toBe(
      JSON.stringify({
        endpoint: "http://127.0.0.1:1234/v1",
        modelId: "test-model",
        dimensions: 2,
        splitter: "body-recursive-utf8-1000-codepoint-v1",
        preprocessing: "body-only-v1",
      })
    );
  });

  it("stores prepared passages in SQLite and hydrates live notes", async () => {
    const { db, client, store, embeddings, notes } = await fixture();
    try {
      const markdown = "# alpha\n\nalpha note body with searchable details.";
      notes.set("alpha.md", markdown);
      expect(await store.addDocuments([note("alpha.md", markdown)])).toEqual(["alpha.md"]);
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
      await client.close();
      db.close();
    }
  });

  it("upgrades release-shaped storage without discarding lexical data or cache", async () => {
    const sqlite = await loadTestSqlite();
    const db = new sqlite.oo1.DB(":memory:", "c");
    db.exec(
      "CREATE TABLE note_index(note_id INTEGER PRIMARY KEY,path TEXT NOT NULL UNIQUE,current_uid TEXT NOT NULL UNIQUE,embedding_profile TEXT,centroid BLOB)"
    );
    db.exec(
      "CREATE TABLE note_vectors(note_id INTEGER NOT NULL,ordinal INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(note_id,ordinal))"
    );
    db.exec(
      "CREATE VIRTUAL TABLE note_fts USING fts5(body,path_text,content='',contentless_delete=1,tokenize='unicode61 remove_diacritics 2')"
    );
    db.exec("INSERT INTO note_index VALUES(1,'old.md','old','release',NULL)");
    db.exec("INSERT INTO note_fts(rowid,body,path_text) VALUES(1,'old lexical sentinel','old.md')");
    db.exec(
      "CREATE TABLE embedding_cache(cache_id INTEGER PRIMARY KEY,profile TEXT NOT NULL,task TEXT NOT NULL,hash TEXT NOT NULL,vector BLOB NOT NULL,created_at INTEGER NOT NULL,UNIQUE(profile,task,hash))"
    );
    db.exec(
      "INSERT INTO embedding_cache(profile,task,hash,vector,created_at) VALUES('p','document','h',x'00000000',1)"
    );
    try {
      const database = new NoteSqliteDatabase(db);
      expect(db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'sentinel'")).toBe(
        1
      );
      expect(db.selectValue("SELECT count(*) FROM embedding_cache")).toBe(1);
      const store = new SqliteNoteVectorStore(
        new DeterministicEmbeddings(),
        database.call.bind(database),
        async () => null,
        { endpoint: "http://localhost/v1", modelId: "test", dimensions: 2 }
      );
      expect(store.embeddingProfile).not.toBe("release");
      await store.addDocuments([note("old.md", "# refreshed\n\nbody")]);
      expect(db.selectValue("SELECT start_offset FROM note_vectors")).toBe(0);
      expect(db.selectValue("SELECT count(*) FROM embedding_cache")).toBe(1);
      expect(db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'refreshed'")).toBe(
        1
      );
    } finally {
      db.close();
    }
  });

  it("applies official OpenAI request token and input caps offline", async () => {
    const batches: string[][] = [];
    const provider = {
      embedDocuments: async (texts: string[]) => {
        batches.push([...texts]);
        return texts.map(() => [1, 0]);
      },
      embedQuery: async () => [1, 0],
    };
    const store = new SqliteNoteVectorStore(
      provider,
      async () => undefined,
      async () => null,
      {
        endpoint: "https://api.openai.com/v1",
        modelId: "text-embedding-3-small",
        dimensions: 2,
      }
    );
    let state = 12345;
    const alphabet =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()[]{}<>?";
    const documents = Array.from({ length: 520 }, (_, index) => {
      let text = "<|endoftext|> ";
      while (text.length < 995) {
        state = (state * 16807) % 2147483647;
        text += alphabet[state % alphabet.length];
      }
      return note(`${index}.md`, text);
    });
    await store.addDocuments(documents);
    const { Tiktoken } = await import("js-tiktoken/lite");
    const { default: ranks } = await import("js-tiktoken/ranks/cl100k_base");
    const tokenizer = new Tiktoken(ranks);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches[0].length).toBeLessThanOrEqual(256);
    expect(
      batches.flat().reduce((sum, text) => sum + tokenizer.encode(text, [], []).length, 0)
    ).toBeGreaterThan(300000);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(256);
      expect(batch.every((text) => new TextEncoder().encode(text).length <= 1000)).toBe(true);
      const counts = batch.map((text) => tokenizer.encode(text, [], []).length);
      expect(Math.max(...counts)).toBeLessThanOrEqual(8191);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(300000);
    }
  });

  it("updates metadata and positions while reusing unchanged body embeddings", async () => {
    const { db, client, embeddings } = await fixture();
    const cache = new SqliteEmbeddingCache(embeddings, client.call, "cache-profile", 2);
    const store = new SqliteNoteVectorStore(cache, client.call, async () => null, {
      endpoint: "http://localhost/v1",
      modelId: "test",
      dimensions: 2,
    });
    try {
      const first = "---\naliases: [oldalias]\n---\n# Heading\n\nbody";
      const second = "---\naliases: [newalias]\ntags: [topic]\n---\n# Heading\n\nbody";
      await store.addDocuments([note("title.md", first)]);
      const start = Number(db.selectValue("SELECT start_offset FROM note_vectors LIMIT 1"));
      await store.addDocuments([note("title.md", second)]);
      expect(embeddings.calls).toHaveLength(1);
      expect(
        Number(db.selectValue("SELECT start_offset FROM note_vectors LIMIT 1"))
      ).toBeGreaterThan(start);
      expect(db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'newalias'")).toBe(
        1
      );
      expect(db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'oldalias'")).toBe(
        0
      );
      for (const term of ["title", "newalias", "topic"]) {
        expect(db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH ?", [term])).toBe(
          1
        );
      }
      expect(
        db.selectValue("SELECT count(*) FROM pragma_table_info('note_index') WHERE name='metadata'")
      ).toBe(0);
    } finally {
      await client.close();
      db.close();
    }
  });

  it("writes and updates notes with an existing nullable metadata column", async () => {
    const { db, client, store } = await fixture(true);
    try {
      await store.addDocuments([note("legacy.md", "---\naliases: [oldalias]\n---\nbody")]);
      await store.addDocuments([
        note("legacy.md", "---\naliases: [newalias]\ntags: [topic]\n---\nbody"),
      ]);
      expect(db.selectValue("SELECT metadata FROM note_index")).toBeNull();
      for (const term of ["legacy", "newalias", "topic"]) {
        expect(db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH ?", [term])).toBe(
          1
        );
      }
      expect(db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'oldalias'")).toBe(
        0
      );
    } finally {
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

  it("rejects invalid vectors and addVectors whose passages differ", async () => {
    const { db, client, store, notes } = await fixture();
    try {
      const markdown = `# long note\n\n${"counted note content ".repeat(900)}`;
      notes.set("long.md", markdown);
      const source = note("long.md", markdown);
      const split = (await prepareNote(markdown, "long.md")).passages;
      expect(split.length).toBeGreaterThan(1);
      const chunks = split.map(
        (part, ordinal) =>
          new Document({
            pageContent: part.text,
            metadata: { path: "long.md", ordinal },
          })
      );
      await expect(
        store.addVectors([[1, 0]], [chunks[0]], { note: source, ids: ["long"] })
      ).rejects.toThrow("Chunks must match prepared passages");
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
