import { describe, expect, it, vi } from "vitest";
import { StructuredError, type IndexProgress } from "@/domain/contracts";
import { CHUNK_OVERLAP, CHUNK_SIZE, chunkMarkdown } from "@/index/chunking";
import { createIndexFingerprint, IndexManager } from "@/index/IndexManager";
import { oramaDocumentId, parseOramaDocumentId } from "@/index/Identity";
import {
  MemoryIndexStorage,
  ObsidianIndexStorage,
  StrictIndexStorage,
  type IndexStorageReplaceCapability,
} from "@/index/storage";
import { decodeSnapshot, loadAndValidateSnapshot } from "@/index/orama/SnapshotCodec";
import { formatIndexProgress } from "@/ui/index/IndexStatus";
import type { TramaDiagnosticRecord, TramaDiagnostics } from "@/diagnostics/TramaDiagnostics";

const signal = new AbortController().signal;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function embeddings() {
  const embed = vi.fn(async (texts: readonly string[]) =>
    texts.map((text) => {
      const vector = Array.from({ length: 768 }, () => 0);
      vector[text.toLowerCase().includes("beta") ? 1 : 0] = 1;
      return vector;
    })
  );
  return { dimensions: 768, embed };
}

function fixture(contents: Record<string, string>) {
  return {
    listMarkdownPaths: async () => Object.keys(contents),
    readMarkdown: async (path: string) => {
      if (!(path in contents)) throw new Error(`Synthetic note is unavailable: ${path}`);
      return { path, content: contents[path] };
    },
    isMarkdownAvailable: async (path: string) => path in contents,
  };
}

function manager(
  contents: Record<string, string>,
  storage = new MemoryIndexStorage(),
  model = embeddings(),
  diagnostics?: TramaDiagnostics
) {
  return {
    manager: new IndexManager(
      fixture(contents),
      model,
      storage,
      "http://synthetic.invalid/v1",
      "synthetic",
      {
        size: 100,
        overlap: 10,
      },
      diagnostics
    ),
    storage,
    model,
  };
}

class ToggleReplaceStorage extends MemoryIndexStorage {
  supported = true;

  override async verifyReplaceCapability(): Promise<IndexStorageReplaceCapability> {
    if (!this.supported)
      throw new StructuredError("internal", "synthetic replacement capability unavailable", true);
    return super.verifyReplaceCapability();
  }
}

class AbortBeforeReplaceStorage extends MemoryIndexStorage {
  abortOnTemporaryRead = false;

  constructor(private readonly controller: AbortController) {
    super();
  }

  override async read(path: string): Promise<string | null> {
    const value = await super.read(path);
    if (path === "index.json.tmp" && this.abortOnTemporaryRead) {
      this.abortOnTemporaryRead = false;
      this.controller.abort();
    }
    return value;
  }
}

class AbortDuringReplaceStorage extends MemoryIndexStorage {
  armed = false;

  constructor(private readonly controller: AbortController) {
    super();
  }

  override async replace(from: string, to: string): Promise<void> {
    if (this.armed) {
      this.controller.abort();
      await Promise.resolve();
    }
    await super.replace(from, to);
  }
}

class ProbeCleanupStorage extends MemoryIndexStorage {
  readonly removeAttempts: string[] = [];
  failSource = false;
  failTarget = false;

  override async remove(path: string): Promise<void> {
    this.removeAttempts.push(path);
    if (path.includes("-source") && this.failSource)
      throw new Error("synthetic source cleanup failure");
    if (path.includes("-target") && this.failTarget)
      throw new Error("synthetic target cleanup failure");
    await super.remove(path);
  }

  override async replace(_from: string, _to: string): Promise<void> {
    throw new Error("synthetic primary probe failure");
  }
}

class SnapshotCleanupStorage extends MemoryIndexStorage {
  failReplacement = false;
  failTemporaryRemoval = false;

  override async replace(from: string, to: string): Promise<void> {
    if (this.failReplacement) throw new Error("synthetic primary snapshot failure");
    await super.replace(from, to);
  }

  override async remove(path: string): Promise<void> {
    if (path === "index.json.tmp" && this.failTemporaryRemoval)
      throw new Error("synthetic temporary cleanup failure");
    await super.remove(path);
  }
}

describe("mutable Orama index", () => {
  it("uses canonical reversible IDs and deterministic fingerprint inputs", () => {
    expect(oramaDocumentId("./folder\\note.md", 3)).toBe('["folder/note.md",3]');
    expect(parseOramaDocumentId('["folder/note.md",3]')).toEqual({
      path: "folder/note.md",
      ordinal: 3,
    });
    expect(() => parseOramaDocumentId('["trama-chunk-v1","note.md",0]')).toThrow();
    expect({ size: CHUNK_SIZE, overlap: CHUNK_OVERLAP }).toEqual({ size: 384, overlap: 64 });
    expect(createIndexFingerprint(" HTTP://SYNTHETIC.invalid/v1/ ", "m", 768)).toEqual(
      createIndexFingerprint("http://synthetic.invalid/v1", "m", 768)
    );
  });

  it("keeps chunking deterministic and line-aware", () => {
    const value = "one\ntwo\nthree\nfour";
    expect(chunkMarkdown(value, 7, 2)).toEqual(chunkMarkdown(value, 7, 2));
    expect(
      chunkMarkdown("x".repeat(1_001), 100, 10).every((chunk) => chunk.text.length <= 100)
    ).toBe(true);
  });

  it("switches full embedding progress to indeterminate after exceeding its estimate", async () => {
    const progress: IndexProgress[] = [];
    const indexed = new IndexManager(
      {
        listMarkdownPaths: async () => ["first.md", "second.md"],
        readMarkdown: async (path) => ({ path, content: path }),
        isMarkdownAvailable: async () => true,
        estimateMarkdownTextCount: async () => 1,
      },
      embeddings(),
      new MemoryIndexStorage(),
      "http://synthetic.invalid/v1",
      "synthetic",
      {
        size: 100,
        overlap: 10,
        onProgress: (value) => progress.push(value),
      }
    );

    await indexed.build(signal);

    const embeddingProgress = progress.filter(({ phase }) => phase === "embed");
    expect(embeddingProgress).toEqual([
      expect.objectContaining({
        operation: "full",
        completed: 1,
        total: 1,
        determinate: true,
        estimated: true,
      }),
      expect.objectContaining({
        operation: "full",
        completed: 2,
        determinate: false,
        estimated: false,
      }),
      expect.objectContaining({
        operation: "full",
        completed: 2,
        total: 2,
        determinate: true,
      }),
    ]);
    expect(embeddingProgress[1]).not.toHaveProperty("total");
    expect(
      embeddingProgress.some(
        ({ completed, total, determinate }) =>
          determinate && total !== undefined && completed > total
      )
    ).toBe(false);
    expect(formatIndexProgress(embeddingProgress[1]!)).toBe("Creating embeddings — 2 texts");
    expect(formatIndexProgress(embeddingProgress[2]!)).toBe("Creating embeddings — 2 of 2 texts");
  });

  it("builds, searches, validates, and reloads only the completed single snapshot", async () => {
    const contents = { "a.md": "alpha", "b.md": "beta" };
    const setup = manager(contents);
    await setup.manager.build(signal);
    const results = await setup.manager.search("alpha", signal, 5);
    expect(results[0]).toMatchObject({ path: "a.md" });
    expect([...setup.storage.files.keys()]).toEqual(["index.json"]);
    const raw = await setup.storage.read("index.json");
    const envelope = decodeSnapshot(raw!);
    expect(envelope.complete).toBe(true);
    await expect(loadAndValidateSnapshot(raw!)).resolves.toBeTruthy();
    const missingPayload = JSON.parse(raw!);
    delete missingPayload.payload;
    await expect(
      Promise.resolve().then(() => decodeSnapshot(JSON.stringify(missingPayload)))
    ).rejects.toThrow();
    const restarted = manager(contents, setup.storage);
    await expect(restarted.manager.load()).resolves.toBe(true);
    const restartedResults = await restarted.manager.search("beta", signal, 5);
    expect(restartedResults[0]).toMatchObject({ path: "b.md" });
  });

  it("performs availability-first update convergence and skips unchanged embedding", async () => {
    const contents: Record<string, string> = { "old.md": "alpha", "delete.md": "beta" };
    const setup = manager(contents);
    await setup.manager.build(signal);
    const calls = setup.model.embed.mock.calls.length;
    const before = setup.manager.projection.documentsForPath("old.md")[0];
    contents["new.md"] = contents["old.md"];
    delete contents["old.md"];
    delete contents["delete.md"];
    await expect(setup.manager.synchronizeWithPublication(signal)).resolves.toBe(true);
    expect(setup.model.embed.mock.calls.length).toBe(calls);
    expect(setup.manager.projection.documentsForPath("old.md")).toHaveLength(0);
    const after = setup.manager.projection.documentsForPath("new.md")[0];
    expect(after?.embedding).toEqual(before?.embedding);
    expect(after?.chunkId).toBe(before?.chunkId);
    const snapshot = await setup.storage.read("index.json");
    await expect(setup.manager.synchronizeWithPublication(signal)).resolves.toBe(false);
    expect(await setup.storage.read("index.json")).toBe(snapshot);
  });

  it("waits for a direct update before reconciling events queued during it", async () => {
    const contents: Record<string, string> = { "note.md": "alpha" };
    const storage = new MemoryIndexStorage();
    const model = embeddings();
    const setup = manager(contents, storage, model);
    await setup.manager.build(signal);

    const originalEmbed = model.embed;
    const release = deferred<void>();
    let blocked = false;
    model.embed = vi.fn(async (texts: readonly string[]) => {
      if (blocked) await release.promise;
      return originalEmbed(texts);
    });

    contents["note.md"] = "beta";
    blocked = true;
    const direct = setup.manager.synchronizeWithPublication(signal);
    await vi.waitFor(() => expect(model.embed).toHaveBeenCalledTimes(1));

    contents["note.md"] = "gamma";
    setup.manager.queueChange("note.md");
    let queuedSettled = false;
    const queued = setup.manager.reconcileQueuedChangesWithPublication(signal).finally(() => {
      queuedSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queuedSettled).toBe(false);

    release.resolve();
    await expect(direct).resolves.toBe(true);
    await expect(queued).resolves.toBe(true);
    expect(setup.manager.projection.documentsForPath("note.md")[0]?.body).toBe("gamma");
    await expect(setup.manager.waitForBuild()).resolves.toBeUndefined();

    const restarted = manager(contents, storage, embeddings()).manager;
    await expect(restarted.load()).resolves.toBe(true);
    expect(restarted.projection.documentsForPath("note.md")[0]?.body).toBe("gamma");
  });

  it("clears the direct update wait promise after a rejection", async () => {
    const contents: Record<string, string> = { "note.md": "alpha" };
    const storage = new SnapshotCleanupStorage();
    const setup = manager(contents, storage);
    await setup.manager.build(signal);
    storage.failReplacement = true;
    contents["note.md"] = "beta";
    setup.manager.queueChange("note.md");

    await expect(setup.manager.synchronizeWithPublication(signal)).rejects.toMatchObject({
      message: "synthetic primary snapshot failure",
    });
    expect(setup.manager.isBuilding()).toBe(false);
    await expect(setup.manager.waitForBuild()).resolves.toBeUndefined();
  });

  it("retains rebuild-time rename, delete, and create events for post-build convergence", async () => {
    const contents: Record<string, string> = {
      "old.md": "alpha",
      "delete.md": "beta",
    };
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    let pauseRead = true;
    const vault = {
      listMarkdownPaths: async () => Object.keys(contents),
      readMarkdown: async (path: string) => {
        if (pauseRead) {
          pauseRead = false;
          readStarted.resolve();
          await releaseRead.promise;
        }
        const content = contents[path];
        if (content === undefined) throw new Error(`Synthetic note is unavailable: ${path}`);
        return { path, content };
      },
      isMarkdownAvailable: async (path: string) => path in contents,
    };
    const storage = new MemoryIndexStorage();
    const indexed = new IndexManager(
      vault,
      embeddings(),
      storage,
      "http://synthetic.invalid/v1",
      "synthetic",
      { size: 100, overlap: 10 }
    );
    const build = indexed.build(signal);
    await readStarted.promise;

    contents["renamed.md"] = contents["old.md"];
    delete contents["old.md"];
    delete contents["delete.md"];
    contents["created.md"] = "gamma";
    indexed.queueChange("old.md");
    indexed.queueRename("old.md", "renamed.md");
    indexed.queueOperation({ kind: "delete", path: "delete.md" });
    indexed.queueOperation({ kind: "create", path: "created.md" });
    releaseRead.resolve();

    await build;
    expect(indexed.projection.catalog.notes).toHaveLength(0);
    await expect(indexed.reconcileQueuedChanges(signal)).resolves.toBeUndefined();
    expect(indexed.getLastReconciliationPublished()).toBe(true);
    expect(indexed.projection.catalog.notes.map((note) => note.path)).toEqual([
      "created.md",
      "renamed.md",
    ]);
    expect([...storage.files.keys()]).toEqual(["index.json"]);

    const restarted = new IndexManager(
      vault,
      embeddings(),
      storage,
      "http://synthetic.invalid/v1",
      "synthetic",
      { size: 100, overlap: 10 }
    );
    await expect(restarted.load()).resolves.toBe(true);
    expect(restarted.projection.catalog.notes.map((note) => note.path)).toEqual([
      "created.md",
      "renamed.md",
    ]);
  });

  it("leaves a partial live projection after cancellation and repairs it later", async () => {
    const contents: Record<string, string> = { "a.md": "alpha", "b.md": "beta" };
    const model = embeddings();
    const setup = manager(contents, new MemoryIndexStorage(), model);
    await setup.manager.build(signal);
    const original = model.embed;
    let cancelled = false;
    model.embed = vi.fn(async (texts: readonly string[]) => {
      if (!cancelled) {
        cancelled = true;
        throw new StructuredError("cancelled", "synthetic cancellation", true);
      }
      return original(texts);
    });
    contents["a.md"] = "alpha changed";
    setup.manager.queueChange("a.md");
    await expect(setup.manager.reconcileQueuedChanges(signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(setup.manager.hasUsableIndex()).toBe(true);
    await expect(setup.manager.reconcileQueuedChanges(signal)).resolves.toBeUndefined();
    const results = await setup.manager.search("alpha changed", signal, 5);
    expect(results[0]).toMatchObject({ path: "a.md" });
  });

  it("rejects corrupt or mismatched startup snapshots without fallback", async () => {
    const contents = { "a.md": "alpha" };
    const setup = manager(contents);
    await setup.manager.build(signal);
    const good = await setup.storage.read("index.json");
    await setup.storage.write("index.json", "not-json");
    await expect(manager(contents, setup.storage).manager.load()).resolves.toBe(false);
    await setup.storage.write("index.json", good!);
    await expect(manager(contents, setup.storage, embeddings()).manager.load()).resolves.toBe(true);
    await expect(manager(contents, setup.storage, embeddings()).manager.load()).resolves.toBe(true);
  });
});

describe("single-file index storage", () => {
  it("confines paths and replaces a completed snapshot", async () => {
    const adapter = new MemoryIndexStorage("vault");
    const strict = new StrictIndexStorage(".trama", adapter);
    await strict.write("index.json.tmp", "new");
    await expect(strict.verifyReplaceCapability()).resolves.toMatchObject({
      operation: "same-directory-overwrite",
    });
    await strict.replace("index.json.tmp", "index.json");
    expect(adapter.files.get(".trama/index.json")).toBe("new");
    await expect(Promise.resolve().then(() => strict.write("../outside", "bad"))).rejects.toThrow();
  });

  it("rejects unsupported overwrite before modifying an existing snapshot", async () => {
    const contents = { "note.md": "alpha" };
    const storage = new ToggleReplaceStorage();
    storage.supported = false;
    const indexed = manager(contents, storage).manager;
    await expect(indexed.build(signal)).rejects.toMatchObject({ code: "internal" });
    expect(await storage.read("index.json")).toBeNull();
    expect(await storage.read("index.json.tmp")).toBeNull();

    storage.supported = true;
    await indexed.build(signal);
    const previous = await storage.read("index.json");
    storage.supported = false;
    contents["note.md"] = "beta";
    indexed.queueChange("note.md");
    await expect(indexed.reconcileQueuedChanges(signal)).rejects.toMatchObject({
      code: "internal",
    });
    expect(await storage.read("index.json")).toBe(previous);
    expect(await storage.read("index.json.tmp")).toBeNull();
    expect(indexed.projection.dirty).toBe(true);
  });

  it("attempts both probe cleanup removals and preserves the primary error", async () => {
    for (const [failSource, failTarget] of [
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      const storage = new ProbeCleanupStorage();
      storage.failSource = failSource;
      storage.failTarget = failTarget;
      await expect(storage.verifyReplaceCapability()).rejects.toMatchObject({
        message: "synthetic primary probe failure",
        cleanupFailed: true,
      });
      expect(storage.removeAttempts.filter((path) => path.includes("-source"))).toHaveLength(1);
      expect(storage.removeAttempts.filter((path) => path.includes("-target"))).toHaveLength(1);
    }
  });

  it("preserves snapshot errors when temporary cleanup also fails", async () => {
    const storage = new SnapshotCleanupStorage();
    const diagnostics: TramaDiagnosticRecord[] = [];
    const sink: TramaDiagnostics = { emit: (record) => diagnostics.push(record) };
    const contents = { "note.md": "alpha" };
    const indexed = manager(contents, storage, embeddings(), sink).manager;
    await indexed.build(signal);
    contents["note.md"] = "beta";
    storage.failReplacement = true;
    storage.failTemporaryRemoval = true;
    indexed.queueChange("note.md");

    await expect(indexed.reconcileQueuedChanges(signal)).rejects.toMatchObject({
      message: "synthetic primary snapshot failure",
    });
    expect(indexed.projection.dirty).toBe(true);
    expect(await storage.read("index.json.tmp")).not.toBeNull();
    expect(
      diagnostics.some(
        (record) =>
          record.area === "index" &&
          record.event === "index_operation" &&
          record.stage === "cleanup-failed" &&
          record.error?.name === "Error"
      )
    ).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toMatch(/synthetic|index\.json/);
  });

  it("keeps cancellation before replacement dirty and commit cancellation wins", async () => {
    const beforeController = new AbortController();
    const beforeStorage = new AbortBeforeReplaceStorage(beforeController);
    const beforeContents = { "note.md": "alpha" };
    const before = manager(beforeContents, beforeStorage).manager;
    await before.build(signal);
    const previous = await beforeStorage.read("index.json");
    beforeContents["note.md"] = "beta";
    beforeStorage.abortOnTemporaryRead = true;
    before.queueChange("note.md");
    await expect(before.reconcileQueuedChanges(beforeController.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(await beforeStorage.read("index.json")).toBe(previous);
    expect(await beforeStorage.read("index.json.tmp")).toBeNull();
    expect(before.projection.dirty).toBe(true);

    const duringController = new AbortController();
    const duringStorage = new AbortDuringReplaceStorage(duringController);
    const duringContents = { "note.md": "alpha" };
    const during = manager(duringContents, duringStorage).manager;
    await during.build(signal);
    const oldSnapshot = await duringStorage.read("index.json");
    duringContents["note.md"] = "beta";
    duringStorage.armed = true;
    during.queueChange("note.md");
    await expect(during.reconcileQueuedChanges(duringController.signal)).resolves.toBeUndefined();
    expect(duringController.signal.aborted).toBe(true);
    expect(await duringStorage.read("index.json")).not.toBe(oldSnapshot);
    expect(duringStorage.files.has("index.json.tmp")).toBe(false);
    expect(during.projection.dirty).toBe(false);
    expect(during.getLastReconciliationPublished()).toBe(true);
  });

  it("preserves the adapter receiver for the Obsidian single-rename boundary", async () => {
    const files = new Map<string, string>();
    files.set(".trama/index/legacy.bin", "legacy");
    const adapter = {
      marker: "adapter",
      exists: async function (this: { marker: string }, path: string) {
        expect(this.marker).toBe("adapter");
        return files.has(path);
      },
      read: async function (this: { marker: string }, path: string) {
        expect(this.marker).toBe("adapter");
        return files.get(path) ?? "";
      },
      write: async function (this: { marker: string }, path: string, value: string) {
        expect(this.marker).toBe("adapter");
        files.set(path, value);
      },
      remove: async function (this: { marker: string }, path: string) {
        expect(this.marker).toBe("adapter");
        files.delete(path);
      },
      rename: async function (this: { marker: string }, from: string, to: string) {
        expect(this.marker).toBe("adapter");
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      mkdir: async function (this: { marker: string }) {
        expect(this.marker).toBe("adapter");
      },
    };
    const storage = new ObsidianIndexStorage(adapter, ".trama");
    await storage.write("index.json.tmp", "snapshot");
    await expect(storage.verifyReplaceCapability()).resolves.toMatchObject({
      operation: "same-directory-overwrite",
    });
    await storage.replace("index.json.tmp", "index.json");
    expect(files.get(".trama/index.json")).toBe("snapshot");
    expect(files.has(".trama/index.json.tmp")).toBe(false);
    expect(files.get(".trama/index/legacy.bin")).toBe("legacy");
  });
});
