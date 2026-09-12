import { describe, expect, it, vi } from "vitest";
import { LenteSearch, selectLenteResults, type LenteHit } from "@/index/LenteSearch";
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

  it("uses keyword retrieval without marking the result degraded", async () => {
    const search = vi.fn(async () => [hit("note.md", 1)]);
    const service = new LenteSearch(
      { acquireLenteLease: () => ({ generationId: "g1", search, release: async () => undefined }) },
      { getMtime: () => 1 }
    );
    await expect(service.search("needle", { searchMethod: "keyword" })).resolves.toMatchObject({
      mode: "lexical",
      degraded: false,
      displayLimit: 20,
    });
    expect(search).toHaveBeenCalledWith("needle", "lexical", undefined);
  });

  it("applies a configured display limit without shrinking the candidate pool", async () => {
    const candidates = Array.from({ length: 30 }, (_, index) =>
      hit(`note-${index}.md`, 1 - index / 100)
    );
    const search = vi.fn(async () => candidates);
    const service = new LenteSearch(
      { acquireLenteLease: () => ({ generationId: "g1", search, release: async () => undefined }) },
      { getMtime: () => 1 }
    );
    const result = await service.search("needle", { maxResults: 5 });
    expect(result.displayLimit).toBe(5);
    expect(result.results).toHaveLength(5);
    expect(result.canonicalResults).toHaveLength(30);
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
