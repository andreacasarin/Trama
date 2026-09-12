import { describe, expect, it, vi } from "vitest";
import { IndexManager, createIndexFingerprint } from "@/index/IndexManager";
import { createTalaNamespace } from "@/index/taladb/namespace";
import { MemoryIndexStorage, StrictIndexStorage } from "@/index/taladb/storage";
import { CHUNK_OVERLAP, CHUNK_SIZE, chunkMarkdown } from "@/index/chunking";

const signal = new AbortController().signal;

function fixture(contents: Record<string, string>) {
  return {
    listMarkdownPaths: async () => Object.keys(contents),
    readMarkdown: async (path: string) => {
      if (!(path in contents)) throw new Error(`Markdown note is unavailable: ${path}`);
      return { path, content: contents[path] };
    },
    isMarkdownAvailable: async (path: string) => path in contents,
  };
}

function embedding() {
  return {
    dimensions: 2,
    embed: vi.fn(async (texts: readonly string[]) =>
      texts.map((text) => (text.toLowerCase().includes("alpha") ? [1, 0] : [0, 1]))
    ),
  };
}

function manager(contents: Record<string, string>, storage = new MemoryIndexStorage()) {
  const model = embedding();
  const index = new IndexManager(
    fixture(contents),
    model,
    storage,
    "http://127.0.0.1:1234/v1",
    "embed",
    { backend: "memory", namespace: createTalaNamespace("test") }
  );
  return { index, model, storage };
}

describe("Tala index lifecycle", () => {
  it("uses stable fingerprinted chunk defaults", () => {
    expect(createIndexFingerprint("HTTP://LOCALHOST/v1/", "model", 768)).toMatchObject({
      embeddingBaseUrl: "http://localhost/v1",
      dimensions: 768,
      chunking: { size: CHUNK_SIZE, overlap: CHUNK_OVERLAP },
    });
    expect(chunkMarkdown("alpha")).toHaveLength(1);
  });

  it("builds, persists a Tala state marker, and searches with provenance", async () => {
    const first = manager({ "b.md": "beta", "a.md": "alpha" });
    await first.index.build(signal);
    expect(first.storage.files.has("taladb-v1/test/state.json")).toBe(true);
    await expect(first.index.search("alpha", signal, 1)).resolves.toMatchObject([
      { path: "a.md", startLine: 1 },
    ]);
    const restarted = new IndexManager(
      fixture({ "b.md": "beta", "a.md": "alpha" }),
      embedding(),
      first.storage,
      "http://127.0.0.1:1234/v1",
      "embed",
      { backend: "memory", namespace: createTalaNamespace("test") }
    );
    await expect(restarted.load()).resolves.toBe(true);
    await restarted.close();
  });

  it("updates only changed rows and converges deletes/renames deterministically", async () => {
    const contents: Record<string, string> = { "old.md": "alpha", "keep.md": "beta" };
    const setup = manager(contents);
    await setup.index.build(signal);
    contents["old.md"] = "changed beta";
    delete contents["keep.md"];
    contents["new.md"] = "alpha";
    setup.index.queueRename("old.md", "new.md");
    await setup.index.synchronize(signal);
    expect(setup.index.state()?.status).toBe("ready");
    await expect(setup.index.search("alpha", signal, 10)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "new.md" })])
    );
  });

  it("preserves cancellation and leaves a usable prior index", async () => {
    const contents = { "a.md": "alpha" };
    const setup = manager(contents);
    await setup.index.build(signal);
    const before = setup.index.relatedSnapshot("a.md");
    expect(before).not.toBeNull();
    const controller = new AbortController();
    controller.abort();
    contents["a.md"] = "changed";
    setup.index.queueChange("a.md");
    await expect(setup.index.reconcileQueuedChanges(controller.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    await expect(setup.index.search("alpha", signal, 1)).resolves.toHaveLength(1);
  });

  it("keeps index paths contained and adapter receiver-safe", async () => {
    const adapter = {
      root: ".trama/index",
      read: vi.fn(async () => null),
      write: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      activate: vi.fn(async () => undefined),
    };
    const storage = new StrictIndexStorage(".trama/index", adapter);
    await storage.write("taladb-v1/default/state.json", "{}");
    expect(adapter.write).toHaveBeenCalledWith(".trama/index/taladb-v1/default/state.json", "{}");
    expect(() => storage.read("../escape")).toThrow();
  });
});
