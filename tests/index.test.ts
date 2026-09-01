import { describe, expect, it, vi } from "vitest";
import { IndexManager, createIndexFingerprint } from "@/index/IndexManager";
import { chunkMarkdown } from "@/index/chunking";
import { MemoryIndexStorage, ObsidianIndexStorage, StrictIndexStorage } from "@/index/storage";
import { StructuredError } from "@/domain/contracts";

const signal = new AbortController().signal;
function fixture(contents: Record<string, string>) {
  return {
    listMarkdownPaths: async () => Object.keys(contents),
    readMarkdown: async (path: string) => ({ path, content: contents[path] }),
  };
}
function embeddings(dimensions = 2) {
  return {
    dimensions,
    embed: vi.fn(async (texts: readonly string[]) =>
      texts.map((text) =>
        [
          text.toLowerCase().includes("alpha") ? 1 : 0,
          text.toLowerCase().includes("beta") ? 1 : 0,
        ].slice(0, dimensions)
      )
    ),
  };
}
function manager(
  contents: Record<string, string>,
  storage = new MemoryIndexStorage(),
  model = embeddings()
) {
  return {
    manager: new IndexManager(
      fixture(contents),
      model,
      storage,
      "HTTP://127.0.0.1:1234/v1/",
      "embed",
      { size: 100, overlap: 10 }
    ),
    storage,
    model,
  };
}

describe("semantic index module", () => {
  describe("fingerprint", () => {
    it("is stable for equivalent normalized configuration", () =>
      expect(createIndexFingerprint(" HTTP://127.0.0.1:1234/v1/ ", "m", 2)).toEqual(
        createIndexFingerprint("http://127.0.0.1:1234/v1", "m", 2)
      ));
    it("changes when endpoint, model, dimension, or chunking changes", () => {
      const base = createIndexFingerprint("http://a", "m", 2);
      expect(createIndexFingerprint("http://b", "m", 2)).not.toEqual(base);
      expect(createIndexFingerprint("http://a", "n", 2)).not.toEqual(base);
      expect(createIndexFingerprint("http://a", "m", 3)).not.toEqual(base);
      expect(createIndexFingerprint("http://a", "m", 2, { size: 4 })).not.toEqual(base);
    });
  });
  describe("chunkMarkdown()", () => {
    it("is deterministic and reports line boundaries", () => {
      const chunks = chunkMarkdown("one\ntwo\nthree\nfour", 7, 2);
      expect(chunks).toEqual(chunkMarkdown("one\ntwo\nthree\nfour", 7, 2));
      expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 2 });
    });
    it("bounds chunks from a huge single line and preserves its source range", () => {
      const chunks = chunkMarkdown("x".repeat(1_001), 100, 10);
      expect(chunks.length).toBeGreaterThan(10);
      expect(chunks.every((chunk) => chunk.text.length <= 100)).toBe(true);
      expect(chunks.every((chunk) => chunk.startLine === 1 && chunk.endLine === 1)).toBe(true);
    });
    it("overlaps long-line segments so text crossing the old cut remains searchable", async () => {
      const content = `${"a".repeat(798)}boundary${"b".repeat(900)}`;
      const chunks = chunkMarkdown(content, 800, 120);
      expect(chunks.some((chunk) => chunk.text.includes("boundary"))).toBe(true);
      const model = {
        dimensions: 2,
        embed: vi.fn(async (texts: readonly string[]) =>
          texts.map((text) => (text.includes("boundary") ? [1, 0] : [0, 1]))
        ),
      };
      const indexed = new IndexManager(
        fixture({ "boundary.md": content }),
        model,
        new MemoryIndexStorage(),
        "http://127.0.0.1:1234/v1",
        "embed",
        { size: 800, overlap: 120 }
      );
      await indexed.build(signal);
      await expect(indexed.search("boundary", signal, 1)).resolves.toMatchObject([
        { path: "boundary.md" },
      ]);
    });
    it("indexes and searches the tail of a note larger than one million characters", async () => {
      const model = embeddings();
      const storage = new MemoryIndexStorage();
      const setup = {
        manager: new IndexManager(
          fixture({ "large.md": `${"x".repeat(1_000_001)}\nalpha tail` }),
          model,
          storage,
          "http://127.0.0.1:1234/v1",
          "embed",
          { size: 20_000, overlap: 100 }
        ),
        model,
      };
      await setup.manager.build(signal);
      expect(setup.model.embed.mock.calls[0][0].length).toBeGreaterThan(1);
      await expect(setup.manager.search("alpha", signal, 5)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "large.md" })])
      );
    });
  });
  describe("StrictIndexStorage", () => {
    it("rejects every path outside the configured root", async () => {
      const adapter = new MemoryIndexStorage();
      const storage = new StrictIndexStorage(".trama/index", adapter);
      expect(() => storage.write("../escape", "x")).toThrow();
      expect(() => storage.write("/absolute", "x")).toThrow();
      await storage.write("generations/1.json", "ok");
      expect(adapter.files.has(".trama/index/generations/1.json")).toBe(true);
    });
    it("restores the old pointer when atomic publication fails", async () => {
      const files = new Map<string, string>([[".trama/index/active.json", "old"]]);
      let failure = "";
      const adapter = {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => files.get(path) ?? "",
        write: async (path: string, value: string) => {
          if (failure === "write" && path.endsWith(".tmp")) throw new Error("write");
          files.set(path, value);
        },
        remove: async (path: string) => {
          files.delete(path);
        },
        mkdir: async () => undefined,
        rename: async (from: string, to: string) => {
          if (failure === "rename" && from.endsWith(".tmp")) throw new Error("rename");
          const value = files.get(from);
          if (value !== undefined) {
            files.set(to, value);
            files.delete(from);
          }
        },
      };
      const storage = new ObsidianIndexStorage(adapter);
      failure = "rename";
      await expect(storage.activate("active.json", "new")).rejects.toThrow();
      expect(files.get(".trama/index/active.json")).toBe("old");
      failure = "write";
      await expect(storage.activate("active.json", "new")).rejects.toThrow();
      expect(files.get(".trama/index/active.json")).toBe("old");
    });
    it("leaves the active pointer untouched when rotating it to backup fails", async () => {
      const files = new Map<string, string>([["root/active.json", "old"]]);
      const adapter = {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => files.get(path) ?? "",
        write: async (path: string, value: string) => {
          files.set(path, value);
        },
        remove: async (path: string) => {
          files.delete(path);
        },
        mkdir: async () => undefined,
        rename: async (from: string, to: string) => {
          if (from.endsWith("active.json")) throw new Error("old-to-backup");
          files.set(to, files.get(from)!);
          files.delete(from);
        },
      };
      await expect(
        new ObsidianIndexStorage(adapter, "root").activate("active.json", "new")
      ).rejects.toThrow("old-to-backup");
      expect(files.get("root/active.json")).toBe("old");
      expect(files.has("root/active.json.tmp")).toBe(false);
      expect(files.has("root/active.json.bak")).toBe(false);
    });
    it("retains backup reachability when restoring after publication failure fails", async () => {
      const files = new Map<string, string>([["root/active.json", "old"]]);
      const adapter = {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => files.get(path) ?? "",
        write: async (path: string, value: string) => {
          files.set(path, value);
        },
        remove: async (path: string) => {
          files.delete(path);
        },
        mkdir: async () => undefined,
        rename: async (from: string, to: string) => {
          if (from.endsWith(".tmp")) throw new Error("publish");
          if (to.endsWith("active.json") && from.endsWith(".bak")) throw new Error("restore");
          files.set(to, files.get(from)!);
          files.delete(from);
        },
      };
      await expect(
        new ObsidianIndexStorage(adapter, "root").activate("active.json", "new")
      ).rejects.toMatchObject({ code: "internal" });
      expect(files.get("root/active.json.bak")).toBe("old");
    });
  });
  describe("IndexManager", () => {
    describe("build()", () => {
      it("builds a real Orama generation and searches with provenance", async () => {
        const setup = manager({ "a.md": "alpha note", "b.md": "beta note" });
        await setup.manager.build(signal);
        const results = await setup.manager.search("alpha", signal, 5);
        expect(results[0]).toMatchObject({ path: "a.md", excerpt: "alpha note", startLine: 1 });
        expect(results[0].score).toBeTypeOf("number");
      });
      it("preserves the active generation after cancellation or failure", async () => {
        const setup = manager({ "a.md": "alpha" });
        await setup.manager.build(signal);
        const abort = new AbortController();
        abort.abort();
        await expect(setup.manager.build(abort.signal)).rejects.toThrow();
        await expect(setup.manager.search("alpha", signal, 1)).resolves.toHaveLength(1);
      });
      it("rejects a second rebuild while one is active", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const setup = manager({ "a.md": "alpha" });
        setup.model.embed.mockImplementationOnce(async () => {
          await gate;
          return [[1, 0]];
        });
        const first = setup.manager.build(signal);
        await expect(setup.manager.build(signal)).rejects.toMatchObject({ code: "busy" });
        release();
        await first;
      });
      it("loads the persisted pointer before choosing a startup rebuild generation", async () => {
        const setup = manager({ "a.md": "alpha" });
        await setup.manager.build(signal);
        const persisted = await setup.storage.read("active.json");
        expect(persisted).toContain('"generation":1');
        const restarted = manager({ "a.md": "beta" }, setup.storage);
        await restarted.manager.build(signal);
        expect(await setup.storage.read("active.json")).toContain('"generation":2');
        await expect(restarted.manager.search("beta", signal, 1)).resolves.toHaveLength(1);
      });
      it("seeds rebuild generations from a mismatched persisted pointer", async () => {
        const setup = manager({ "a.md": "alpha" });
        await setup.manager.build(signal);
        const oldPointer = await setup.storage.read("active.json");
        const changedModel = embeddings();
        changedModel.embed.mockRejectedValueOnce(new Error("cancelled before activation"));
        const changed = new IndexManager(
          fixture({ "a.md": "beta" }),
          changedModel,
          setup.storage,
          "http://127.0.0.1:9876/v1",
          "embed",
          { size: 100, overlap: 10 }
        );
        await expect(changed.build(signal)).rejects.toThrow("cancelled before activation");
        expect(await setup.storage.read("active.json")).toBe(oldPointer);
        expect(await setup.storage.read("generations/1.json")).toBeTruthy();
        await changedModel.embed.mockImplementation(async (texts: readonly string[]) =>
          texts.map(() => [0, 1])
        );
        await changed.build(signal);
        expect(await setup.storage.read("active.json")).toContain('"generation":2');
        expect(await setup.storage.read("generations/1.json")).toBeTruthy();
      });
      it("keeps memory and the published pointer consistent when abort occurs after publication", async () => {
        const setup = manager({ "a.md": "alpha" });
        const abort = new AbortController();
        vi.spyOn(setup.storage, "activate").mockImplementation(async (pointer, value) => {
          await setup.storage.write(pointer, value);
          abort.abort();
        });
        await expect(setup.manager.build(abort.signal)).resolves.toBeUndefined();
        await expect(setup.manager.search("alpha", signal, 1)).resolves.toHaveLength(1);
        expect(await setup.storage.read("active.json")).toContain('"generation":1');
      });
      it("rejects a corrupt staged Orama generation without replacing the active generation", async () => {
        const setup = manager({ "a.md": "alpha" });
        await setup.manager.build(signal);
        const previous = await setup.storage.read("active.json");
        const originalWrite = setup.storage.write.bind(setup.storage);
        vi.spyOn(setup.storage, "write").mockImplementation(async (path, value) => {
          if (path.startsWith("generations/")) {
            const parsed = JSON.parse(value) as Record<string, unknown>;
            parsed.orama = {};
            value = JSON.stringify(parsed);
          }
          await originalWrite(path, value);
        });
        await expect(setup.manager.build(signal)).rejects.toThrow();
        expect(await setup.storage.read("active.json")).toBe(previous);
        await expect(setup.manager.search("alpha", signal, 1)).resolves.toHaveLength(1);
      });
      it("does not activate when invalidated immediately before pointer publication", async () => {
        const setup = manager({ "a.md": "alpha" });
        const activate = vi.spyOn(setup.storage, "activate").mockImplementation(async () => {
          setup.manager.invalidate();
          throw new Error("stale");
        });
        await expect(setup.manager.build(signal)).rejects.toThrow();
        expect(activate).toHaveBeenCalled();
        await expect(setup.manager.search("alpha", signal, 1)).rejects.toMatchObject({
          code: "unavailable",
        });
      });
      it("retains changes observed during a build and automatically reconciles them", async () => {
        const contents: Record<string, string> = { "a.md": "alpha" };
        const setup = manager(contents);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let calls = 0;
        setup.model.embed.mockImplementation(async (texts: readonly string[]) => {
          calls++;
          if (calls === 1) await gate;
          return texts.map((text) => [
            text.includes("alpha") ? 1 : 0,
            text.includes("beta") ? 1 : 0,
          ]);
        });
        const first = setup.manager.build(signal);
        setup.manager.queueChange("b.md");
        const reconcile = setup.manager.reconcileQueuedChanges(signal);
        contents["b.md"] = "beta";
        release();
        await first;
        await reconcile;
        await vi.waitFor(async () =>
          expect(
            (await setup.manager.search("beta", signal, 2)).some((result) => result.path === "b.md")
          ).toBe(true)
        );
      });
      it("retains a second same-path change and automatically publishes its newer content", async () => {
        const contents: Record<string, string> = { "a.md": "version one" };
        const setup = manager(contents);
        await setup.manager.load();
        setup.manager.queueChange("a.md");
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let embeddingCalls = 0;
        setup.model.embed.mockImplementation(async (texts: readonly string[]) => {
          embeddingCalls++;
          if (embeddingCalls === 1) await gate;
          return texts.map((text) => [text.includes("two") ? 1 : 0, 0]);
        });
        const first = setup.manager.build(signal);
        await vi.waitFor(() => expect(embeddingCalls).toBe(1));
        contents["a.md"] = "version two";
        setup.manager.queueChange("a.md");
        const deferred = setup.manager.reconcileQueuedChanges(signal);
        release();
        await first;
        await deferred;
        await vi.waitFor(async () => {
          expect(embeddingCalls).toBeGreaterThanOrEqual(2);
          await expect(setup.manager.search("version two", signal, 1)).resolves.toMatchObject([
            { path: "a.md", excerpt: "version two" },
          ]);
        });
      });
      it("marks the manager unavailable after deferred reconciliation fails and retains the queue", async () => {
        const contents: Record<string, string> = { "a.md": "alpha" };
        const setup = manager(contents);
        await setup.manager.load();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let calls = 0;
        setup.model.embed.mockImplementation(async (texts: readonly string[]) => {
          calls++;
          if (calls === 1) await gate;
          if (calls === 2) throw new Error("deferred failure");
          return texts.map(() => [1, 0]);
        });
        const first = setup.manager.build(signal);
        setup.manager.queueChange("b.md");
        const deferred = setup.manager.reconcileQueuedChanges(signal);
        contents["b.md"] = "beta";
        release();
        await first;
        await deferred;
        await vi.waitFor(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          expect(calls).toBe(2);
        });
        await expect(setup.manager.search("alpha", signal, 1)).rejects.toMatchObject({
          code: "unavailable",
        });
        await setup.manager.reconcileQueuedChanges(signal).catch(() => undefined);
        expect(calls).toBe(3);
      });
    });
    describe("load()", () => {
      it("reuses a persisted generation after restart and invalidates changed config", async () => {
        const setup = manager({ "a.md": "alpha" });
        await setup.manager.build(signal);
        const restarted = manager({ "a.md": "alpha" }, setup.storage);
        await expect(restarted.manager.load()).resolves.toBe(true);
        const changed = new IndexManager(
          fixture({ "a.md": "alpha" }),
          embeddings(2),
          setup.storage,
          "http://other",
          "embed"
        );
        await expect(changed.load()).resolves.toBe(false);
      });
      it("recovers from a corrupt active pointer on restart", async () => {
        const setup = manager({ "a.md": "alpha" });
        await setup.manager.build(signal);
        await setup.storage.write("active.json", "not-json");
        await expect(manager({ "a.md": "alpha" }, setup.storage).manager.load()).resolves.toBe(
          false
        );
      });
      it("recovers a valid backup pointer when active publication was interrupted", async () => {
        const setup = manager({ "a.md": "alpha" });
        await setup.manager.build(signal);
        const pointer = await setup.storage.read("active.json");
        await setup.storage.write("active.json.bak", pointer!);
        await setup.storage.remove("active.json");
        const restarted = manager({ "a.md": "alpha" }, setup.storage);
        await expect(restarted.manager.load()).resolves.toBe(true);
        await expect(restarted.manager.search("alpha", signal, 1)).resolves.toHaveLength(1);
        await restarted.manager.build(signal);
        expect(await setup.storage.read("active.json")).toContain('"generation":2');
      });
      it("rejects a backup pointer whose generation fails validation", async () => {
        const setup = manager({ "a.md": "alpha" });
        await setup.storage.write(
          "active.json.bak",
          JSON.stringify({ generation: 1, fingerprint: setup.manager.fingerprint() })
        );
        await expect(setup.manager.load()).resolves.toBe(false);
      });
    });
    describe("search()", () => {
      it("caps results and reports unavailable before a usable index", async () => {
        const setup = manager({ "a.md": "alpha", "b.md": "alpha" });
        await expect(setup.manager.search("alpha", signal, 2)).rejects.toMatchObject({
          code: "unavailable",
        });
        await setup.manager.build(signal);
        await expect(setup.manager.search("alpha", signal, 1)).resolves.toHaveLength(1);
      });
      it("rejects embedding dimension mismatches", async () => {
        const setup = manager({ "a.md": "alpha" }, new MemoryIndexStorage(), {
          dimensions: 2,
          embed: vi.fn(async () => [[1]]),
        });
        await expect(setup.manager.build(signal)).rejects.toBeInstanceOf(StructuredError);
      });
    });
    describe("reconcileQueuedChanges()", () => {
      it("rebuilds queued changes and supports upsert/delete seams", async () => {
        const setup = manager({ "a.md": "alpha" });
        await setup.manager.build(signal);
        setup.manager.queueChange("a.md");
        await setup.manager.reconcileQueuedChanges(signal);
        await setup.manager.upsert("a.md", signal);
        await setup.manager.delete("a.md", signal);
        await expect(setup.manager.search("alpha", signal, 1)).resolves.toHaveLength(1);
      });
      it("retains queued changes across failure and makes recovered results searchable after retry", async () => {
        const contents: Record<string, string> = { "a.md": "alpha" };
        const setup = manager(contents);
        await setup.manager.build(signal);
        contents["a.md"] = "beta";
        setup.manager.queueChange("a.md");
        setup.model.embed.mockRejectedValueOnce(new Error("LM Studio unavailable"));
        await expect(setup.manager.reconcileQueuedChanges(signal)).rejects.toThrow(
          "LM Studio unavailable"
        );
        setup.manager.markUnavailable();
        await expect(setup.manager.search("beta", signal, 1)).rejects.toMatchObject({
          code: "unavailable",
        });
        await setup.manager.reconcileQueuedChanges(signal);
        await expect(setup.manager.search("beta", signal, 1)).resolves.toMatchObject([
          { path: "a.md", excerpt: "beta" },
        ]);
      });
    });
  });
});
