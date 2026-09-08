import { describe, expect, it, vi } from "vitest";
import { IndexManager, createIndexFingerprint } from "@/index/IndexManager";
import { CHUNK_OVERLAP, CHUNK_SIZE, chunkMarkdown } from "@/index/chunking";
import { CorpusStore } from "@/index/corpus/CorpusStore";
import { RelatedNotes } from "@/index/RelatedNotes";
import { Retriever } from "@/index/retrieval/Retriever";
import type { IndexProgress } from "@/domain/contracts";
import { MemoryIndexStorage, ObsidianIndexStorage, StrictIndexStorage } from "@/index/storage";
import { StructuredError } from "@/domain/contracts";
import { projectDiagnosticError } from "@/diagnostics/TramaDiagnostics";
import type { TramaDiagnosticRecord } from "@/diagnostics/TramaDiagnostics";

const signal = new AbortController().signal;
function fixture(contents: Record<string, string>) {
  return {
    listMarkdownPaths: async () => Object.keys(contents),
    readMarkdown: async (path: string) => {
      if (!Object.prototype.hasOwnProperty.call(contents, path))
        throw new Error(`Markdown note is unavailable: ${path}`);
      return { path, content: contents[path] };
    },
    isMarkdownAvailable: async (path: string) =>
      Object.prototype.hasOwnProperty.call(contents, path),
    estimateMarkdownTextCount: async (paths: readonly string[], size: number, overlap: number) => {
      const stride = Math.max(1, size - overlap);
      return paths.reduce((total, path) => {
        const length = contents[path]?.length ?? 0;
        return total + (length ? Math.max(1, Math.ceil(length / stride)) : 0);
      }, 0);
    },
  };
}
function embeddings(dimensions = 2) {
  return {
    dimensions,
    embed: vi.fn(async (texts: readonly string[]) =>
      texts.map((text) =>
        [text.toLowerCase().includes("alpha") ? 1 : 0, text.toLowerCase().includes("beta") ? 1 : 0]
          .slice(0, dimensions)
          .map((value, index) => value || (dimensions === 1 || index > 0 ? 1 : 0))
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
  it("handles a bounded 1,000-chunk 768D corpus without generation JSON", async () => {
    const dimensions = 768;
    const content = Array.from(
      { length: 1_000 },
      (_, i) => `chunk-${i.toString().padStart(5, "0")}`
    ).join("\n");
    const model = {
      dimensions,
      embed: vi.fn(async (texts: readonly string[]) =>
        texts.map(() => [1, ...Array(dimensions - 1).fill(0)])
      ),
    };
    const storage = new MemoryIndexStorage();
    const indexed = new IndexManager(
      fixture({ "scale.md": content }),
      model,
      storage,
      "http://127.0.0.1:1234/v1",
      "embed",
      { size: 12, overlap: 0 }
    );
    await indexed.build(signal);
    const files = [...storage.files.keys(), ...storage.binaryFiles.keys()];
    expect(files.some((path) => path.endsWith(".seg"))).toBe(true);
    expect(
      files.some((path) => path.endsWith(".json") && /generations\/[^/]+\.json$/.test(path))
    ).toBe(false);
    await expect(indexed.search("chunk-00499", signal, 1)).resolves.toMatchObject([
      { path: "scale.md" },
    ]);
  }, 30_000);
  it("projects hostile error-like values to safe metadata without throwing", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("getter escaped");
        },
        has() {
          throw new Error("has escaped");
        },
      }
    );
    expect(projectDiagnosticError(hostile)).toEqual({ name: "Error" });
  });

  describe("fingerprint", () => {
    it("uses the 384-character, 64-character-overlap defaults", () => {
      expect({ size: CHUNK_SIZE, overlap: CHUNK_OVERLAP }).toEqual({ size: 384, overlap: 64 });
      expect(createIndexFingerprint("http://a", "m", 2).chunking).toMatchObject({
        algorithmVersion: 2,
        size: 384,
        overlap: 64,
      });
    });
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
    class ReceiverSensitiveAdapter {
      readonly files = new Map<string, string>();
      readonly queue: string[] = [];
      failRename: "publish" | "restore" | null = null;

      async exists(path: string): Promise<boolean> {
        this.queue.push(`exists:${path}`);
        return this.files.has(path);
      }
      async read(path: string): Promise<string> {
        this.queue.push(`read:${path}`);
        return this.files.get(path) ?? "";
      }
      async write(path: string, value: string): Promise<void> {
        this.queue.push(`write:${path}`);
        this.files.set(path, value);
      }
      async remove(path: string): Promise<void> {
        this.queue.push(`remove:${path}`);
        this.files.delete(path);
      }
      async mkdir(path: string): Promise<void> {
        this.queue.push(`mkdir:${path}`);
      }
      async rename(from: string, to: string): Promise<void> {
        this.queue.push(`rename:${from}->${to}`);
        if (this.failRename === "publish" && from.endsWith(".tmp")) throw new Error("publish");
        if (this.failRename === "restore" && from.endsWith(".bak")) throw new Error("restore");
        const value = this.files.get(from);
        if (value !== undefined) {
          this.files.set(to, value);
          this.files.delete(from);
        }
      }
    }

    it("preserves the adapter receiver for prepare and successful activation", async () => {
      const adapter = new ReceiverSensitiveAdapter();
      adapter.files.set("root/active.json", "old");
      const storage = new ObsidianIndexStorage(adapter, "root");

      await storage.prepare();
      await storage.activate("active.json", "new");

      expect(adapter.files.get("root/active.json")).toBe("new");
      expect(adapter.files.has("root/active.json.tmp")).toBe(false);
      expect(adapter.files.has("root/active.json.bak")).toBe(false);
      expect(adapter.queue).toEqual(
        expect.arrayContaining(["mkdir:root", "mkdir:root/generations"])
      );
    });

    it("passes an exact ArrayBuffer to Obsidian binary storage", async () => {
      let written: ArrayBuffer | undefined;
      const files = new Set<string>();
      const adapter = {
        exists: async (path: string) => files.has(path),
        read: async () => "",
        write: async (path: string) => void files.add(path),
        writeBinary: async (path: string, data: ArrayBuffer) => {
          files.add(path);
          written = data;
        },
        remove: async (path: string) => void files.delete(path),
        mkdir: async (path: string) => void files.add(path),
      };
      const source = new Uint8Array([9, 1, 2, 3, 8]).subarray(1, 4);

      await new ObsidianIndexStorage(adapter, "root").writeBinary("segments/a.seg", source);

      expect(written).toBeInstanceOf(ArrayBuffer);
      expect(Array.from(new Uint8Array(written!))).toEqual([1, 2, 3]);
    });

    it("fails closed when the adapter cannot atomically rename the active pointer", async () => {
      const files = new Map<string, string>([["root/active.json", "old"]]);
      const adapter = {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => files.get(path) ?? "",
        write: async (path: string, value: string) => void files.set(path, value),
        remove: async (path: string) => void files.delete(path),
        mkdir: async () => undefined,
      };

      await expect(
        new ObsidianIndexStorage(adapter, "root").activate("active.json", "new")
      ).rejects.toThrow("Atomic index activation is unavailable");
      expect(files.get("root/active.json")).toBe("old");
      expect(files.has("root/active.json.tmp")).toBe(false);
    });

    it("preserves the adapter receiver while rolling back a failed publication", async () => {
      const adapter = new ReceiverSensitiveAdapter();
      adapter.files.set("root/active.json", "old");
      adapter.failRename = "publish";

      await expect(
        new ObsidianIndexStorage(adapter, "root").activate("active.json", "new")
      ).rejects.toThrow("publish");

      expect(adapter.files.get("root/active.json")).toBe("old");
      expect(adapter.files.has("root/active.json.tmp")).toBe(false);
      expect(adapter.files.has("root/active.json.bak")).toBe(false);
      expect(adapter.queue).toEqual(
        expect.arrayContaining([
          "rename:root/active.json->root/active.json.bak",
          "rename:root/active.json.bak->root/active.json",
        ])
      );
    });

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
      it("emits metadata-only lifecycle diagnostics", async () => {
        const records: TramaDiagnosticRecord[] = [];
        const setup = new IndexManager(
          fixture({ "private.md": "PRIVATE_SENTINEL" }),
          embeddings(),
          new MemoryIndexStorage(),
          "http://127.0.0.1:1234/v1",
          "embed",
          { size: 100, overlap: 10 },
          { emit: (record) => records.push(record) }
        );
        await setup.build(signal);
        await setup.search("PRIVATE_SENTINEL", signal, 1);
        const serialized = JSON.stringify(records);
        expect(serialized).not.toContain("PRIVATE_SENTINEL");
        expect(records.every((record) => !("text" in record))).toBe(true);
        expect(
          records.some(
            (record) =>
              record.area === "index" &&
              record.event === "index_operation" &&
              record.stage === "published"
          )
        ).toBe(true);
      });
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
        const firstPointer = JSON.parse(persisted!) as { current: string; previous?: string };
        expect(firstPointer.current).toMatch(/^[0-9a-f]{64}$/);
        const restarted = manager({ "a.md": "beta" }, setup.storage);
        await restarted.manager.build(signal);
        const secondPointer = JSON.parse((await setup.storage.read("active.json"))!);
        expect(secondPointer.previous).toBe(firstPointer.current);
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
        expect(await setup.storage.read("generations/1/root.json")).toBeNull();
        await changedModel.embed.mockImplementation(async (texts: readonly string[]) =>
          texts.map(() => [0, 1])
        );
        await changed.build(signal);
        const pointer = JSON.parse((await setup.storage.read("active.json"))!);
        expect(pointer.current).toMatch(/^[0-9a-f]{64}$/);
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
        expect(JSON.parse((await setup.storage.read("active.json"))!).current).toMatch(
          /^[0-9a-f]{64}$/
        );
      });
      it("rejects a corrupt staged Orama generation without replacing the active generation", async () => {
        const setup = manager({ "a.md": "alpha" });
        await setup.manager.build(signal);
        const previous = await setup.storage.read("active.json");
        const originalWrite = setup.storage.write.bind(setup.storage);
        vi.spyOn(setup.storage, "write").mockImplementation(async (path, value) => {
          if (path.startsWith("generations/") && path.endsWith("root.json")) value = "corrupt";
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
      it("skips a note moved during a full build and indexes its queued destination", async () => {
        const contents: Record<string, string> = { "old.md": "alpha moved note" };
        let moved = false;
        const vault = {
          listMarkdownPaths: async () => Object.keys(contents),
          readMarkdown: async (path: string) => {
            if (!moved && path === "old.md") {
              moved = true;
              contents["new.md"] = contents[path];
              delete contents[path];
              indexed.queueRename("old.md", "new.md");
              throw new Error(`Markdown note is unavailable: ${path}`);
            }
            return { path, content: contents[path] };
          },
          isMarkdownAvailable: async (path: string) =>
            Object.prototype.hasOwnProperty.call(contents, path),
        };
        const indexed = new IndexManager(
          vault,
          embeddings(),
          new MemoryIndexStorage(),
          "http://127.0.0.1:1234/v1",
          "embed",
          { size: 100, overlap: 10 }
        );

        await expect(indexed.build(signal)).resolves.toBeUndefined();
        await expect(indexed.reconcileQueuedChanges(signal)).resolves.toBeUndefined();
        await expect(indexed.search("alpha", signal, 1)).resolves.toMatchObject([
          { path: "new.md" },
        ]);
      });
      it("synchronizes an unchanged vault without creating embeddings", async () => {
        const contents = { "a.md": "alpha", "b.md": "beta" };
        const setup = manager(contents);
        await setup.manager.build(signal);
        setup.model.embed.mockClear();

        await setup.manager.synchronize(signal);

        expect(setup.model.embed).not.toHaveBeenCalled();
        await expect(setup.manager.search("alpha", signal, 1)).resolves.toMatchObject([
          { path: "a.md" },
        ]);
      });
      it("coalesces a stale modify followed by a rename without losing the note", async () => {
        const contents: Record<string, string> = { "old.md": "alpha moved note" };
        const setup = manager(contents);
        await setup.manager.build(signal);
        contents["new.md"] = contents["old.md"];
        delete contents["old.md"];
        setup.manager.queueChange("old.md");
        setup.manager.queueRename("old.md", "new.md");

        await setup.manager.reconcileQueuedChanges(signal);

        await expect(setup.manager.search("alpha", signal, 1)).resolves.toMatchObject([
          { path: "new.md" },
        ]);
      });
      it("synchronizes additions, edits, and deletions while embedding only changed notes", async () => {
        const contents: Record<string, string> = {
          "stable.md": "alpha stable",
          "changed.md": "old value",
          "deleted.md": "remove me",
        };
        const setup = manager(contents);
        await setup.manager.build(signal);
        setup.model.embed.mockClear();
        contents["changed.md"] = "beta changed";
        contents["added.md"] = "beta added";
        delete contents["deleted.md"];

        await setup.manager.synchronize(signal);

        const embeddedTexts = setup.model.embed.mock.calls.flatMap(([texts]) => texts);
        expect(embeddedTexts).toEqual(expect.arrayContaining(["beta changed", "beta added"]));
        expect(embeddedTexts).not.toContain("alpha stable");
        await expect(setup.manager.search("beta", signal, 5)).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: "changed.md" }),
            expect.objectContaining({ path: "added.md" }),
          ])
        );
        const removed = await setup.manager.search("remove", signal, 5);
        expect(removed.some((result) => result.path === "deleted.md")).toBe(false);
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
          return texts.map((text) => [text.includes("two") ? 1 : 0, text.includes("two") ? 0 : 1]);
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
      it("awaits explicit late reconciliation and retains the queue after failure", async () => {
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
          return texts.map((text) => (text.includes("beta") ? [0, 1] : [1, 0]));
        });
        const first = setup.manager.build(signal);
        await vi.waitFor(() => expect(calls).toBe(1));
        contents["b.md"] = "beta";
        setup.manager.queueChange("b.md");
        const deferred = setup.manager.reconcileQueuedChanges(signal);
        release();
        await first;
        await expect(deferred).rejects.toThrow("deferred failure");
        expect(calls).toBe(2);
        await expect(setup.manager.search("alpha", signal, 1)).resolves.toHaveLength(1);
        await setup.manager.reconcileQueuedChanges(signal);
        expect(calls).toBe(4);
        await expect(setup.manager.search("beta", signal, 1)).resolves.toMatchObject([
          { path: "b.md", excerpt: "beta" },
        ]);
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
      it("hydrates the current-note query from the corpus for Filo after restart", async () => {
        const setup = manager({ "current.md": "alpha current", "related.md": "alpha related" });
        await setup.manager.build(signal);
        const restartedModel = embeddings();
        const restarted = manager(
          { "current.md": "alpha current", "related.md": "alpha related" },
          setup.storage,
          restartedModel
        );
        await expect(restarted.manager.load()).resolves.toBe(true);
        restartedModel.embed.mockClear();

        const search = vi.spyOn(Retriever.prototype, "search");
        const result = await new RelatedNotes(restarted.manager).find("current.md", signal);

        expect(restartedModel.embed).not.toHaveBeenCalled();
        expect(search).toHaveBeenLastCalledWith(
          expect.objectContaining({
            query: expect.stringContaining("alpha current"),
            queryVector: expect.any(Array),
            semanticCandidateLimit: 128,
            lexicalCandidateLimit: 128,
          })
        );
        search.mockRestore();
        expect(result.results).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "related.md" })])
        );
      });
      it("loads silently without embedding or detailed diagnostics", async () => {
        const setup = manager({ "a.md": "alpha" });
        await setup.manager.build(signal);
        const records: TramaDiagnosticRecord[] = [];
        const model = embeddings();
        const restarted = new IndexManager(
          fixture({ "a.md": "alpha" }),
          model,
          setup.storage,
          "http://127.0.0.1:1234/v1",
          "embed",
          { size: 100, overlap: 10 },
          { emit: (record) => records.push(record) }
        );

        await expect(restarted.load()).resolves.toBe(true);

        expect(model.embed).not.toHaveBeenCalled();
        expect(records).toEqual([]);
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
        expect(JSON.parse((await setup.storage.read("active.json"))!).current).toMatch(
          /^[0-9a-f]{64}$/
        );
      });
      it("rejects a backup pointer whose generation fails validation", async () => {
        const setup = manager({ "a.md": "alpha" });
        await setup.storage.write(
          "active.json.bak",
          JSON.stringify({ generation: 1, fingerprint: setup.manager.fingerprint() })
        );
        await expect(setup.manager.load()).resolves.toBe(false);
      });
      it("rejects a persisted manifest whose segment is corrupt", async () => {
        const setup = manager({ "a.md": "alpha" });
        await setup.manager.build(signal);
        const segment = [...setup.storage.binaryFiles.keys()][0];
        await setup.storage.writeBinary!(segment, new Uint8Array([1, 2, 3]));
        const restarted = manager({ "a.md": "alpha" }, setup.storage);
        await expect(restarted.manager.load()).resolves.toBe(false);
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
      it("passes the real related-note query through and overfetches 128 chunks", async () => {
        const setup = manager({ "current.md": "alpha", "other.md": "alpha" });
        await setup.manager.build(signal);
        const search = vi.spyOn(Retriever.prototype, "search");
        try {
          const snapshot = setup.manager.relatedSnapshot("current.md")!;
          await snapshot.search("alpha", [1, 0], signal, 128);
          expect(search).toHaveBeenLastCalledWith(
            expect.objectContaining({ query: "alpha", limit: 128, resultShape: "chunks" })
          );
        } finally {
          search.mockRestore();
        }
      });
      it("uses a bounded committed-corpus query and performs no related-note embedding", async () => {
        const longText = `alpha ${"detail ".repeat(2_000)}`;
        const setup = manager({ "current.md": longText, "other.md": "alpha detail" });
        await setup.manager.build(signal);
        setup.model.embed.mockClear();
        const search = vi.spyOn(Retriever.prototype, "search");
        try {
          await new RelatedNotes(setup.manager).find("current.md", signal);
          const request = search.mock.calls.at(-1)?.[0];
          expect(request?.query.length).toBeLessThanOrEqual(384);
          expect(request?.queryVector).toHaveLength(setup.model.dimensions);
          expect(setup.model.embed).not.toHaveBeenCalled();
        } finally {
          search.mockRestore();
        }
      });
      it("does not perform network work for a committed note with zero chunks", async () => {
        const setup = manager({ "empty.md": "", "other.md": "alpha" });
        await setup.manager.build(signal);
        setup.model.embed.mockClear();

        await expect(
          new RelatedNotes(setup.manager).find("empty.md", signal)
        ).resolves.toMatchObject({ results: [] });

        expect(setup.model.embed).not.toHaveBeenCalled();
      });
    });
    describe("progress and garbage collection", () => {
      const expectMonotonic = (events: readonly IndexProgress[]) => {
        const previous = new Map<string, number>();
        for (const event of events) {
          const key = `${event.operation}:${event.phase}`;
          expect(event.completed).toBeGreaterThanOrEqual(previous.get(key) ?? 0);
          if (event.total !== undefined) expect(event.completed).toBeLessThanOrEqual(event.total);
          previous.set(key, event.completed);
        }
      };

      it("reports truthful full and incremental phases with monotonic counters", async () => {
        const contents: Record<string, string> = { "a.md": "alpha", "b.md": "beta" };
        const events: IndexProgress[] = [];
        const indexed = new IndexManager(
          fixture(contents),
          embeddings(),
          new MemoryIndexStorage(),
          "http://127.0.0.1:1234/v1",
          "embed",
          { size: 100, overlap: 10, onProgress: (event) => events.push(event) }
        );
        await indexed.build(signal);
        const phases = new Set(events.filter((e) => e.operation === "full").map((e) => e.phase));
        expect(phases).toEqual(
          new Set([
            "discover",
            "read",
            "chunk",
            "embed",
            "encode-write",
            "validate",
            "build-vector",
            "build-lexical",
            "activate",
            "GC",
          ])
        );
        expectMonotonic(events);

        events.length = 0;
        contents["a.md"] = "alpha changed";
        indexed.queueChange("a.md");
        await indexed.reconcileQueuedChanges(signal);
        expect(new Set(events.map((e) => e.phase))).toEqual(phases);
        expect(events.every((e) => e.operation === "incremental")).toBe(true);
        expectMonotonic(events);
      });

      it("uses a fast estimated full total and keeps incremental totals truthful", async () => {
        const contents: Record<string, string> = {
          "a.md": "alpha one\nalpha two",
          "b.md": "beta one\nbeta two",
        };
        const events: IndexProgress[] = [];
        const indexed = new IndexManager(
          fixture(contents),
          embeddings(),
          new MemoryIndexStorage(),
          "http://127.0.0.1:1234/v1",
          "embed",
          { size: 12, overlap: 2, onProgress: (event) => events.push(event) }
        );

        await indexed.build(signal);

        const fullEmbed = events.filter(
          (event) => event.operation === "full" && event.phase === "embed"
        );
        expect(fullEmbed.length).toBeGreaterThan(2);
        expect(fullEmbed[0]).toMatchObject({
          completed: 0,
          determinate: true,
          estimated: true,
          total: expect.any(Number),
        });
        expect(fullEmbed.at(-1)).toMatchObject({
          determinate: true,
          completed: fullEmbed.at(-1)?.total,
        });
        expect(fullEmbed.at(-1)?.estimated).toBeUndefined();

        events.length = 0;
        contents["a.md"] = "alpha changed once\nalpha changed twice";
        contents["b.md"] = "beta changed once\nbeta changed twice";
        indexed.queueChange("a.md");
        indexed.queueChange("b.md");
        await indexed.reconcileQueuedChanges(signal);

        for (const phase of ["chunk", "embed"] as const) {
          const phaseEvents = events.filter(
            (event) => event.operation === "incremental" && event.phase === phase
          );
          expect(phaseEvents.length).toBeGreaterThan(2);
          expect(phaseEvents.slice(0, -1).every((event) => !event.determinate)).toBe(true);
          expect(phaseEvents.slice(0, -1).every((event) => event.total === undefined)).toBe(true);
          expect(phaseEvents.at(-1)).toMatchObject({
            determinate: true,
            completed: phaseEvents.at(-1)?.total,
          });
        }
      });

      it("does not move an underestimated finish line forward with completed work", async () => {
        const events: IndexProgress[] = [];
        const vault = {
          ...fixture({ "a.md": "alpha beta gamma delta epsilon" }),
          estimateMarkdownTextCount: async () => 1,
        };
        const indexed = new IndexManager(
          vault,
          embeddings(),
          new MemoryIndexStorage(),
          "http://127.0.0.1:1234/v1",
          "embed",
          { size: 8, overlap: 1, onProgress: (event) => events.push(event) }
        );

        await indexed.build(signal);

        const embedding = events.filter(
          (event) => event.operation === "full" && event.phase === "embed"
        );
        expect(embedding[0]).toMatchObject({ completed: 0, total: 1, estimated: true });
        expect(
          embedding.some(
            (event) => event.completed > 1 && !event.determinate && event.total === undefined
          )
        ).toBe(true);
        expect(
          embedding.filter((event) => event.estimated).every((event) => event.total === 1)
        ).toBe(true);
      });

      it("runs GC after publication and treats GC failure as nonfatal", async () => {
        const collect = vi
          .spyOn(CorpusStore.prototype, "collectGarbage")
          .mockRejectedValueOnce(new Error("gc unavailable"));
        try {
          const setup = manager({ "a.md": "alpha" });
          await expect(setup.manager.build(signal)).resolves.toBeUndefined();
          expect(collect).toHaveBeenCalledOnce();
          await expect(setup.manager.search("alpha", signal, 1)).resolves.toHaveLength(1);
        } finally {
          collect.mockRestore();
        }
      });
    });
    describe("reconcileQueuedChanges()", () => {
      it("keeps related-note queries on the committed generation after failed staging", async () => {
        const contents: Record<string, string> = {
          "current.md": "alpha committed",
          "other.md": "alpha related",
        };
        const setup = manager(contents);
        await setup.manager.build(signal);
        expect((setup.manager as any).queryTexts).toBeUndefined();
        const before = setup.manager.relatedSnapshot("current.md")!;
        const beforeQuery = await before.prepareQuery(signal);
        contents["current.md"] = "beta uncommitted";
        setup.manager.queueChange("current.md");
        setup.model.embed.mockRejectedValueOnce(new Error("embedding failed"));

        await expect(setup.manager.reconcileQueuedChanges(signal)).rejects.toThrow(
          "embedding failed"
        );

        const after = setup.manager.relatedSnapshot("current.md")!;
        expect(after.generationId).toBe(before.generationId);
        expect(after.contentHash).toBe(before.contentHash);
        expect(await after.prepareQuery(signal)).toEqual(beforeQuery);
        expect((await after.prepareQuery(signal))?.text).toContain("alpha committed");
        expect((await after.prepareQuery(signal))?.text).not.toContain("beta uncommitted");
      });

      it("keeps related-note queries on the committed generation after cancelled staging", async () => {
        const contents: Record<string, string> = {
          "current.md": "alpha committed",
          "other.md": "alpha related",
        };
        const setup = manager(contents);
        await setup.manager.build(signal);
        const before = setup.manager.relatedSnapshot("current.md")!;
        const controller = new AbortController();
        contents["current.md"] = "beta cancelled";
        setup.manager.queueChange("current.md");
        setup.model.embed.mockImplementationOnce(async (texts: readonly string[]) => {
          controller.abort();
          return texts.map(() => [0, 1]);
        });

        await expect(setup.manager.reconcileQueuedChanges(controller.signal)).rejects.toThrow();

        const after = setup.manager.relatedSnapshot("current.md")!;
        expect(after.generationId).toBe(before.generationId);
        expect((await after.prepareQuery(signal))?.text).toContain("alpha committed");
        expect((await after.prepareQuery(signal))?.text).not.toContain("beta cancelled");
      });

      it("commits delete-only changes without embedding", async () => {
        const contents: Record<string, string> = { "a.md": "alpha" };
        const setup = manager(contents);
        await setup.manager.build(signal);
        setup.model.embed.mockClear();
        delete contents["a.md"];
        setup.manager.queueOperation({ kind: "delete", path: "a.md" });

        await setup.manager.reconcileQueuedChanges(signal);

        expect(setup.model.embed).not.toHaveBeenCalled();
        expect(JSON.parse((await setup.storage.read("active.json"))!).previous).toBeTruthy();
      });

      it("commits empty-note changes without embedding", async () => {
        const contents: Record<string, string> = { "a.md": "alpha" };
        const setup = manager(contents);
        await setup.manager.build(signal);
        setup.model.embed.mockClear();
        contents["a.md"] = "";
        setup.manager.queueOperation({ kind: "modify", path: "a.md" });

        await setup.manager.reconcileQueuedChanges(signal);

        expect(setup.model.embed).not.toHaveBeenCalled();
        expect(JSON.parse((await setup.storage.read("active.json"))!).current).toMatch(
          /^[0-9a-f]{64}$/
        );
      });

      it("rebuilds queued changes and supports upsert/delete seams", async () => {
        const setup = manager({ "a.md": "alpha" });
        await setup.manager.build(signal);
        setup.manager.queueChange("a.md");
        await setup.manager.reconcileQueuedChanges(signal);
        await setup.manager.upsert("a.md", signal);
        await setup.manager.delete("a.md", signal);
        await expect(setup.manager.search("alpha", signal, 1)).resolves.toHaveLength(0);
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
