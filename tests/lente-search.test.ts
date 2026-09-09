import { describe, expect, it, vi } from "vitest";
import { LenteSearch, selectLenteResults, type LenteHit } from "@/index/LenteSearch";
import { OramaLexicalIndex } from "@/index/lexical/OramaLexicalIndex";
import type { CorpusSnapshot } from "@/index/corpus/CorpusStore";
import { QueryEmbeddingError } from "@/index/retrieval/QueryEmbeddingError";

const hit = (path: string, fusedScore: number, ordinal = 0): LenteHit => ({
  path,
  startLine: 1,
  endLine: 2,
  excerpt: path,
  generationId: "g1",
  chunkId: `${path}:${ordinal}`,
  ordinal,
  fusedScore,
});

describe("LenteSearch", () => {
  it("weights filename, path, and body 3/2/1 in the derived lexical profile", async () => {
    const notes = [
      { path: "needle.md", contentId: "a", chunkCount: 1, segments: [] },
      { path: "folder/needle/path.md", contentId: "b", chunkCount: 1, segments: [] },
      { path: "body.md", contentId: "c", chunkCount: 1, segments: [] },
    ];
    const source = {
      generationId: "g1",
      fingerprint: "f1",
      notes,
      root: {} as never,
      pin() {
        return this;
      },
      release: vi.fn(async () => undefined),
      getNote(path: string) {
        return notes.find((note) => note.path === path);
      },
      async hydrateNote(path: string) {
        return [
          {
            id: path,
            checksum: path,
            chunkCount: 1,
            segment: {
              records: [
                {
                  ordinal: 0,
                  startLine: 1,
                  endLine: 1,
                  text: path === "body.md" ? `needle ${"quiet ".repeat(1_000)}` : "quiet",
                  vector: [1],
                },
              ],
            },
          },
        ] as never;
      },
      readSegment: vi.fn(),
      hydrateChunk: vi.fn(),
    } as unknown as CorpusSnapshot;
    const index = await OramaLexicalIndex.build(source, { profile: "lente" });
    const results = await index.search("needle", {
      profile: "lente",
      limit: 3,
      candidateLimit: 10,
    });
    expect(results).toHaveLength(3);
    expect(results[0].path).toBe("needle.md");
    expect(new Set(results.map((result) => result.path)).size).toBe(3);
    expect((index as unknown as { db: { schema: unknown } }).db.schema).toEqual({
      id: "string",
      text: "string",
      path: "string",
      ordinal: "number",
      filename: "string",
      pathText: "string",
      body: "string",
    });
    await index.close();
  });

  it("checks cancellation before progressive Lente overfetch", async () => {
    const records = Array.from({ length: 100 }, (_, ordinal) => ({ ordinal, text: "needle" }));
    const source = {
      generationId: "g1",
      fingerprint: "f1",
      notes: [{ path: "a.md", contentId: "a", chunkCount: records.length, segments: [] }],
      root: {} as never,
      pin() {
        return this;
      },
      release: vi.fn(async () => undefined),
      async hydrateNote() {
        return [{ id: "a", checksum: "a", chunkCount: records.length, segment: { records } }];
      },
    } as unknown as CorpusSnapshot;
    const index = await OramaLexicalIndex.build(source, { profile: "lente" });
    let reads = 0;
    const signal = {
      get aborted() {
        return ++reads >= 3;
      },
    } as AbortSignal;
    await expect(
      index.search("needle", { profile: "lente", limit: 1, candidateLimit: 50, signal })
    ).rejects.toThrow("cancelled");
    await index.close();
  });

  it("collapses notes, drops missing live files, and sorts by live mtime", () => {
    const results = selectLenteResults(
      [hit("old.md", 0.9), hit("new.md", 0.4), hit("old.md", 0.8)],
      "g1",
      (path) => (path === "old.md" ? 10 : path === "new.md" ? 20 : null),
      "updated"
    );
    expect(results.map((result) => result.path)).toEqual(["new.md", "old.md"]);
    expect(results.find((result) => result.path === "old.md")?.fusedScore).toBe(0.9);
  });

  it("keeps the 160-candidate pool before the 20-row display cap", () => {
    const raw = Array.from({ length: 180 }, (_, index) => hit(`note-${index}.md`, 1 - index / 100));
    const mtime = (path: string) =>
      path === "note-170.md" ? 10_000 : path === "note-1.md" ? null : 100;
    const pool = selectLenteResults(raw, "g1", mtime, "relevant", 160);
    expect(pool).toHaveLength(160);
    expect(selectLenteResults(raw, "g1", mtime, "updated", 20)[0].path).toBe("note-170.md");
  });

  it("restores canonical relevant order after a round-trip sort with equal mtimes", () => {
    const raw = [hit("Z.md", 1), hit("a.md", 1), hit("ä.md", 1)];
    const getMtime = () => 10;
    const relevant = selectLenteResults(raw, "g1", getMtime, "relevant", 160);
    const updated = selectLenteResults(raw, "g1", getMtime, "updated", 160);
    expect(updated.map((item) => item.path)).toEqual(["Z.md", "a.md", "ä.md"]);
    expect(
      selectLenteResults(updated, "g1", getMtime, "relevant", 160).map((item) => item.path)
    ).toEqual(relevant.map((item) => item.path));
  });

  it("falls back to lexical retrieval only for an unavailable embedding", async () => {
    const release = vi.fn(async () => undefined);
    const search = vi
      .fn()
      .mockRejectedValueOnce(new QueryEmbeddingError())
      .mockResolvedValueOnce([hit("note.md", 1)]);
    const service = new LenteSearch(
      { acquireLenteLease: () => ({ generationId: "g1", search, release }) },
      { getMtime: () => 1 }
    );
    await expect(service.search("needle")).resolves.toMatchObject({
      mode: "lexical",
      degraded: true,
    });
    expect(search).toHaveBeenNthCalledWith(2, "needle", "lexical", undefined);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("uses the retriever lease shape with a 160-candidate request", async () => {
    const candidates = Array.from({ length: 30 }, (_, index) =>
      hit(`note-${index}.md`, 1 - index / 100)
    );
    const retrieve = vi.fn(async () => candidates);
    const service = new LenteSearch(
      {
        acquireLenteLease: () => ({
          generationId: "g1",
          retriever: { search: retrieve },
          release: async () => undefined,
        }),
      },
      { getMtime: (path) => (path === "note-25.md" ? 10_000 : 1) }
    );
    const result = await service.search("needle", { sort: "updated" });
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 160, feature: "lente" })
    );
    expect(result.canonicalResults).toHaveLength(30);
    expect(result.results[0].path).toBe("note-25.md");
  });

  it("falls back for an empty query embedding but not lexical, hydration, corruption, or AbortError failures", async () => {
    const cases = [
      { error: new QueryEmbeddingError(), fallback: true },
      { error: new Error("embedding lexical index failed"), fallback: false },
      { error: new Error("embedding hydration failed"), fallback: false },
      { error: new Error("embedding corpus corruption"), fallback: false },
      { error: new DOMException("aborted", "AbortError"), fallback: false },
    ];
    for (const { error, fallback } of cases) {
      const search = vi.fn();
      if (fallback)
        search.mockRejectedValueOnce(error).mockResolvedValueOnce([hit("fallback.md", 1)]);
      else search.mockRejectedValue(error);
      const service = new LenteSearch(
        {
          acquireLenteLease: () => ({ generationId: "g1", search, release: async () => undefined }),
        },
        { getMtime: () => 1 }
      );
      if (fallback)
        await expect(service.search("needle")).resolves.toMatchObject({ mode: "lexical" });
      else await expect(service.search("needle")).rejects.toBe(error);
      expect(search).toHaveBeenCalledTimes(fallback ? 2 : 1);
    }
  });
});
