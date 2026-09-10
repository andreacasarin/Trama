import { describe, expect, it, vi } from "vitest";
import { RelatedNotes } from "@/index/RelatedNotes";
import type { RelatedIndexHit, RelatedIndexSnapshot } from "@/index/IndexManager";
import type { TramaDiagnosticRecord } from "@/diagnostics/TramaDiagnostics";

const signal = new AbortController().signal;
function snapshot(path: string, text: string, hits: RelatedIndexHit[], generationId = "1") {
  const prepareQuery = vi.fn(async () => (text ? { text, vector: [1, 0] } : null));
  const search = vi.fn(async () => hits);
  const value: RelatedIndexSnapshot = {
    generationId,
    currentPath: path,
    contentHash: `${generationId}:${path}`,
    prepareQuery,
    search,
  };
  return { value, prepareQuery, search };
}

describe("RelatedNotes", () => {
  it("does not prepare absent or zero-limit notes and handles an empty prepared query", async () => {
    const absent = { relatedSnapshot: vi.fn(() => null) };
    await expect(new RelatedNotes(absent).find("missing.md", signal)).resolves.toMatchObject({
      results: [],
    });
    const empty = snapshot("empty.md", "", []);
    await expect(
      new RelatedNotes({ relatedSnapshot: () => empty.value }).find("empty.md", signal)
    ).resolves.toMatchObject({ results: [] });
    expect(empty.prepareQuery).toHaveBeenCalledOnce();
    const zeroLimit = snapshot("zero.md", "query", []);
    await expect(
      new RelatedNotes({ relatedSnapshot: () => zeroLimit.value }).find("zero.md", signal, 0)
    ).resolves.toMatchObject({ results: [] });
    expect(zeroLimit.prepareQuery).not.toHaveBeenCalled();
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
    const result = await new RelatedNotes({ relatedSnapshot: () => current.value }).find(
      "current.md",
      signal,
      7
    );
    expect(current.prepareQuery).toHaveBeenCalledOnce();
    expect(current.search).toHaveBeenCalledWith("query", [1, 0], expect.any(AbortSignal), 128);
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

    const result = await new RelatedNotes({ relatedSnapshot: () => current.value }).find(
      "current.md",
      signal
    );

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
    const source = { relatedSnapshot: vi.fn(() => current.value) };
    const service = new RelatedNotes(source);
    const [first, second] = await Promise.all([
      service.find("current.md", signal),
      service.find("current.md", signal),
    ]);
    expect(first.results).toEqual(second.results);
    expect(current.prepareQuery).toHaveBeenCalledOnce();
    await service.find("current.md", signal);
    expect(current.prepareQuery).toHaveBeenCalledOnce();
  });

  it("reports preparation and retrieval timings for the single shared computation", async () => {
    const current = snapshot("current.md", "query", [{ path: "a.md", score: 1 }]);
    const records: TramaDiagnosticRecord[] = [];
    const service = new RelatedNotes(
      { relatedSnapshot: () => current.value },
      { emit: (record) => records.push(record) }
    );

    await Promise.all([service.find("current.md", signal), service.find("current.md", signal)]);

    expect(
      records
        .filter((record) => record.area === "filo" && record.event === "related_search")
        .map((record) => record.stage)
    ).toEqual(["started", "prepare-completed", "retrieve-completed", "completed"]);
  });

  it("caches twenty candidates while preserving the default seven-result consumer cap", async () => {
    const hits = Array.from({ length: 25 }, (_, index) => ({
      path: `note-${index.toString().padStart(2, "0")}.md`,
      score: 1 - index / 100,
      similarity: 0.8 - index / 100,
    }));
    const current = snapshot("current.md", "query", hits);
    const service = new RelatedNotes({ relatedSnapshot: () => current.value });

    const defaultResult = await service.find("current.md", signal);
    const extendedResult = await service.find("current.md", signal, 20);

    expect(defaultResult.results).toHaveLength(7);
    expect(extendedResult.results).toHaveLength(20);
    expect(current.prepareQuery).toHaveBeenCalledOnce();
    expect(current.search).toHaveBeenCalledOnce();
  });

  it("publishes the same ordered result to subscribers and exposes the latest path", async () => {
    const current = snapshot("current.md", "query", [
      { path: "b.md", score: 0.8 },
      { path: "a.md", score: 0.8 },
    ]);
    const service = new RelatedNotes({ relatedSnapshot: () => current.value });
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

    const result = await new RelatedNotes({ relatedSnapshot: () => current.value }).find(
      "current.md",
      signal
    );

    expect(result.results.map((item) => item.path)).toEqual(["Z.md", "a.md", "ä.md"]);
  });

  it("does not expose a latest result after the live snapshot identity changes", async () => {
    const first = snapshot("current.md", "query", [{ path: "old.md", score: 1 }], "1");
    const second = snapshot("current.md", "query", [{ path: "new.md", score: 1 }], "2");
    let current = first.value;
    const service = new RelatedNotes({ relatedSnapshot: () => current });
    await service.find("current.md", signal);
    expect(service.latest("current.md")).toEqual(["old.md"]);

    current = second.value;

    expect(service.latest("current.md")).toEqual([]);
    await service.find("current.md", signal);
    expect(service.latest("current.md")).toEqual(["new.md"]);
  });

  it("supersedes a prior path/generation and suppresses its late cache", async () => {
    let release!: (value: readonly number[][]) => void;
    const old = snapshot("old.md", "old", [{ path: "stale.md", score: 1 }]);
    old.prepareQuery.mockImplementationOnce(
      () =>
        new Promise((resolve) => (release = (value) => resolve({ text: "old", vector: value[0] })))
    );
    const next = snapshot("new.md", "new", [{ path: "fresh.md", score: 1 }], "2");
    let current = old.value;
    const service = new RelatedNotes({ relatedSnapshot: () => current });
    const stale = service.find("old.md", signal);
    current = next.value;
    const fresh = await service.find("new.md", signal);
    release([[1, 0]]);
    await expect(stale).rejects.toThrow("cancelled");
    expect(fresh.results[0].path).toBe("fresh.md");
  });

  it("honors caller cancellation", async () => {
    const current = snapshot("current.md", "query", []);
    const controller = new AbortController();
    controller.abort();
    await expect(
      new RelatedNotes({ relatedSnapshot: () => current.value }).find(
        "current.md",
        controller.signal
      )
    ).rejects.toThrow("cancelled");
    expect(current.prepareQuery).not.toHaveBeenCalled();
  });

  it("does not return aborted shared work to a later same-key consumer", async () => {
    let release!: (value: readonly number[][]) => void;
    const current = snapshot("current.md", "query", [{ path: "a.md", score: 1 }]);
    current.prepareQuery.mockImplementationOnce(
      () =>
        new Promise(
          (resolve) => (release = (value) => resolve({ text: "query", vector: value[0] }))
        )
    );
    const service = new RelatedNotes({ relatedSnapshot: () => current.value });
    const cancelled = new AbortController();
    const first = service.find("current.md", cancelled.signal);
    cancelled.abort();
    await expect(first).rejects.toThrow("cancelled");
    release([[1, 0]]);
    const second = await service.find("current.md", signal);
    expect(second.results).toEqual([{ path: "a.md", score: 1 }]);
    expect(current.prepareQuery).toHaveBeenCalledOnce();
  });

  it("shares work while one consumer cancels", async () => {
    let release!: (value: readonly number[][]) => void;
    const current = snapshot("current.md", "query", [{ path: "a.md", score: 1 }]);
    current.prepareQuery.mockImplementationOnce(
      () =>
        new Promise(
          (resolve) => (release = (value) => resolve({ text: "query", vector: value[0] }))
        )
    );
    const service = new RelatedNotes({ relatedSnapshot: () => current.value });
    const cancelled = new AbortController();
    const first = service.find("current.md", cancelled.signal);
    const second = service.find("current.md", signal);
    await vi.waitFor(() => expect(current.prepareQuery).toHaveBeenCalledOnce());
    cancelled.abort();
    release([[1, 0]]);
    await expect(first).rejects.toThrow("cancelled");
    await expect(second).resolves.toMatchObject({ results: [{ path: "a.md" }] });
    expect(current.prepareQuery).toHaveBeenCalledOnce();
  });
});
