import { describe, expect, it, vi } from "vitest";
import { IndexManager } from "@/index/IndexManager";
import { RelatedNotes } from "@/index/RelatedNotes";
import { oramaDocumentId, parseOramaDocumentId } from "@/index/Identity";
import { MemoryIndexStorage } from "@/index/storage";
import { searchOrama } from "@/index/orama/OramaDatabase";
import { decodeSnapshot, loadAndValidateSnapshot } from "@/index/orama/SnapshotCodec";

const signal = new AbortController().signal;

function embeddingModel() {
  const embed = vi.fn(async (texts: readonly string[]) =>
    texts.map((text) => {
      const vector = Array.from({ length: 768 }, () => 0);
      vector[text.includes("beta") ? 1 : 0] = 1;
      return vector;
    })
  );
  return { dimensions: 768, embed };
}

function vault(contents: Record<string, string>) {
  return {
    listMarkdownPaths: async () => Object.keys(contents),
    readMarkdown: async (path: string) => {
      const content = contents[path];
      if (content === undefined) throw new Error(`Synthetic note is unavailable: ${path}`);
      return { path, content };
    },
    isMarkdownAvailable: async (path: string) => contents[path] !== undefined,
  };
}

function manager(
  contents: Record<string, string>,
  storage: MemoryIndexStorage,
  model = embeddingModel()
) {
  return new IndexManager(
    vault(contents),
    model,
    storage,
    "http://synthetic.invalid/v1",
    "synthetic",
    { size: 100, overlap: 10 }
  );
}

describe("mutable Orama projection", () => {
  it("uses reversible path-plus-ordinal IDs and a strict single-file snapshot", async () => {
    const contents = { "b.md": "beta", "a.md": "alpha" };
    const storage = new MemoryIndexStorage();
    const indexed = manager(contents, storage);
    await indexed.build(signal);

    expect(oramaDocumentId("a.md", 0)).toBe('["a.md",0]');
    expect(parseOramaDocumentId('["a.md",0]')).toEqual({ path: "a.md", ordinal: 0 });
    expect([...storage.files.keys()]).toEqual(["index.json"]);
    const raw = await storage.read("index.json");
    expect(raw).toBeTruthy();
    const envelope = decodeSnapshot(raw!);
    expect(envelope.complete).toBe(true);
    expect(envelope.catalog.notes.map((note) => note.path)).toEqual(["a.md", "b.md"]);
    await expect(loadAndValidateSnapshot(raw!)).resolves.toBeTruthy();
  });

  it("keeps native Orama hybrid evidence at equal text/vector weights", async () => {
    const setup = manager({ "a.md": "alpha" }, new MemoryIndexStorage());
    await setup.build(signal);
    const document = setup.projection.documentsForPath("a.md")[0];
    expect(document).toBeDefined();
    const result = await searchOrama(setup.projection.db, {
      mode: "hybrid",
      term: "alpha",
      properties: ["body"],
      vector: { value: [...document!.embedding], property: "embedding" },
      hybridWeights: { text: 0.5, vector: 0.5 },
      limit: 1,
    });
    expect(result.hits).toHaveLength(1);
    expect(Array.isArray((result.hits[0]?.document as { embedding?: unknown }).embedding)).toBe(
      true
    );
  });

  it("converges rename/delete/modify incrementally while preserving the rename vector", async () => {
    const contents: Record<string, string> = { "old.md": "alpha", "remove.md": "beta" };
    const storage = new MemoryIndexStorage();
    const model = embeddingModel();
    const indexed = manager(contents, storage, model);
    await indexed.build(signal);
    const callsAfterBuild = model.embed.mock.calls.length;
    const before = indexed.projection.documentsForPath("old.md")[0];
    expect(before).toBeTruthy();

    delete contents["remove.md"];
    contents["new.md"] = contents["old.md"];
    delete contents["old.md"];
    await indexed.synchronizeWithPublication(signal);

    expect(model.embed.mock.calls.length).toBe(callsAfterBuild);
    expect(indexed.projection.documentsForPath("old.md")).toHaveLength(0);
    const after = indexed.projection.documentsForPath("new.md")[0];
    expect(after?.embedding).toEqual(before?.embedding);
    expect(after?.chunkId).toBe(before?.chunkId);
    expect(indexed.projection.documentsForPath("remove.md")).toHaveLength(0);
    await expect(indexed.search("alpha", signal, 5)).resolves.toMatchObject([{ path: "new.md" }]);
  });

  it("fills Filo's unique-note results past a dominant note's top 128 chunks", async () => {
    const contents: Record<string, string> = {
      "current.md": "shared topic",
      "dominant.md": "x".repeat(15_000),
    };
    for (let index = 0; index < 24; index++)
      contents[`related-${index.toString().padStart(2, "0")}.md`] = "shared topic";
    const indexed = manager(contents, new MemoryIndexStorage());
    await indexed.build(signal);

    const related = await new RelatedNotes(indexed).find("current.md", signal, 20);

    expect(related.results).toHaveLength(20);
    expect(new Set(related.results.map((result) => result.path)).size).toBe(20);
    expect(related.results.map((result) => result.path)).toContain("dominant.md");
  });

  it("keeps the prior durable snapshot when replacement fails", async () => {
    const contents = { "note.md": "alpha" };
    const storage = new MemoryIndexStorage();
    const indexed = manager(contents, storage);
    await indexed.build(signal);
    const previous = await storage.read("index.json");
    contents["note.md"] = "beta";
    const replace = storage.replace.bind(storage);
    storage.replace = async () => {
      throw new Error("synthetic replacement failure");
    };
    indexed.queueChange("note.md");
    await expect(indexed.reconcileQueuedChanges(signal)).rejects.toThrow(
      "synthetic replacement failure"
    );
    expect(await storage.read("index.json")).toBe(previous);
    storage.replace = replace;
    await expect(indexed.reconcileQueuedChanges(signal)).resolves.toBeUndefined();
    expect(await storage.read("index.json")).not.toBe(previous);
  });
});
