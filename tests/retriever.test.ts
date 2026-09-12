import { describe, expect, it, vi } from "vitest";
import { IndexManager } from "@/index/IndexManager";
import { MemoryIndexStorage } from "@/index/storage";
import { QueryEmbeddingError } from "@/index/retrieval/QueryEmbeddingError";

const signal = new AbortController().signal;

function model() {
  return {
    dimensions: 768,
    embed: vi.fn(async (texts: readonly string[]) =>
      texts.map((text) => {
        const vector = Array.from({ length: 768 }, () => 0);
        vector[text.includes("beta") ? 1 : 0] = 1;
        return vector;
      })
    ),
  };
}

function manager(contents: Record<string, string>, embedding = model()) {
  return {
    manager: new IndexManager(
      {
        listMarkdownPaths: async () => Object.keys(contents),
        readMarkdown: async (path: string) => ({ path, content: contents[path] }),
      },
      embedding,
      new MemoryIndexStorage(),
      "http://synthetic.invalid/v1",
      "synthetic"
    ),
    embedding,
  };
}

describe("live Orama retriever", () => {
  it("runs independent vector/BM25 channels and deterministic RRF", async () => {
    const setup = manager({ "a.md": "alpha body", "b.md": "beta body" });
    await setup.manager.build(signal);
    const lease = setup.manager.acquireLenteLease();
    expect(lease).not.toBeNull();
    const results = await lease!.retriever.search({
      query: "alpha",
      mode: "hybrid",
      resultShape: "notes",
      feature: "lente",
      limit: 2,
      semanticCandidateLimit: 10,
      lexicalCandidateLimit: 10,
      lexicalProfile: "lente",
      signal,
    });
    expect(results[0]).toMatchObject({ path: "a.md" });
    expect(results[0]?.semanticScore).toEqual(expect.any(Number));
    expect(results[0]?.lexicalScore).toEqual(expect.any(Number));
    await lease!.release();
  });

  it("keeps a lease on the stable projection across mutation", async () => {
    const contents: Record<string, string> = { "a.md": "alpha" };
    const setup = manager(contents);
    await setup.manager.build(signal);
    const lease = setup.manager.acquireLenteLease()!;
    contents["a.md"] = "beta";
    setup.manager.queueChange("a.md");
    await setup.manager.reconcileQueuedChanges(signal);
    const result = await lease.retriever.search({
      query: "beta",
      mode: "lexical",
      resultShape: "notes",
      feature: "lente",
      limit: 1,
      lexicalCandidateLimit: 10,
      semanticCandidateLimit: 0,
      lexicalProfile: "lente",
      signal,
    });
    expect(result).toMatchObject([{ path: "a.md" }]);
    await lease.release();
  });

  it("preserves query-embedding failure as an explicit error for Lente fallback", async () => {
    const embedding = model();
    const setup = manager({ "a.md": "alpha" }, embedding);
    await setup.manager.build(signal);
    embedding.embed = vi.fn(async () => {
      throw new Error("synthetic query failure");
    });
    const lease = setup.manager.acquireLenteLease()!;
    await expect(
      lease.retriever.search({
        query: "alpha",
        mode: "hybrid",
        resultShape: "notes",
        feature: "lente",
        limit: 1,
        semanticCandidateLimit: 10,
        lexicalCandidateLimit: 10,
        lexicalProfile: "lente",
        signal,
      })
    ).rejects.toBeInstanceOf(QueryEmbeddingError);
    await lease.release();
  });
});
