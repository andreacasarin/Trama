import { describe, it, expect, vi } from "vitest";
import { FakeToolCallingModel } from "langchain";
import { ChatSession } from "@/chat/ChatSession";
import { VoceView } from "@/ui/voce/VoceView";
import { LenteView } from "@/ui/lente/LenteView";
import { FiloView } from "@/ui/filo/FiloView";
import { IndexStatusController } from "@/ui/index/IndexStatus";
import { NoteStoreClient } from "@/index/note-sqlite/client";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { SqliteEmbeddingCache, embeddingCacheIdentity } from "@/index/SqliteEmbeddingCache";
import { VaultRetrieval } from "@/index/VaultRetrieval";
import { ObsidianReadonlyVault } from "@/vault/readOnly/ObsidianReadonlyVault";
import { createVaultTools } from "@/tools/VaultTools";
import { validateVector } from "@/domain/vectors";
import { isCancelled } from "@/domain/errors";
import { sha256 } from "@langchain/core/utils/hash";
import { loadTestSqlite } from "./note-sqlite-test-client";

describe("release review regressions", () => {
  it.each([false, true])(
    "Escape forgets the submitted Lente query (pending: %s)",
    async (pending) => {
      let release!: (output: any) => void;
      const output = { documents: [], status: {} };
      const invoke = vi.fn(() =>
        pending
          ? new Promise<any>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(output)
      );
      const view = new LenteView({} as any, { invoke }) as any;
      const listeners = new Map<string, (event: any) => void>();
      const element = (): any => ({
        value: "",
        textContent: "",
        classList: { add() {} },
        empty() {},
        setAttribute() {},
        addEventListener: (name: string, handler: (event: any) => void) =>
          listeners.set(name, handler),
        createDiv: () => element(),
        createEl: () => element(),
      });
      view.contentEl = element();
      view.render = vi.fn();
      await view.onOpen();
      view.input.value = "old query";
      listeners.get("keydown")!({ key: "Enter", preventDefault() {} });
      listeners.get("keydown")!({ key: "Escape" });
      if (pending) release(output);
      await Promise.resolve();
      view.refreshSubmitted();
      expect(invoke).toHaveBeenCalledOnce();
      expect(view.input.value).toBe("");
      expect(view.submitted).toBe("");
      expect(view.output).toBeUndefined();
      await view.onClose();
    }
  );

  it("fails pending and future requests after a worker crash, and closes without waiting for it", async () => {
    const events = new EventTarget();
    const worker = {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      postMessage: (request: any) => {
        if (request.method === "init")
          queueMicrotask(() =>
            events.dispatchEvent(
              new MessageEvent("message", { data: { id: request.id, ok: true } })
            )
          );
      },
      terminate: vi.fn(),
    };
    const client = new NoteStoreClient(worker, "a".repeat(64));
    await client.initialize();
    const pending = client.call("noteStoreHasNotes", {});
    const rejected = expect(pending).rejects.toThrow("worker crashed");
    await Promise.resolve();
    events.dispatchEvent(Object.assign(new Event("error"), { message: "worker crashed" }));
    await rejected;
    await expect(client.call("noteStoreHasNotes", {})).rejects.toThrow("worker crashed");
    await client.close();
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("removes opaque Obsidian EventRefs when closing Filo", async () => {
    const listeners = new Map<object, () => void>();
    let active = "";
    const app = {
      workspace: {
        on: (_name: string, callback: () => void) => {
          const ref = {};
          listeners.set(ref, callback);
          return ref;
        },
        offref: (ref: object) => listeners.delete(ref),
        getActiveFile: () => (active ? { path: active } : null),
      },
    };
    const related = vi.fn(async () => ({ documents: [], available: true }));
    const view = new FiloView({ app } as any, new IndexStatusController(), { related });
    vi.spyOn(view as any, "render").mockImplementation(() => {});
    await view.onOpen();
    active = "note.md";
    for (const callback of listeners.values()) callback();
    expect(related).toHaveBeenCalledOnce();
    await view.onClose();
    expect(listeners.size).toBe(0);
    for (const callback of listeners.values()) callback();
    expect(related).toHaveBeenCalledOnce();
  });

  it("keeps the shared conversation until its last Voce pane closes", async () => {
    const session = new ChatSession(new FakeToolCallingModel({ toolCalls: [[]] }), () => [], {
      readNote: async (path) => ({ path, content: "note" }),
    });
    await session.send({ content: "Keep this conversation", attachmentPaths: [] });
    const leaves: any[] = [];
    const app = { workspace: { getLeavesOfType: () => leaves } };
    const firstLeaf = { app } as any;
    const secondLeaf = { app } as any;
    const first = new VoceView(firstLeaf, session);
    const second = new VoceView(secondLeaf, session);
    leaves.push({ view: second });
    await first.onClose();
    expect(session.getState().turns.length).toBeGreaterThan(0);
    leaves.length = 0;
    await second.onClose();
    expect(session.getState().turns).toEqual([]);
  });

  it("reads canonical root paths exactly while resolving wrapped links relative to their source", async () => {
    const files = ["Target.md", "Folder/Target.md", "Folder/Source.md"].map((path) => ({
      path,
      name: path.split("/").at(-1)!,
    }));
    const vault = new ObsidianReadonlyVault(
      {
        configDir: ".obsidian",
        getMarkdownFiles: () => files,
        getFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
        read: async (file: any) => file.path,
      } as any,
      { getFileCache: () => null, getFirstLinkpathDest: () => files[1] } as any
    );
    const tool = createVaultTools(vault, {} as any)[0];
    const result = JSON.parse(
      await tool.invoke({ paths: ["Target.md", "[[Target]]"], sourcePath: "Folder/Source.md" })
    );
    expect(result.results.map((entry: any) => entry.note.path)).toEqual([
      "Target.md",
      "Folder/Target.md",
    ]);
  });

  it("rejects oversized model-controlled collections before reading notes", async () => {
    const readNote = vi.fn();
    const tools = createVaultTools(
      { readNote, resolveLink: async () => null, discoverLinks: async () => [] },
      {} as any
    );
    await expect(tools[0].invoke({ paths: Array(101).fill("note.md") })).rejects.toThrow();
    await expect(tools[2].invoke({ query: "x".repeat(4097) })).rejects.toThrow();
    expect(readNote).not.toHaveBeenCalled();
  });

  it("uses typed cancellation rather than interpreting note names or provider errors as cancellation", () => {
    expect(isCancelled(new Error("Could not read cancellation.md"))).toBe(false);
    expect(isCancelled(new DOMException("Stopped", "AbortError"))).toBe(true);
    expect(isCancelled({ code: "cancelled" })).toBe(true);
  });

  it("rejects zero, nonfinite, sparse and Float32-overflow vectors at the shared boundary", () => {
    for (const vector of [[0, 0], [NaN, 1], [Infinity, 1], [1e100, 1], new Array(2)])
      expect(() => validateVector(vector, 2)).toThrow();
    expect(() => validateVector([1, 0], 2)).not.toThrow();
  });

  it("repairs legacy invalid cache entries and never persists newly invalid provider vectors", async () => {
    const sqlite = await loadTestSqlite();
    const connection = new sqlite.oo1.DB(":memory:", "c");
    const database = new NoteSqliteDatabase(connection);
    let valid = false;
    const provider = {
      embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => (valid ? [1, 0] : [0, 0]))),
      embedQuery: vi.fn(async () => [1, 0]),
    };
    const cache = new SqliteEmbeddingCache(
      provider,
      database.call.bind(database),
      embeddingCacheIdentity("model", 2),
      2
    );
    try {
      await expect(cache.embedDocuments(["text"])).rejects.toThrow("magnitude");
      expect(connection.selectValue("SELECT count(*) FROM embedding_cache")).toBe(0);
      valid = true;
      for (const task of ["document", "query"])
        connection.exec({
          sql: "INSERT INTO embedding_cache(profile,task,hash,vector,created_at) VALUES(?,?,?,?,?)",
          bind: [cache.profileFingerprint, task, sha256("text"), new Uint8Array(8), Date.now()],
        });
      connection.exec({
        sql: "INSERT INTO embedding_cache_sqlite_publications(profile,hash,checksum,published_at) VALUES(?,?,?,?)",
        bind: [cache.profileFingerprint, sha256("text"), "c".repeat(64), Date.now()],
      });
      await expect(cache.embedDocuments(["text"])).resolves.toEqual([[1, 0]]);
      expect(
        connection.selectValue("SELECT count(*) FROM embedding_cache_sqlite_publications")
      ).toBe(0);
      await expect(cache.embedQuery("text")).resolves.toEqual([1, 0]);
      expect(provider.embedDocuments).toHaveBeenCalledTimes(2);
      expect(provider.embedQuery).toHaveBeenCalledOnce();
    } finally {
      connection.close();
    }
  });

  it("finds valid chunks even when their note centroid cancels to zero", async () => {
    const sqlite = await loadTestSqlite();
    const connection = new sqlite.oo1.DB(":memory:", "c");
    const database = new NoteSqliteDatabase(connection);
    try {
      await database.call("noteStoreReplace", {
        uid: "n",
        path: "n.md",
        profile: "p",
        markdown: "text",
        vectors: [
          [1, 0],
          [-1, 0],
        ],
      });
      expect(connection.selectValue("SELECT centroid FROM note_index")).toBeNull();
      expect(
        await database.call("noteStoreSemantic", { vector: [1, 0], profile: "p", k: 10 })
      ).toEqual([{ path: "n.md", score: 1, semanticScore: 1 }]);
    } finally {
      connection.close();
    }
  });

  it("returns ranked UI metadata without reading note bodies while full reads remain available", async () => {
    const call = vi.fn(async () => ({
      hits: [{ path: "note.md", score: 1 }],
      mode: "lexical",
      degraded: false,
      available: true,
    }));
    const readNote = vi.fn(async (path: string) => ({ path, content: "large private note" }));
    const retrieval = new VaultRetrieval(call as any, undefined, "p", readNote);
    const metadata = await retrieval.runnable.invoke({
      query: "note",
      mode: "lexical",
      content: "metadata",
    });
    const related = await retrieval.related("source.md", new AbortController().signal);
    expect(metadata.documents[0].metadata).toEqual({ path: "note.md", score: 1 });
    expect(related.documents[0].pageContent).toBe("");
    expect(readNote).not.toHaveBeenCalled();
    const full = await retrieval.runnable.invoke({ query: "note", mode: "lexical" });
    expect(full.documents[0].pageContent).toBe("large private note");
    expect(readNote).toHaveBeenCalledOnce();
  });
});
