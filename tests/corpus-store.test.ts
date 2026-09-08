import { describe, expect, it } from "vitest";
import { CorpusStore, type CorpusNoteInput } from "@/index/corpus/CorpusStore";
import { MemoryIndexStorage } from "@/index/storage";

const hex = (n: number) => n.toString(16).padStart(64, "0");
const note = (path: string, contentId: string, text = "hello"): CorpusNoteInput => ({
  path,
  contentId,
  records: [{ ordinal: 0, startLine: 1, endLine: 1, text, vector: [1, 0] }],
});

describe("CorpusStore", () => {
  it("publishes, reloads, pins, and lazily hydrates an immutable snapshot", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    const result = await store.build([note("a.md", hex(1))], hex(2));
    expect(result.snapshot.notes.map((n) => n.path)).toEqual(["a.md"]);
    const pinned = result.snapshot.pin();
    expect((await pinned.hydrateChunk("a.md", 0))?.text).toBe("hello");
    await pinned.release();
    const restarted = await new CorpusStore(storage).load();
    expect(restarted.generationId).toBe(result.generationId);
    await restarted.release();
  });

  it("supports empty notes and path-only rename without segment writes", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    await store.build([{ path: "empty.md", contentId: hex(3), records: [] }], hex(2));
    const before = storage.binaryFiles.size;
    const result = await store.incremental(
      [{ type: "rename", path: "renamed.md", previousPath: "empty.md" }],
      hex(2)
    );
    expect(result.snapshot.getNote("renamed.md")?.segments).toEqual([]);
    expect(storage.binaryFiles.size).toBe(before);
  });

  it("falls back to the previous generation when the current root is corrupt", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    const first = await store.build([note("a.md", hex(1))], hex(2));
    const second = await store.build([note("b.md", hex(4))], hex(2));
    storage.files.set(`generations/${second.generationId}/root.json`, "broken");
    const loaded = await store.load();
    expect(loaded.generationId).toBe(first.generationId);
    expect(loaded.notes.map((n) => n.path)).toEqual(["a.md"]);
  });

  it("validates a root before following a corrupt page count", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    const first = await store.build([note("a.md", hex(1))], hex(2));
    const second = await store.build([note("b.md", hex(4))], hex(2));
    const rootPath = `generations/${second.generationId}/root.json`;
    const root = JSON.parse((await storage.read(rootPath))!);
    root.pageCount = Number.MAX_SAFE_INTEGER;
    storage.files.set(rootPath, JSON.stringify(root));
    let pageReads = 0;
    const originalRead = storage.read.bind(storage);
    storage.read = async (path) => {
      if (path.startsWith(`generations/${second.generationId}/page-`)) pageReads++;
      return originalRead(path);
    };

    const loaded = await new CorpusStore(storage).load();

    expect(loaded.generationId).toBe(first.generationId);
    expect(pageReads).toBe(0);
  });

  it("rejects a root whose generation does not match the requested pointer", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    const first = await store.build([note("a.md", hex(1))], hex(2));
    const second = await store.build([note("b.md", hex(4))], hex(2));
    storage.files.set(
      `generations/${second.generationId}/root.json`,
      (await storage.read(`generations/${first.generationId}/root.json`))!
    );

    const loaded = await new CorpusStore(storage).load();

    expect(loaded.generationId).toBe(first.generationId);
  });

  it("does not publish when cancelled during staging and deduplicates unchanged content", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    const first = await store.build([note("a.md", hex(1))], hex(2));
    const controller = new AbortController();
    controller.abort();
    await expect(
      store.build([note("b.md", hex(4))], hex(2), { signal: controller.signal })
    ).rejects.toThrow(/cancelled/);
    expect((await store.load()).generationId).toBe(first.generationId);
    const before = storage.binaryFiles.size;
    await store.incremental([{ type: "unchanged", path: "a.md" }], hex(2));
    expect(storage.binaryFiles.size).toBe(before);
  });

  it("falls back to previous when a current segment is corrupt", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    const first = await store.build([note("a.md", hex(1))], hex(2));
    const current = await store.build([note("b.md", hex(3))], hex(2));
    const id = current.snapshot.notes[0].segments[0].id;
    const bytes = storage.binaryFiles.get(`segments/${id}.seg`)!;
    bytes[bytes.length - 1] ^= 1;
    const loaded = await new CorpusStore(storage).load();
    expect(loaded.generationId).toBe(first.generationId);
    expect(loaded.notes.map((entry) => entry.path)).toEqual(["a.md"]);
  });

  it("keeps the previous generation reachable after a second commit", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    const first = await store.build([note("a.md", hex(1))], hex(2));
    const second = await store.build([note("b.md", hex(2))], hex(2));
    const pointer = JSON.parse((await storage.read("active.json"))!);
    expect(pointer.current).toBe(second.generationId);
    expect(pointer.previous).toBe(first.generationId);
    expect((await store.load()).generationId).toBe(second.generationId);
  });

  it("uses the pointer backup when the active pointer is malformed", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    const built = await store.build([note("a.md", hex(1))], hex(2));
    const pointer = storage.files.get("active.json")!;
    storage.files.set("active.json.bak", pointer);
    storage.files.set("active.json", "not-json");
    expect((await store.load()).generationId).toBe(built.generationId);
  });

  it("serializes competing writers", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    let resolve!: () => void;
    const gate = new Promise<void>((r) => (resolve = r));
    const first = store.build(
      (async function* () {
        yield note("a.md", hex(1));
        await gate;
      })(),
      hex(2)
    );
    await expect(store.build([note("b.md", hex(2))], hex(2))).rejects.toThrow(/busy/);
    resolve();
    await first;
  });

  it("never removes unknown files during conservative GC", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    await store.build([note("a.md", hex(1))], hex(2));
    storage.files.set("mystery.txt", "keep");
    const result = await store.collectGarbage();
    expect(result.errors).toBe(0);
    expect(storage.files.get("mystery.txt")).toBe("keep");
  });

  it("collects unreachable generation and segment artifacts while retaining current and previous", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    const first = await store.build([note("a.md", hex(1))], hex(2));
    const second = await store.build([note("b.md", hex(3))], hex(2));
    const firstSegment = first.snapshot.notes[0].segments[0].id;
    const secondSegment = second.snapshot.notes[0].segments[0].id;
    const orphanGeneration = hex(99);
    const orphanSegment = hex(98);
    storage.files.set(`generations/${orphanGeneration}/root.json`, "orphan");
    storage.binaryFiles.set(`segments/${orphanSegment}.seg`, new Uint8Array([1]));
    storage.files.set("generations/1.json", "legacy");

    const result = await store.collectGarbage();

    expect(result.errors).toBe(0);
    expect(await storage.read(`generations/${orphanGeneration}/root.json`)).toBeNull();
    expect(storage.binaryFiles.has(`segments/${orphanSegment}.seg`)).toBe(false);
    expect(await storage.read("generations/1.json")).toBeNull();
    expect(await storage.read(`generations/${first.generationId}/root.json`)).not.toBeNull();
    expect(await storage.read(`generations/${second.generationId}/root.json`)).not.toBeNull();
    expect(storage.binaryFiles.has(`segments/${firstSegment}.seg`)).toBe(true);
    expect(storage.binaryFiles.has(`segments/${secondSegment}.seg`)).toBe(true);
  });

  it("does not delete anything when a retained manifest page is malformed", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    await store.build([note("a.md", hex(1))], hex(2));
    const second = await store.build([note("b.md", hex(3))], hex(2));
    const orphanSegment = hex(98);
    storage.binaryFiles.set(`segments/${orphanSegment}.seg`, new Uint8Array([1]));
    storage.files.set(`generations/${second.generationId}/page-0.json`, "malformed");

    const result = await store.collectGarbage();

    expect(result).toEqual({ removed: 0, errors: 1 });
    expect(storage.binaryFiles.has(`segments/${orphanSegment}.seg`)).toBe(true);
  });

  it("does not delete anything when a retained manifest page is missing", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    const first = await store.build([note("a.md", hex(1))], hex(2));
    await store.build([note("b.md", hex(3))], hex(2));
    const orphanSegment = hex(98);
    storage.binaryFiles.set(`segments/${orphanSegment}.seg`, new Uint8Array([1]));
    storage.files.delete(`generations/${first.generationId}/page-0.json`);

    const result = await store.collectGarbage();

    expect(result).toEqual({ removed: 0, errors: 1 });
    expect(storage.binaryFiles.has(`segments/${orphanSegment}.seg`)).toBe(true);
  });

  it("does not delete anything when a retained segment is missing", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    const first = await store.build([note("a.md", hex(1))], hex(2));
    await store.build([note("b.md", hex(3))], hex(2));
    const retainedSegment = first.snapshot.notes[0].segments[0].id;
    const orphanSegment = hex(98);
    storage.binaryFiles.delete(`segments/${retainedSegment}.seg`);
    storage.binaryFiles.set(`segments/${orphanSegment}.seg`, new Uint8Array([1]));

    const result = await store.collectGarbage();

    expect(result).toEqual({ removed: 0, errors: 1 });
    expect(storage.binaryFiles.has(`segments/${orphanSegment}.seg`)).toBe(true);
  });

  it("does not delete anything when a pinned snapshot segment is corrupt", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    const first = await store.build([note("pinned.md", hex(1))], hex(2));
    const pinned = first.snapshot.pin();
    await store.build([note("middle.md", hex(3))], hex(2));
    await store.build([note("current.md", hex(4))], hex(2));
    const pinnedSegment = first.snapshot.notes[0].segments[0].id;
    const orphanSegment = hex(98);
    storage.binaryFiles.get(`segments/${pinnedSegment}.seg`)![128] ^= 1;
    storage.binaryFiles.set(`segments/${orphanSegment}.seg`, new Uint8Array([1]));

    const result = await store.collectGarbage();

    expect(result).toEqual({ removed: 0, errors: 1 });
    expect(storage.binaryFiles.has(`segments/${orphanSegment}.seg`)).toBe(true);
    await pinned.release();
  });

  it("keeps artifacts referenced only by a pinned in-memory snapshot", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    const first = await store.build([note("pinned.md", hex(1))], hex(2));
    const pinned = first.snapshot.pin();
    const pinnedSegment = first.snapshot.notes[0].segments[0].id;
    await store.build([note("middle.md", hex(3))], hex(2));
    await store.build([note("current.md", hex(4))], hex(2));

    const result = await store.collectGarbage();

    expect(result.errors).toBe(0);
    expect(await storage.read(`generations/${first.generationId}/root.json`)).not.toBeNull();
    expect(storage.binaryFiles.has(`segments/${pinnedSegment}.seg`)).toBe(true);
    await pinned.release();
  });

  it("stages without activation and promotes the exact pinned snapshot", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    await store.build([note("old.md", hex(1))], hex(2));
    const transaction = await store.stage([note("new.md", hex(2))], hex(2));
    expect(JSON.parse((await storage.read("active.json"))!).current).not.toBe(
      transaction.snapshot.generationId
    );
    const committed = await transaction.commit();
    expect(committed.snapshot).toBe(transaction.snapshot);
    expect((await store.load()).generationId).toBe(transaction.snapshot.generationId);
  });

  it("aborting a staged transaction leaves the pointer unchanged", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    const initial = await store.build([note("old.md", hex(1))], hex(2));
    const transaction = await store.stage([note("new.md", hex(2))], hex(2));
    await transaction.abort();
    expect((await store.load()).generationId).toBe(initial.generationId);
    const next = await store.stage([note("again.md", hex(3))], hex(2));
    await next.abort();
  });

  it("stages incremental manifest operations without hydrating reused segments", async () => {
    const storage = new MemoryIndexStorage();
    const store = new CorpusStore(storage);
    const first = await store.build([note("old.md", hex(1)), note("delete.md", hex(3))], hex(2));
    const tx = await store.stageIncremental(
      first.snapshot,
      [
        { type: "rename", path: "renamed.md", previousPath: "old.md" },
        { type: "delete", path: "delete.md" },
        {
          type: "empty",
          path: "empty.md",
          note: { path: "empty.md", contentId: hex(5), records: [] },
        },
      ],
      hex(2)
    );
    expect(tx.snapshot.getNote("renamed.md")?.segments).toEqual(
      first.snapshot.getNote("old.md")?.segments
    );
    expect(tx.snapshot.getNote("delete.md")).toBeUndefined();
    expect(tx.snapshot.getNote("empty.md")?.segments).toEqual([]);
    await tx.abort();
  });
});
