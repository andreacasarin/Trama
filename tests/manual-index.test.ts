import { describe, expect, it } from "vitest";
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { ManualIndex, type ManualIndexNote, type ManualIndexVault } from "@/index/ManualIndex";
import { noteContentHash, SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { NoteStoreClient, type NoteStoreWorkerLike } from "@/index/note-sqlite/client";
import type { NoteStoreMethod, NoteStoreRpc } from "@/index/note-sqlite/protocol";
import { EmbeddingProviderError } from "@/model/LocalModels";
import { StructuredError } from "@/domain/errors";
import { loadTestSqlite } from "./note-sqlite-test-client";

class ManualEmbeddings implements EmbeddingsInterface<number[]> {
  calls: string[] = [];
  async embedDocuments(texts: string[], _signal?: AbortSignal): Promise<number[][]> {
    this.calls.push(...texts);
    return texts.map(() => [1, 0]);
  }
  async embedQuery(): Promise<number[]> {
    return [1, 0];
  }
  withSignal(signal?: AbortSignal): EmbeddingsInterface<number[]> {
    return {
      embedDocuments: (texts) => this.embedDocuments(texts, signal),
      embedQuery: () => this.embedQuery(),
    };
  }
}

class MemoryVault implements ManualIndexVault {
  listCalls = 0;
  constructor(readonly notes: Map<string, string>) {}
  async listMarkdownPaths(): Promise<string[]> {
    this.listCalls++;
    return [...this.notes.keys()].sort();
  }
  async readMarkdown(path: string): Promise<ManualIndexNote> {
    const content = this.notes.get(path);
    if (content === undefined) throw new Error(`Missing ${path}`);
    return { path, content };
  }
  async isMarkdownAvailable(path: string): Promise<boolean> {
    return this.notes.has(path);
  }
}

class LocalNoteWorker implements NoteStoreWorkerLike {
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  private readonly controllers = new Map<number, AbortController>();
  constructor(private readonly database: NoteSqliteDatabase) {}
  addEventListener(type: "message" | "error", listener: (event: any) => void): void {
    const group = this.listeners.get(type) ?? new Set();
    group.add(listener);
    this.listeners.set(type, group);
  }
  removeEventListener(type: "message" | "error", listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  postMessage(value: unknown): void {
    const request = value as { id: number; method: string; payload: unknown };
    if (request.method === "cancel") {
      this.controllers.get((request.payload as { requestId: number }).requestId)?.abort();
      return;
    }
    if (request.method === "init" || request.method === "close") {
      this.emit("message", { id: request.id, ok: true, result: undefined });
      return;
    }
    const controller = new AbortController();
    this.controllers.set(request.id, controller);
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
      .finally(() => this.controllers.delete(request.id));
  }
  private emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

async function setup(notes: Map<string, string>, embeddings = new ManualEmbeddings()) {
  const sqlite = await loadTestSqlite();
  const db = new sqlite.oo1.DB(":memory:", "c");
  const database = new NoteSqliteDatabase(db);
  const client = new NoteStoreClient(new LocalNoteWorker(database), "a".repeat(64));
  const vault = new MemoryVault(notes);
  const store = new SqliteNoteVectorStore(
    embeddings,
    client.call,
    async (path) => notes.get(path) ?? null,
    {
      endpoint: "http://127.0.0.1:1234/v1",
      modelId: "manual-test",
      dimensions: 2,
    }
  );
  return { db, database, client, store, embeddings, vault, manual: new ManualIndex(vault, store) };
}

describe("manual note indexing", () => {
  it("skips unchanged notes, updates edits, and removes deleted paths after one vault listing", async () => {
    const notes = new Map([
      ["a.md", "# alpha\n\nunchanged"],
      ["b.md", "# beta\n\nold"],
    ]);
    const { db, store, embeddings, vault, manual } = await setup(notes);
    try {
      for (const [path, content] of notes) await store.addDocuments([toDocument(path, content)]);
      await store.addDocuments([toDocument("removed.md", "# removed\n\nold")]);
      embeddings.calls = [];
      notes.set("b.md", "# beta\n\nnew content");
      const result = await manual.update();
      expect(vault.listCalls).toBe(1);
      expect(result.deleted).toBe(1);
      expect(embeddings.calls).toHaveLength(1);
      expect(await store.getEntry("removed.md")).toBeNull();
      expect((await store.getEntry("a.md"))?.profile).toBe(store.embeddingProfile);
    } finally {
      db.close();
    }
  });

  it("falls back after one provider failure and commits remaining notes lexical-only", async () => {
    const notes = new Map([
      ["a.md", "# alpha\n\nfirst"],
      ["b.md", "# beta\n\nprovider fails"],
      ["c.md", "# gamma\n\nno more calls"],
    ]);
    const embeddings = new ManualEmbeddings();
    let unavailable = true;
    embeddings.embedDocuments = async function (texts: string[]) {
      this.calls.push(...texts);
      if (unavailable && texts[0]?.includes("provider fails"))
        throw new EmbeddingProviderError("offline");
      return texts.map(() => [1, 0]);
    };
    const { db, store, manual } = await setup(notes, embeddings);
    try {
      const result = await manual.update();
      expect(result.lexicalOnly).toBe(true);
      expect(embeddings.calls).toHaveLength(2);
      expect(await store.getEntry("a.md")).toMatchObject({
        profile: store.embeddingProfile,
        vectorCount: 1,
      });
      expect(await store.getEntry("b.md")).toMatchObject({ profile: null, vectorCount: 0 });
      expect(await store.getEntry("c.md")).toMatchObject({ profile: null, vectorCount: 0 });
      expect(
        await db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'gamma'")
      ).toBe(1);
      unavailable = false;
      await manual.update();
      expect(embeddings.calls).toHaveLength(4);
      expect(await store.getEntry("b.md")).toMatchObject({
        profile: store.embeddingProfile,
        vectorCount: 1,
      });
      expect(await store.getEntry("c.md")).toMatchObject({
        profile: store.embeddingProfile,
        vectorCount: 1,
      });
    } finally {
      db.close();
    }
  });

  it("commits an edit made during embedding, rereads, and indexes the latest content", async () => {
    const notes = new Map([["edit.md", "# edit\n\nold text"]]);
    const embeddings = new ManualEmbeddings();
    const original = embeddings.embedDocuments.bind(embeddings);
    let changed = false;
    embeddings.embedDocuments = async (texts) => {
      const vectors = await original(texts);
      if (!changed) {
        changed = true;
        notes.set("edit.md", "# edit\n\nlatest text");
      }
      return vectors;
    };
    const { db, store, manual } = await setup(notes, embeddings);
    try {
      await manual.update();
      expect(embeddings.calls).toHaveLength(2);
      expect((await store.getEntry("edit.md"))?.hash).toBe(
        await noteContentHash(notes.get("edit.md")!)
      );
      expect(
        await db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'latest'")
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it("keeps the prior note when Update is cancelled during embedding", async () => {
    const notes = new Map([["cancel.md", "# old\n\nold committed"]]);
    const embeddings = new ManualEmbeddings();
    const { db, store, manual } = await setup(notes, embeddings);
    try {
      await store.addDocuments([toDocument("cancel.md", notes.get("cancel.md")!)]);
      const prior = await store.getEntry("cancel.md");
      notes.set("cancel.md", "# new\n\nnew pending");
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      embeddings.embedDocuments = async (_texts, signal) =>
        await new Promise<number[][]>((_resolve, reject) => {
          entered();
          signal?.addEventListener(
            "abort",
            () => reject(new StructuredError("cancelled", "cancelled", false)),
            { once: true }
          );
        });
      const pending = manual.update();
      await started;
      manual.cancel();
      await expect(pending).rejects.toMatchObject({ code: "cancelled" });
      expect(await store.getEntry("cancel.md")).toEqual(prior);
      expect(
        await db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'committed'")
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it("leaves completed notes after a cancelled rebuild and permits only one active run", async () => {
    const notes = new Map([
      ["a.md", "# a\n\nfirst complete"],
      ["b.md", "# b\n\nsecond pending"],
    ]);
    const embeddings = new ManualEmbeddings();
    const { db, store, manual } = await setup(notes, embeddings);
    try {
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      embeddings.embedDocuments = async function (texts, signal) {
        this.calls.push(...texts);
        if (texts[0]?.includes("second pending")) {
          entered();
          return new Promise<number[][]>((_resolve, reject) =>
            signal?.addEventListener(
              "abort",
              () => reject(new StructuredError("cancelled", "cancelled", false)),
              { once: true }
            )
          );
        }
        return texts.map(() => [1, 0]);
      };
      const pending = manual.rebuild();
      await started;
      await expect(manual.update()).rejects.toThrow(/already active/i);
      manual.cancel();
      await expect(pending).rejects.toMatchObject({ code: "cancelled" });
      expect(await store.getEntry("a.md")).not.toBeNull();
      expect(await store.getEntry("b.md")).toBeNull();
    } finally {
      db.close();
    }
  });
});

function toDocument(path: string, content: string) {
  return new Document({ id: path, pageContent: content, metadata: { path } });
}
