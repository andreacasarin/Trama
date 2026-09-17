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

const readyState = {
  generationId: "g1",
  changeCounter: 1,
  semantic: { state: "ready" as const, activity: "idle" as const, searchable: true },
};

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
    const search = vi
      .fn()
      .mockRejectedValueOnce(new QueryEmbeddingError())
      .mockResolvedValueOnce([hit("note.md", 1)]);
    const service = new LenteSearch(
      { vaultSearchState: () => readyState, retrieveVaultCandidates: search },
      { getMtime: () => 1 }
    );
    await expect(service.search("needle")).resolves.toMatchObject({
      mode: "lexical",
      degraded: true,
    });
    expect(search).toHaveBeenNthCalledWith(2, "needle", "lexical", undefined);
  });

  it("uses keyword retrieval without marking the result degraded", async () => {
    const search = vi.fn(async () => [hit("note.md", 1)]);
    const service = new LenteSearch(
      {
        vaultSearchState: () => readyState,
        retrieveVaultCandidates: search,
      },
      { getMtime: () => 1 }
    );
    await expect(service.search("needle", { searchMethod: "keyword" })).resolves.toMatchObject({
      mode: "lexical",
      degraded: false,
      displayLimit: 20,
    });
    expect(search).toHaveBeenCalledWith("needle", "lexical", undefined);
  });

  it("gates hybrid retrieval on semantic readiness and carries snapshot freshness", async () => {
    const search = vi.fn(async () => [hit("snapshot.md", 1)]);
    const service = new LenteSearch(
      {
        vaultSearchState: () => ({
          changeCounter: 4,
          generationId: "g4",
          semantic: { state: "empty", activity: "idle", searchable: false },
          freshness: "snapshot-loaded",
          publicationId: "pub-4",
        }),
        retrieveVaultCandidates: search,
      },
      { getMtime: () => 1 }
    );

    await expect(service.search("needle")).resolves.toMatchObject({
      mode: "lexical",
      degraded: true,
      degradationReason: "semantic-unavailable",
      freshness: "snapshot-loaded",
      publicationId: "pub-4",
    });
    expect(search).toHaveBeenCalledWith("needle", "lexical", undefined);
  });

  it.each([
    ["no vectors", "empty"],
    ["partial vectors", "partial"],
    ["incompatible vectors", "incompatible"],
  ] as const)("reports lexical degradation for %s coverage", async (_label, channelState) => {
    const search = vi.fn(async () => [hit("lexical.md", 1)]);
    const service = new LenteSearch(
      {
        vaultSearchState: () => ({
          ...readyState,
          semantic: { state: channelState, activity: "idle", searchable: false },
        }),
        retrieveVaultCandidates: search,
      },
      { getMtime: () => 1 }
    );

    await expect(service.search("needle")).resolves.toMatchObject({
      mode: "lexical",
      degraded: true,
      degradationReason: "semantic-unavailable",
    });
    expect(search).toHaveBeenCalledWith("needle", "lexical", undefined);
  });

  it("uses available semantic vectors and labels partial coverage", async () => {
    const search = vi.fn(async () => [hit("indexed.md", 1)]);
    const service = new LenteSearch(
      {
        vaultSearchState: () => ({
          ...readyState,
          semantic: { state: "partial", activity: "idle", searchable: true },
        }),
        retrieveVaultCandidates: search,
      },
      { getMtime: () => 1 }
    );

    await expect(service.search("needle")).resolves.toMatchObject({
      mode: "hybrid",
      semanticPartial: true,
      results: [expect.objectContaining({ path: "indexed.md" })],
    });
    expect(search).toHaveBeenCalledWith("needle", "hybrid", undefined);
  });

  it("applies a configured display limit without shrinking the candidate pool", async () => {
    const candidates = Array.from({ length: 30 }, (_, index) =>
      hit(`note-${index}.md`, 1 - index / 100)
    );
    const search = vi.fn(async () => candidates);
    const service = new LenteSearch(
      {
        vaultSearchState: () => readyState,
        retrieveVaultCandidates: search,
      },
      { getMtime: () => 1 }
    );
    const result = await service.search("needle", { maxResults: 5 });
    expect(result.displayLimit).toBe(5);
    expect(result.results).toHaveLength(5);
    expect(result.canonicalResults).toHaveLength(30);
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
          vaultSearchState: () => readyState,
          retrieveVaultCandidates: search,
        },
        { getMtime: () => 1 }
      );
      if (fallback)
        await expect(service.search("needle")).resolves.toMatchObject({
          mode: "lexical",
          degraded: true,
          degradationReason: "query-embedding-failed",
        });
      else await expect(service.search("needle")).rejects.toBe(error);
      expect(search).toHaveBeenCalledTimes(fallback ? 2 : 1);
    }
  });
});
