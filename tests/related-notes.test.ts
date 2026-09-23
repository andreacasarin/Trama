import { describe, expect, it, vi } from "vitest";
import { RelatedNotes } from "@/index/RelatedNotes";
import type { RelatedIndexHit, RelatedIndexState } from "@/index/IndexManager";
import type { TramaDiagnosticRecord } from "@/diagnostics/TramaDiagnostics";

const signal = new AbortController().signal;
function snapshot(path: string, _text: string, hits: RelatedIndexHit[], generationId = "1") {
  const search = vi.fn(async () => hits);
  const value: RelatedIndexState = {
    generationId,
    currentPath: path,
    contentHash: `${generationId}:${path}`,
  };
  return { value, search };
}

describe("RelatedNotes", () => {
  it("does not retrieve absent or zero-limit notes", async () => {
    const absent = { relatedState: vi.fn(() => null), findRelated: vi.fn(async () => []) };
    await expect(new RelatedNotes(absent).find("missing.md", signal)).resolves.toMatchObject({
      results: [],
    });
    const zeroLimit = snapshot("zero.md", "query", []);
    await expect(
      new RelatedNotes({ relatedState: () => zeroLimit.value, findRelated: zeroLimit.search }).find(
        "zero.md",
        signal,
        0
      )
    ).resolves.toMatchObject({ results: [] });
    expect(zeroLimit.search).not.toHaveBeenCalled();
  });

  it("does not retrieve until compatible vector coverage is complete", async () => {
    const current = snapshot("current.md", "query", [{ path: "a.md", score: 1 }]);
    const source = {
      relatedState: () => ({
        ...current.value,
        semantic: { state: "partial" as const, activity: "idle" as const, searchable: false },
        freshness: "snapshot-loaded" as const,
        publicationId: "pub-1",
      }),
      findRelated: current.search,
    };

    await expect(new RelatedNotes(source).find("current.md", signal)).resolves.toMatchObject({
      results: [],
      unavailableReason: "incomplete-vectors",
      freshness: "snapshot-loaded",
      publicationId: "pub-1",
    });
    expect(current.search).not.toHaveBeenCalled();
  });

  it("uses available related-note vectors when semantic coverage is partial", async () => {
    const current = snapshot("current.md", "query", [{ path: "a.md", score: 1 }]);
    const source = {
      relatedState: () => ({
        ...current.value,
        semantic: { state: "partial" as const, activity: "idle" as const, searchable: true },
      }),
      findRelated: current.search,
    };

    await expect(new RelatedNotes(source).find("current.md", signal)).resolves.toMatchObject({
      semanticPartial: true,
      results: [expect.objectContaining({ path: "a.md" })],
    });
    expect(current.search).toHaveBeenCalledOnce();
  });

  it("prepares once, excludes current, aggregates max score, caps, and sorts ties", async () => {
    const hits = [
      { path: "current.md", score: 99 },
      { path: "b.md", score: 0.4 },
      { path: "a.md", score: 0.4 },
      { path: "b.md", score: 0.9 },
      ...Array.from({ length: 8 }, (_, i) => ({ path: `extra-${i}.md`, score: 0.2 })),
    ];
    const current = snapshot("current.md", "query", hits);
    const result = await new RelatedNotes({
      relatedState: () => current.value,
      findRelated: current.search,
    }).find("current.md", signal, 7);
    expect(current.search).toHaveBeenCalledWith("current.md", expect.any(AbortSignal), 128);
    expect(result.results).toEqual([
      { path: "b.md", score: 0.9 },
      { path: "a.md", score: 0.4 },
      { path: "extra-0.md", score: 0.2 },
      { path: "extra-1.md", score: 0.2 },
      { path: "extra-2.md", score: 0.2 },
      { path: "extra-3.md", score: 0.2 },
      { path: "extra-4.md", score: 0.2 },
    ]);
  });

  it("keeps the winning chunk preview and strongest semantic similarity per note", async () => {
    const current = snapshot("current.md", "query", [
      {
        path: "related.md",
        score: 0.03,
        similarity: 0.7,
        excerpt: "winning excerpt",
        startLine: 4,
        endLine: 6,
      },
      {
        path: "related.md",
        score: 0.02,
        similarity: 0.85,
        excerpt: "lower-ranked excerpt",
        startLine: 20,
        endLine: 21,
      },
    ]);

    const result = await new RelatedNotes({
      relatedState: () => current.value,
      findRelated: current.search,
    }).find("current.md", signal);

    expect(result.results).toEqual([
      {
        path: "related.md",
        score: 0.03,
        similarity: 0.85,
        excerpt: "winning excerpt",
        startLine: 4,
        endLine: 6,
      },
    ]);
  });

  it("shares same-key work and caches successful results", async () => {
    const current = snapshot("current.md", "query", [{ path: "a.md", score: 1 }]);
    const source = { relatedState: vi.fn(() => current.value), findRelated: current.search };
    const service = new RelatedNotes(source);
    const [first, second] = await Promise.all([
      service.find("current.md", signal),
      service.find("current.md", signal),
    ]);
    expect(first.results).toEqual(second.results);
    expect(current.search).toHaveBeenCalledOnce();
    await service.find("current.md", signal);
    expect(current.search).toHaveBeenCalledOnce();
  });

  it("retains exact rows while cache batches churn without changing the visible head", async () => {
    const current = snapshot("current.md", "query", [{ path: "settled.md", score: 0.9 }]);
    let activity: "idle" | "updating" = "idle";
    const source = {
      relatedState: vi.fn(() => ({
        ...current.value,
        semantic: { state: "ready" as const, activity, searchable: true },
      })),
      findRelated: current.search,
    };
    const service = new RelatedNotes(source);
    const first = await service.find("current.md", signal);
    activity = "updating";
    const duringBatch = await service.find("current.md", signal);
    expect(duringBatch.results).toEqual(first.results);
    expect(current.search).toHaveBeenCalledOnce();
  });

  it("swaps cached rows once when the visible semantic head changes", async () => {
    const first = snapshot("current.md", "query", [{ path: "old.md", score: 0.8 }], "head-1");
    const second = snapshot("current.md", "query", [{ path: "new.md", score: 0.9 }], "head-2");
    let current = first.value;
    const service = new RelatedNotes({
      relatedState: () => current,
      findRelated: (path) =>
        path === "current.md" && current === first.value ? first.search() : second.search(),
    });
    const settled = await service.find("current.md", signal);
    current = second.value;
    const refreshed = await service.find("current.md", signal);
    expect(settled.results).toEqual([{ path: "old.md", score: 0.8 }]);
    expect(refreshed.results).toEqual([{ path: "new.md", score: 0.9 }]);
    expect(first.search).toHaveBeenCalledOnce();
    expect(second.search).toHaveBeenCalledOnce();
  });

  it("reports preparation and retrieval timings for the single shared computation", async () => {
    const current = snapshot("current.md", "query", [{ path: "a.md", score: 1 }]);
    const records: TramaDiagnosticRecord[] = [];
    const service = new RelatedNotes(
      { relatedState: () => current.value, findRelated: current.search },
      { emit: (record) => records.push(record) }
    );

    await Promise.all([service.find("current.md", signal), service.find("current.md", signal)]);

    expect(
      records
        .filter((record) => record.area === "filo" && record.event === "related_search")
        .map((record) => record.stage)
    ).toEqual(["started", "retrieve-completed", "completed"]);
    expect(records.every((record) => !("path" in record))).toBe(true);
    expect(JSON.stringify(records)).not.toContain("current.md");
    expect(JSON.stringify(records)).not.toContain("a.md");
  });

  it("caches twenty candidates while preserving the default seven-result consumer cap", async () => {
    const hits = Array.from({ length: 25 }, (_, index) => ({
      path: `note-${index.toString().padStart(2, "0")}.md`,
      score: 1 - index / 100,
      similarity: 0.8 - index / 100,
    }));
    const current = snapshot("current.md", "query", hits);
    const service = new RelatedNotes({
      relatedState: () => current.value,
      findRelated: current.search,
    });

    const defaultResult = await service.find("current.md", signal);
    const extendedResult = await service.find("current.md", signal, 20);

    expect(defaultResult.results).toHaveLength(7);
    expect(extendedResult.results).toHaveLength(20);
    expect(current.search).toHaveBeenCalledOnce();
  });

  it("publishes the same ordered result to subscribers and exposes the latest path", async () => {
    const current = snapshot("current.md", "query", [
      { path: "b.md", score: 0.8 },
      { path: "a.md", score: 0.8 },
    ]);
    const service = new RelatedNotes({
      relatedState: () => current.value,
      findRelated: current.search,
    });
    const updates: string[][] = [];
    const unsubscribe = service.subscribe((result) =>
      updates.push(result.results.map((item) => item.path))
    );
    await service.find("current.md", signal);
    expect(updates).toEqual([["a.md", "b.md"]]);
    expect(service.latest("current.md")).toEqual(["a.md", "b.md"]);
    expect(service.latest("other.md")).toEqual([]);
    unsubscribe();
  });

  it("uses locale-independent code-unit ordering for equal-score paths", async () => {
    const current = snapshot("current.md", "query", [
      { path: "ä.md", score: 0.8 },
      { path: "a.md", score: 0.8 },
      { path: "Z.md", score: 0.8 },
    ]);

    const result = await new RelatedNotes({
      relatedState: () => current.value,
      findRelated: current.search,
    }).find("current.md", signal);

    expect(result.results.map((item) => item.path)).toEqual(["Z.md", "a.md", "ä.md"]);
  });

  it("does not expose a latest result after the live snapshot identity changes", async () => {
    const first = snapshot("current.md", "query", [{ path: "old.md", score: 1 }], "1");
    const second = snapshot("current.md", "query", [{ path: "new.md", score: 1 }], "2");
    let current = first.value;
    const service = new RelatedNotes({
      relatedState: () => current,
      findRelated: () => (current === first.value ? first.search() : second.search()),
    });
    await service.find("current.md", signal);
    expect(service.latest("current.md")).toEqual(["old.md"]);

    current = second.value;

    expect(service.latest("current.md")).toEqual([]);
    await service.find("current.md", signal);
    expect(service.latest("current.md")).toEqual(["new.md"]);
  });

  it("allows a late result but suppresses its cache after the live snapshot changes", async () => {
    let release!: () => void;
    const old = snapshot("old.md", "old", [{ path: "stale.md", score: 1 }]);
    old.search.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve([{ path: "stale.md", score: 1 }])))
    );
    const next = snapshot("new.md", "new", [{ path: "fresh.md", score: 1 }], "2");
    let current = old.value;
    const service = new RelatedNotes({
      relatedState: () => current,
      findRelated: (path) => (path === "old.md" ? old.search() : next.search()),
    });
    const stale = service.find("old.md", signal);
    current = next.value;
    const fresh = await service.find("new.md", signal);
    release();
    await expect(stale).resolves.toMatchObject({ results: [{ path: "stale.md" }] });
    expect(fresh.results[0].path).toBe("fresh.md");
    expect(service.latest("new.md")).toEqual(["fresh.md"]);
  });

  it("honors caller cancellation", async () => {
    const current = snapshot("current.md", "query", []);
    const controller = new AbortController();
    controller.abort();
    await expect(
      new RelatedNotes({ relatedState: () => current.value, findRelated: current.search }).find(
        "current.md",
        controller.signal
      )
    ).rejects.toThrow("cancelled");
    expect(current.search).not.toHaveBeenCalled();
  });

  it("does not return aborted shared work to a later same-key consumer", async () => {
    let release!: () => void;
    const current = snapshot("current.md", "query", [{ path: "a.md", score: 1 }]);
    current.search.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve([{ path: "a.md", score: 1 }])))
    );
    const service = new RelatedNotes({
      relatedState: () => current.value,
      findRelated: current.search,
    });
    const cancelled = new AbortController();
    const first = service.find("current.md", cancelled.signal);
    cancelled.abort();
    await expect(first).rejects.toThrow("cancelled");
    release();
    const second = await service.find("current.md", signal);
    expect(second.results).toEqual([{ path: "a.md", score: 1 }]);
    expect(current.search).toHaveBeenCalledOnce();
  });

  it("shares work while one consumer cancels", async () => {
    let release!: () => void;
    const current = snapshot("current.md", "query", [{ path: "a.md", score: 1 }]);
    current.search.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve([{ path: "a.md", score: 1 }])))
    );
    const service = new RelatedNotes({
      relatedState: () => current.value,
      findRelated: current.search,
    });
    const cancelled = new AbortController();
    const first = service.find("current.md", cancelled.signal);
    const second = service.find("current.md", signal);
    await vi.waitFor(() => expect(current.search).toHaveBeenCalledOnce());
    cancelled.abort();
    release();
    await expect(first).rejects.toThrow("cancelled");
    await expect(second).resolves.toMatchObject({ results: [{ path: "a.md" }] });
    expect(current.search).toHaveBeenCalledOnce();
  });
});
