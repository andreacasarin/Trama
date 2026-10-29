import { describe, expect, it, vi } from "vitest";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { MarkdownTextSplitter } from "@langchain/textsplitters";
import { ManualIndex, type ManualIndexNote, type ManualIndexVault } from "@/index/ManualIndex";
import { SqliteNoteRecordManager } from "@/index/SqliteNoteRecordManager";
import { SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { NoteStoreClient } from "@/index/note-sqlite/client";
import type { NoteStoreCall } from "@/index/note-sqlite/protocol";
import { loadTestSqlite, TestNoteWorker as LocalNoteWorker } from "./note-sqlite-test-client";

class TestEmbeddings implements EmbeddingsInterface<number[]> {
  calls = 0;
  fail = false;
  batches: string[][] = [];
  async embedDocuments(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    this.calls++;
    this.batches.push([...texts]);
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    if (this.fail) throw new Error("provider offline");
    return texts.map(embeddingVector);
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
      expect(embeddings.calls).toBe(1);
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

  it("cleans excluded notes on Update and restores them when re-included", async () => {
    const notes = new Map([
      ["Projects/keep.md", "# keep\n\nvisible"],
      ["Projects/private/hidden.md", "# private\n\nhidden"],
    ]);
    const setupResult = await setup(notes);
    const { db, client } = setupResult;
    let excluded = new Set<string>();
    const filteredVault: ManualIndexVault = {
      listMarkdownPaths: async () =>
        [...notes.keys()].filter(
          (path) => ![...excluded].some((folder) => path.startsWith(`${folder}/`))
        ),
      readMarkdown: (path) => setupResult.vault.readMarkdown(path),
    };
    const filteredManual = new ManualIndex(filteredVault, setupResult.store, setupResult.records);
    try {
      expect((await filteredManual.update()).numAdded).toBe(2);
      excluded = new Set(["Projects/private"]);
      expect((await filteredManual.update()).deleted).toBe(1);
      expect(await db.selectValue("SELECT count(*) FROM note_index")).toBe(1);
      excluded.clear();
      expect((await filteredManual.update()).numAdded).toBe(1);
      expect(await db.selectValue("SELECT count(*) FROM note_index")).toBe(2);
    } finally {
      await client.close();
      db.close();
    }
  });

  it("embeds chunks across notes together and writes each vector to its source UID", async () => {
    const notes = new Map([
      ["alpha.md", "# alpha\n\nalpha uniquealpha searchable body"],
      ["beta.md", "# beta\n\nbeta uniquebeta searchable body"],
      ["gamma.md", "# gamma\n\ngamma uniquegamma searchable body"],
    ]);
    const { db, client, embeddings, manual } = await setup(notes);
    try {
      expect((await manual.update()).numAdded).toBe(3);
      const splitter = new MarkdownTextSplitter();
      const expected: string[] = [];
      for (const [, markdown] of [...notes].sort(([left], [right]) => left.localeCompare(right)))
        expected.push(...(await splitter.splitText(markdown)));
      expect(embeddings.batches).toEqual([expected]);

      for (const [path, markdown] of notes) {
        const noteId = Number(
          db.selectValue("SELECT note_id FROM note_index WHERE path=?", [path])
        );
        const uid = String(
          db.selectValue("SELECT current_uid FROM note_index WHERE path=?", [path])
        );
        expect(db.selectValue("SELECT group_path FROM note_records WHERE uid=?", [uid])).toBe(path);
        const chunks = await splitter.splitText(markdown);
        expect(db.selectValue("SELECT count(*) FROM note_vectors WHERE note_id=?", [noteId])).toBe(
          chunks.length
        );
        for (let ordinal = 0; ordinal < chunks.length; ordinal++)
          expect(
            db.selectValue("SELECT hex(vector) FROM note_vectors WHERE note_id=? AND ordinal=?", [
              noteId,
              ordinal,
            ])
          ).toBe(vectorHex(embeddingVector(chunks[ordinal])));
        const token = path
          .split(".")[0]
          .replace("alpha", "uniquealpha")
          .replace("beta", "uniquebeta")
          .replace("gamma", "uniquegamma");
        expect(
          db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH ? AND rowid=?", [
            token,
            noteId,
          ])
        ).toBe(1);
      }
    } finally {
      await client.close();
      db.close();
    }
  });

  it("flushes near the 512-chunk cap and slices an oversized note across provider calls", async () => {
    const notes = new Map([
      ["alpha.md", `# alphamarker\n\n${"w ".repeat(204_000)}`],
      ["beta.md", `# betamarker\n\n${"x ".repeat(500)}`],
      ["gamma.md", `# gammamarker\n\n${"y ".repeat(204_800)}`],
    ]);
    const { db, client, embeddings, manual } = await setup(notes);
    try {
      const splitter = new MarkdownTextSplitter();
      const chunksByPath = new Map(
        await Promise.all(
          [...notes].map(
            async ([path, markdown]) => [path, await splitter.splitText(markdown)] as const
          )
        )
      );
      expect([...chunksByPath.values()].map((chunks) => chunks.length)).toEqual([511, 3, 513]);

      expect((await manual.update()).numAdded).toBe(3);
      expect(embeddings.batches.map((batch) => batch.length)).toEqual([511, 3, 512, 1]);
      for (const [path, chunks] of chunksByPath) {
        const noteId = Number(
          db.selectValue("SELECT note_id FROM note_index WHERE path=?", [path])
        );
        const uid = String(
          db.selectValue("SELECT current_uid FROM note_index WHERE path=?", [path])
        );
        expect(db.selectValue("SELECT group_path FROM note_records WHERE uid=?", [uid])).toBe(path);
        expect(db.selectValue("SELECT count(*) FROM note_vectors WHERE note_id=?", [noteId])).toBe(
          chunks.length
        );
        for (const ordinal of [0, chunks.length - 1])
          expect(
            db.selectValue("SELECT hex(vector) FROM note_vectors WHERE note_id=? AND ordinal=?", [
              noteId,
              ordinal,
            ])
          ).toBe(vectorHex(embeddingVector(chunks[ordinal])));
        expect(
          db.selectValue("SELECT count(*) FROM note_fts WHERE note_fts MATCH ? AND rowid=?", [
            `${path.split(".")[0]}marker`,
            noteId,
          ])
        ).toBe(1);
      }
    } finally {
      await client.close();
      db.close();
    }
  });

  it("flushes native indexing at the 100-note boundary", async () => {
    const notes = new Map(
      Array.from({ length: 101 }, (_, index) => {
        const path = `note-${String(index).padStart(3, "0")}.md`;
        return [path, `# note ${index}\n\nshort single-chunk content ${index}`] as const;
      })
    );
    const { db, client, embeddings, manual } = await setup(notes);
    try {
      expect((await manual.update()).numAdded).toBe(101);
      expect(embeddings.batches.map((batch) => batch.length)).toEqual([100, 1]);
      expect(db.selectValue("SELECT count(*) FROM note_index")).toBe(101);
      expect(db.selectValue("SELECT count(*) FROM note_records")).toBe(101);
    } finally {
      await client.close();
      db.close();
    }
  });

  it("stops on embedding errors and retries on the next native index run", async () => {
    const notes = new Map([["a.md", "# alpha\n\nretry me"]]);
    const embeddings = new TestEmbeddings();
    const { db, client, store, records, vault } = await setup(notes, embeddings);
    let publishCalls = 0;
    const manual = new ManualIndex(vault, store, records, {
      importAvailable: async () => undefined,
      publishAvailable: async () => {
        publishCalls++;
      },
    });
    try {
      embeddings.fail = true;
      await expect(manual.update()).rejects.toThrow("provider offline");
      expect(await db.selectValue("SELECT count(*) FROM note_index")).toBe(0);
      expect(publishCalls).toBe(0);
      embeddings.fail = false;
      const result = await manual.update();
      expect(result.numAdded).toBe(1);
      expect(result.sharing).toBe("complete");
      expect(publishCalls).toBe(1);
      expect(await db.selectValue("SELECT count(*) FROM note_index")).toBe(1);
      expect(await db.selectValue("SELECT count(*) FROM note_vectors")).toBeGreaterThan(0);
      expect(store.embeddingProfile).toContain("manual-test");
    } finally {
      await client.close();
      db.close();
    }
  });

  it("does not publish when native cleanup fails", async () => {
    const notes = new Map([["stale.md", "# stale\n\nremove during cleanup"]]);
    const { db, client, store, records, vault, manual } = await setup(notes);
    let publishCalls = 0;
    try {
      await manual.update();
      notes.clear();
      vi.spyOn(SqliteNoteVectorStore.prototype, "delete").mockRejectedValue(
        new Error("cleanup failed")
      );
      const interrupted = new ManualIndex(vault, store, records, {
        importAvailable: async () => undefined,
        publishAvailable: async () => {
          publishCalls++;
        },
      });
      await expect(interrupted.update()).rejects.toThrow("cleanup failed");
      expect(publishCalls).toBe(0);
      expect(await db.selectValue("SELECT count(*) FROM note_index")).toBe(1);
    } finally {
      vi.restoreAllMocks();
      await client.close();
      db.close();
    }
  });

  it("keeps local indexing successful and retries sharing after a partial publication failure", async () => {
    const notes = new Map([["a.md", "# alpha\n\nkeep local index"]]);
    const { db, client, store, records, vault } = await setup(notes);
    const artifacts = new Set<string>();
    let publishCalls = 0;
    const manual = new ManualIndex(vault, store, records, {
      importAvailable: async () => undefined,
      publishAvailable: async () => {
        publishCalls++;
        artifacts.add("valid immutable artifact");
        if (publishCalls === 1) throw new Error("sharing write failed");
        artifacts.add("remaining artifact");
      },
    });
    try {
      const first = await manual.update();
      expect(first.numAdded).toBe(1);
      expect(first.sharing).toBe("incomplete");
      expect(artifacts).toEqual(new Set(["valid immutable artifact"]));
      expect(await db.selectValue("SELECT count(*) FROM note_index")).toBe(1);

      const retry = await manual.update();
      expect(retry.numSkipped).toBe(1);
      expect(retry.sharing).toBe("complete");
      expect(publishCalls).toBe(2);
      expect(artifacts).toEqual(new Set(["valid immutable artifact", "remaining artifact"]));
    } finally {
      await client.close();
      db.close();
    }
  });

  it("reports sharing cancellation after cleanup as a successful local index and retries explicitly", async () => {
    const notes = new Map([["a.md", "# alpha\n\nkeep local index"]]);
    const { db, client, store, records, vault } = await setup(notes);
    const runControl: { manual?: ManualIndex } = {};
    let publishCalls = 0;
    const manual = new ManualIndex(vault, store, records, {
      importAvailable: async () => undefined,
      publishAvailable: async () => {
        publishCalls++;
        if (publishCalls === 1) {
          runControl.manual?.cancel();
          throw new DOMException("Cancelled", "AbortError");
        }
      },
    });
    runControl.manual = manual;
    try {
      const first = await manual.update();
      expect(first.numAdded).toBe(1);
      expect(first.sharing).toBe("cancelled");
      expect(await db.selectValue("SELECT count(*) FROM note_index")).toBe(1);

      const retry = await manual.update();
      expect(retry.numSkipped).toBe(1);
      expect(retry.sharing).toBe("complete");
      expect(publishCalls).toBe(2);
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
    const notes = new Map([["stale.md", "# stale\n\nretain until cleanup"]]);
    const embeddings = new TestEmbeddings();
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => (entered = resolve));
    embeddings.embedDocuments = async (texts, signal) => {
      embeddings.calls++;
      if (texts.some((text) => text.includes("hold the second batch"))) {
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
    const { db, client, manual, vault, store, records } = await setup(notes, embeddings);
    let publishCalls = 0;
    const withArtifacts = new ManualIndex(vault, store, records, {
      importAvailable: async () => undefined,
      publishAvailable: async () => {
        publishCalls++;
      },
    });
    try {
      await manual.update();
      notes.clear();
      for (let index = 0; index < 100; index++) {
        const path = `note-${String(index).padStart(3, "0")}.md`;
        notes.set(path, `# note ${index}\n\ncommitted in first batch ${index}`);
      }
      notes.set("z.md", "# z\n\nhold the second batch");
      const run = withArtifacts.update();
      await blocked;
      withArtifacts.cancel();
      await expect(run).rejects.toMatchObject({ name: "AbortError" });
      expect(publishCalls).toBe(0);
      expect(await db.selectValue("SELECT count(*) FROM note_index")).toBe(101);
      expect(await db.selectValue("SELECT count(*) FROM note_records")).toBe(101);
      expect(await db.selectValue("SELECT count(*) FROM note_index WHERE path='stale.md'")).toBe(1);
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

function embeddingVector(text: string): number[] {
  let hash = 0;
  for (const character of text) hash = (hash * 31 + character.charCodeAt(0)) % 10_000;
  return [hash + 1, text.length + 1];
}

function vectorHex(vector: number[]): string {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return Array.from(
    new Uint8Array(Float32Array.from(vector.map((value) => value / norm)).buffer),
    (value) => value.toString(16).padStart(2, "0")
  )
    .join("")
    .toUpperCase();
}
