import { describe, expect, it } from "vitest";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { ManualIndex, type ManualIndexNote, type ManualIndexVault } from "@/index/ManualIndex";
import { SqliteNoteRecordManager } from "@/index/SqliteNoteRecordManager";
import { SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { NoteStoreClient, type NoteStoreWorkerLike } from "@/index/note-sqlite/client";
import type { NoteStoreMethod, NoteStoreRpc, NoteStoreCall } from "@/index/note-sqlite/protocol";
import { loadTestSqlite } from "./note-sqlite-test-client";

class TestEmbeddings implements EmbeddingsInterface<number[]> {
  calls = 0;
  fail = false;
  async embedDocuments(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    this.calls++;
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    if (this.fail) throw new Error("provider offline");
    return texts.map(() => [1, 0]);
  }
  async embedQuery(): Promise<number[]> {
    return [1, 0];
  }
  withSignal(signal?: AbortSignal): EmbeddingsInterface<number[]> {
    return {
      embedDocuments: async (texts) => {
        if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
        return this.embedDocuments(texts, signal);
      },
      embedQuery: () => this.embedQuery(),
    };
  }
}

class MemoryVault implements ManualIndexVault {
  reads: string[] = [];
  constructor(readonly notes: Map<string, string>) {}
  async listMarkdownPaths(): Promise<string[]> {
    return [...this.notes.keys()].sort();
  }
  async readMarkdown(path: string): Promise<ManualIndexNote> {
    this.reads.push(path);
    const content = this.notes.get(path);
    if (content === undefined) throw new Error(`Missing ${path}`);
    return { path, content };
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

async function setup(notes: Map<string, string>, embeddings = new TestEmbeddings()) {
  const sqlite = await loadTestSqlite();
  const db = new sqlite.oo1.DB(":memory:", "c");
  const database = new NoteSqliteDatabase(db);
  const client = new NoteStoreClient(new LocalNoteWorker(database), "a".repeat(64));
  const vault = new MemoryVault(notes);
  const profile = {
    endpoint: "http://127.0.0.1:1234/v1",
    modelId: "manual-test",
    dimensions: 2,
  };
  const store = new SqliteNoteVectorStore(
    embeddings,
    client.call,
    async (path) => notes.get(path) ?? null,
    profile
  );
  const records = new SqliteNoteRecordManager(client.call);
  return {
    db,
    database,
    client,
    store,
    records,
    embeddings,
    vault,
    manual: new ManualIndex(vault, store, records),
  };
}

function interruptAfterNoteCommit(
  client: NoteStoreClient,
  embeddings: EmbeddingsInterface<number[]>,
  notes: Map<string, string>,
  profile: string
): SqliteNoteVectorStore {
  let interrupt = true;
  const call: NoteStoreCall = async (method, payload, signal) => {
    const result = await client.call(method, payload, signal);
    if (method === "noteStoreReplace" && interrupt) {
      interrupt = false;
      throw new Error("interrupted before native record update");
    }
    return result;
  };
  return new SqliteNoteVectorStore(
    embeddings,
    call,
    async (path) => notes.get(path) ?? null,
    profile
  );
}

describe("native LangChain note indexing", () => {
  it("uses record UIDs to skip unchanged notes and clean deleted notes", async () => {
    const notes = new Map([
      ["a.md", "# alpha\n\nunchanged"],
      ["b.md", "# beta\n\nold"],
    ]);
    const { db, client, records, embeddings, vault, manual } = await setup(notes);
    try {
      const first = await manual.update();
      expect(first.numAdded).toBe(2);
      const calls = embeddings.calls;
      expect((await manual.update()).numSkipped).toBe(2);
      expect(embeddings.calls).toBe(calls);

      notes.set("b.md", "# beta\n\nnew content");
      notes.delete("a.md");
      const changed = await manual.update();
      expect(changed.numAdded).toBe(1);
      expect(changed.deleted).toBe(2);
      expect(vault.reads).toEqual(["a.md", "b.md", "a.md", "b.md", "b.md"]);
      expect(await db.selectValue("SELECT count(*) FROM note_index")).toBe(1);
      expect(await db.selectValue("SELECT count(*) FROM note_records")).toBe(1);
      expect(await db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH 'new'")).toBe(
        1
      );
      const currentUid = String(await db.selectValue("SELECT current_uid FROM note_index"));
      expect(
        await db.selectValue("SELECT group_path FROM note_records WHERE uid=?", [currentUid])
      ).toBe("b.md");
      expect(await records.exists([currentUid])).toEqual([true]);
    } finally {
      await client.close();
      db.close();
    }
  });

  it("stops on embedding errors and retries on the next native index run", async () => {
    const notes = new Map([["a.md", "# alpha\n\nretry me"]]);
    const embeddings = new TestEmbeddings();
    const { db, client, store, manual } = await setup(notes, embeddings);
    try {
      embeddings.fail = true;
      await expect(manual.update()).rejects.toThrow("provider offline");
      expect(await db.selectValue("SELECT count(*) FROM note_index")).toBe(0);
      embeddings.fail = false;
      expect((await manual.update()).numAdded).toBe(1);
      expect(await db.selectValue("SELECT count(*) FROM note_index")).toBe(1);
      expect(await db.selectValue("SELECT count(*) FROM note_vectors")).toBeGreaterThan(0);
      expect(store.embeddingProfile).toContain("manual-test");
    } finally {
      await client.close();
      db.close();
    }
  });

  it("reindexes a note when its embedding profile changes", async () => {
    const notes = new Map([["profile.md", "# profile\n\nkeep this note"]]);
    const { db, client, records, embeddings, vault, manual } = await setup(notes);
    try {
      await manual.update();
      const priorUid = String(await db.selectValue("SELECT current_uid FROM note_index"));
      const nextProfile = {
        endpoint: "http://127.0.0.1:1234/v1",
        modelId: "changed-profile",
        dimensions: 2,
      };
      const nextStore = new SqliteNoteVectorStore(
        embeddings,
        client.call,
        async (path) => notes.get(path) ?? null,
        nextProfile
      );
      const result = await new ManualIndex(vault, nextStore, records).update();
      expect(result.numAdded).toBe(1);
      expect(result.deleted).toBe(1);
      expect(String(await db.selectValue("SELECT current_uid FROM note_index"))).not.toBe(priorUid);
      expect(await db.selectValue("SELECT embedding_profile FROM note_index")).toBe(
        nextStore.embeddingProfile
      );
      expect(embeddings.calls).toBe(2);
    } finally {
      await client.close();
      db.close();
    }
  });

  it("cleans a new note deleted immediately after its native record update is interrupted", async () => {
    const notes = new Map([["gap.md", "# gap\n\ncommitted before native record update"]]);
    const { db, client, store, records, embeddings, vault, manual } = await setup(notes);
    try {
      const interruptedStore = interruptAfterNoteCommit(
        client,
        embeddings,
        notes,
        store.embeddingProfile
      );
      await expect(new ManualIndex(vault, interruptedStore, records).update()).rejects.toThrow(
        "interrupted before native record update"
      );
      const uid = String(await db.selectValue("SELECT current_uid FROM note_index"));
      expect(await records.exists([uid])).toEqual([true]);
      expect(await db.selectValue("SELECT group_path FROM note_records WHERE uid=?", [uid])).toBe(
        "gap.md"
      );
      notes.delete("gap.md");
      expect((await manual.update()).deleted).toBe(1);
      expect(await db.selectValue("SELECT count(*) FROM note_index")).toBe(0);
      expect(await db.selectValue("SELECT count(*) FROM note_records")).toBe(0);
      expect(await db.selectValue("SELECT count(*) FROM note_vectors")).toBe(0);
      expect(await db.selectValue("SELECT count(*) FROM note_fts")).toBe(0);
    } finally {
      await client.close();
      db.close();
    }
  });

  it("cleans a replacement deleted immediately after its native record update is interrupted", async () => {
    const notes = new Map([["gap.md", "# gap\n\nprior committed version"]]);
    const { db, client, store, records, embeddings, vault, manual } = await setup(notes);
    try {
      await manual.update();
      const priorUid = String(await db.selectValue("SELECT current_uid FROM note_index"));
      notes.set("gap.md", "# gap\n\nreplacement committed before record update");
      const interruptedStore = interruptAfterNoteCommit(
        client,
        embeddings,
        notes,
        store.embeddingProfile
      );
      await expect(new ManualIndex(vault, interruptedStore, records).update()).rejects.toThrow(
        "interrupted before native record update"
      );
      const uid = String(await db.selectValue("SELECT current_uid FROM note_index"));
      expect(uid).not.toBe(priorUid);
      expect(await records.exists([uid])).toEqual([true]);
      expect(await db.selectValue("SELECT count(*) FROM note_records")).toBe(2);

      notes.delete("gap.md");
      expect((await manual.update()).deleted).toBe(2);
      expect(await db.selectValue("SELECT count(*) FROM note_index")).toBe(0);
      expect(await db.selectValue("SELECT count(*) FROM note_records")).toBe(0);
      expect(await db.selectValue("SELECT count(*) FROM note_vectors")).toBe(0);
      expect(await db.selectValue("SELECT count(*) FROM note_fts")).toBe(0);
    } finally {
      await client.close();
      db.close();
    }
  });

  it("skips re-embedding when a committed note survives interruption before native record update", async () => {
    const notes = new Map([["gap.md", "# gap\n\ncommitted before native record update"]]);
    const { db, client, store, records, embeddings, vault, manual } = await setup(notes);
    try {
      const interruptedStore = interruptAfterNoteCommit(
        client,
        embeddings,
        notes,
        store.embeddingProfile
      );
      await expect(new ManualIndex(vault, interruptedStore, records).update()).rejects.toThrow(
        "interrupted before native record update"
      );
      const calls = embeddings.calls;
      expect((await manual.update()).numSkipped).toBe(1);
      expect(embeddings.calls).toBe(calls);
    } finally {
      await client.close();
      db.close();
    }
  });

  it("keeps earlier committed notes when a later note is cancelled and skips final cleanup", async () => {
    const notes = new Map([
      ["a.md", "# a\n\ncommitted first note"],
      ["b.md", "# b\n\nhold the second note"],
    ]);
    const embeddings = new TestEmbeddings();
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => (entered = resolve));
    embeddings.embedDocuments = async (texts, signal) => {
      embeddings.calls++;
      if (texts.some((text) => text.includes("hold the second"))) {
        entered();
        return await new Promise<number[][]>((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            {
              once: true,
            }
          )
        );
      }
      return texts.map(() => [1, 0]);
    };
    const { db, client, manual } = await setup(notes, embeddings);
    try {
      const run = manual.update();
      await blocked;
      manual.cancel();
      await expect(run).rejects.toMatchObject({ name: "AbortError" });
      expect(await db.selectValue("SELECT count(*) FROM note_index")).toBe(1);
      expect(await db.selectValue("SELECT path FROM note_index")).toBe("a.md");
      expect(await db.selectValue("SELECT count(*) FROM note_records")).toBe(1);
    } finally {
      await client.close();
      db.close();
    }
  });

  it("keeps a replacement note when full cleanup encounters its stale UID", async () => {
    const notes = new Map([["same.md", "# initial\n\nold"]]);
    const { db, client, store, records, manual } = await setup(notes);
    try {
      await manual.update();
      const oldUid = String(await db.selectValue("SELECT current_uid FROM note_index"));
      notes.set("same.md", "# replacement\n\nnew content");
      await manual.update();
      const currentUid = String(await db.selectValue("SELECT current_uid FROM note_index"));
      expect(currentUid).not.toBe(oldUid);
      await store.delete({ ids: [oldUid] });
      expect(await db.selectValue("SELECT current_uid FROM note_index")).toBe(currentUid);
      expect(await records.exists([currentUid])).toEqual([true]);
    } finally {
      await client.close();
      db.close();
    }
  });

  it("rebuilds from an empty vault using native full cleanup", async () => {
    const notes = new Map([["a.md", "# alpha\n\nremove on rebuild"]]);
    const { db, client, manual } = await setup(notes);
    try {
      await manual.update();
      notes.clear();
      expect((await manual.rebuild()).deleted).toBe(0);
      expect(await db.selectValue("SELECT count(*) FROM note_index")).toBe(0);
      expect(await db.selectValue("SELECT count(*) FROM note_records")).toBe(0);
    } finally {
      await client.close();
      db.close();
    }
  });
});
