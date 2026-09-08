import { describe, expect, it, vi } from "vitest";
import type { CorpusSnapshot } from "@/index/corpus/CorpusStore";
import { Retriever } from "@/index/retrieval/Retriever";

function fixture() {
  const record = { ordinal: 0, startLine: 4, endLine: 5, text: "x".repeat(600), vector: [1, 0] };
  const notes = [{ path: "a.md", contentId: "a".repeat(64), chunkCount: 1, segments: [] }];
  const hydrateChunk = vi.fn(async (_path: string, _ordinal: number) => record);
  const snapshot = {
    generationId: "g1",
    fingerprint: "f1",
    root: {} as never,
    notes,
    pin() {
      return this;
    },
    release: vi.fn(async () => undefined),
    getNote(path: string) {
      return notes.find((note) => note.path === path);
    },
    hydrateChunk,
    readSegment: vi.fn(),
    hydrateNote: vi.fn(),
  } as unknown as CorpusSnapshot;
  const vector = {
    snapshot,
    search: vi.fn(async () => [{ id: "semantic", path: "a.md", ordinal: 0, score: 0.8 }]),
    close: vi.fn(async () => undefined),
  };
  const lexical = {
    generationId: "g1",
    fingerprint: "f1",
    search: vi.fn(async () => [{ id: "lexical", path: "a.md", ordinal: 0, score: 2 }]),
    close: vi.fn(async () => undefined),
  };
  return { snapshot, vector, lexical, hydrateChunk };
}

describe("Retriever", () => {
  it("fuses channels with RRF and hydrates bounded canonical provenance", async () => {
    const f = fixture();
    const retriever = new Retriever({ ...f, embedding: { embed: vi.fn(async () => [[1, 0]]) } });
    const [result] = await retriever.search({ query: "needle", limit: 1 });
    expect(result).toMatchObject({ path: "a.md", startLine: 4, endLine: 5, generationId: "g1" });
    expect(result.excerpt).toHaveLength(500);
    expect(result.fusedScore).toBeCloseTo(2 / 61);
    expect(f.vector.search).toHaveBeenCalledWith([1, 0], expect.objectContaining({ limit: 80 }));
    await retriever.close();
    await retriever.close();
    expect(f.snapshot.release).toHaveBeenCalledTimes(1);
  });

  it("embeds once and semantic mode does not invoke lexical search", async () => {
    const f = fixture();
    const embed = vi.fn(async () => [[1, 0]]);
    const retriever = new Retriever({ ...f, embedding: { embed } });
    await retriever.search({ query: "needle", mode: "semantic" });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(f.lexical.search).not.toHaveBeenCalled();
  });

  it("rejects empty queries and observes cancellation", async () => {
    const f = fixture();
    const retriever = new Retriever({ ...f, embedding: { embed: vi.fn(async () => [[1, 0]]) } });
    await expect(retriever.search({ query: " " })).rejects.toMatchObject({
      code: "invalid_request",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(retriever.search({ query: "x", signal: controller.signal })).rejects.toMatchObject(
      { code: "cancelled" }
    );
  });

  it("assigns RRF ranks after defensive filtering and applies Filo defaults", async () => {
    const f = fixture();
    f.vector.search.mockResolvedValue([
      { id: "excluded", path: "current.md", ordinal: 0, score: 1 },
      { id: "kept", path: "a.md", ordinal: 0, score: 0.1 },
    ]);
    f.lexical.search.mockResolvedValue([
      { id: "excluded", path: "current.md", ordinal: 0, score: 9 },
      { id: "kept", path: "a.md", ordinal: 0, score: 1 },
    ]);
    const retriever = new Retriever({ ...f, embedding: { embed: vi.fn(async () => [[1, 0]]) } });
    const [result] = await retriever.search({
      query: "needle",
      mode: "related",
      currentPath: "current.md",
    });
    expect(result.fusedScore).toBeCloseTo(2 / 61);
    expect(f.vector.search).toHaveBeenCalledWith(
      [1, 0],
      expect.objectContaining({ limit: 128, excludePath: "current.md" })
    );
    expect(f.lexical.search).toHaveBeenCalledWith(
      "needle",
      expect.objectContaining({ candidateLimit: 128, excludePath: "current.md" })
    );
  });

  it("allows related chunk overfetch while keeping related note output capped", async () => {
    const f = fixture();
    const retriever = new Retriever({ ...f, embedding: { embed: vi.fn(async () => [[1, 0]]) } });
    await expect(
      retriever.search({ query: "needle", mode: "related", resultShape: "chunks", limit: 128 })
    ).resolves.toHaveLength(1);
    await expect(
      retriever.search({ query: "needle", mode: "related", resultShape: "notes", limit: 8 })
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("keeps multiple RAG chunks but collapses note results to the max fused chunk", async () => {
    const f = fixture();
    const notes = [
      { path: "a.md", contentId: "a".repeat(64), chunkCount: 2, segments: [] },
      { path: "b.md", contentId: "b".repeat(64), chunkCount: 1, segments: [] },
    ];
    Object.assign(f.snapshot, { notes });
    f.snapshot.getNote = (path: string) => notes.find((note) => note.path === path);
    f.hydrateChunk.mockImplementation(
      async (_path: string, ordinal: number) =>
        ({
          ordinal,
          startLine: ordinal + 1,
          endLine: ordinal + 1,
          text: "chunk",
          vector: [1, 0],
        }) as never
    );
    f.vector.search.mockResolvedValue([
      { id: "a0", path: "a.md", ordinal: 0, score: 1 },
      { id: "a1", path: "a.md", ordinal: 1, score: 0.9 },
      { id: "b0", path: "b.md", ordinal: 0, score: 0.8 },
    ]);
    f.lexical.search.mockResolvedValue([]);
    const retriever = new Retriever({ ...f, embedding: { embed: vi.fn(async () => [[1, 0]]) } });
    expect((await retriever.search({ query: "x", limit: 3 })).map((r) => r.path)).toEqual([
      "a.md",
      "a.md",
      "b.md",
    ]);
    expect(
      (await retriever.search({ query: "x", mode: "related", limit: 7 })).map((r) => r.path)
    ).toEqual(["a.md", "b.md"]);
  });

  it("uses locale-independent code-unit ordering for equal retrieval hits", async () => {
    const f = fixture();
    f.vector.search.mockResolvedValue([
      { id: "umlaut", path: "ä.md", ordinal: 0, score: 1 },
      { id: "lower", path: "a.md", ordinal: 0, score: 1 },
      { id: "upper", path: "Z.md", ordinal: 0, score: 1 },
    ]);
    f.lexical.search.mockResolvedValue([]);
    const retriever = new Retriever({ ...f, embedding: { embed: vi.fn(async () => [[1, 0]]) } });

    expect((await retriever.search({ query: "x", limit: 3 })).map((result) => result.path)).toEqual(
      ["Z.md", "a.md", "ä.md"]
    );
  });

  it("rejects invalid limits and mixed generation bundles", async () => {
    const f = fixture();
    const retriever = new Retriever({ ...f, embedding: { embed: vi.fn(async () => [[1, 0]]) } });
    for (const limit of [-1, 21, 1.5])
      await expect(retriever.search({ query: "x", limit })).rejects.toMatchObject({
        code: "invalid_request",
      });
    expect(() => new Retriever({ ...f, lexical: { ...f.lexical, generationId: "g2" } })).toThrow(
      "different generations"
    );
  });

  it("preserves backend and hydration failures and supports semantic zero candidates", async () => {
    const f = fixture();
    f.vector.search.mockRejectedValue(new Error("vector unavailable"));
    const retriever = new Retriever({ ...f, embedding: { embed: vi.fn(async () => [[1, 0]]) } });
    await expect(retriever.search({ query: "x" })).rejects.toThrow("vector unavailable");
    f.vector.search.mockResolvedValue([]);
    f.lexical.search.mockResolvedValue([]);
    await expect(
      retriever.search({ query: "x", semanticCandidateLimit: 0, lexicalCandidateLimit: 0 })
    ).resolves.toEqual([]);
    f.lexical.search.mockResolvedValue([{ id: "lexical", path: "a.md", ordinal: 0, score: 1 }]);
    f.hydrateChunk.mockRejectedValue(new Error("hydrate failed"));
    await expect(retriever.search({ query: "x", semanticCandidateLimit: 0 })).rejects.toThrow(
      "hydrate failed"
    );
    await retriever.close();
  });
});
