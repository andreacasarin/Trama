import { describe, expect, it } from "vitest";
// @ts-expect-error The shared corpus fixture is a plain ESM module.
import * as performanceFixture from "../scripts/benchmark/performance-fixture.mjs";
// @ts-expect-error The opt-in runner is a plain ESM module.
import * as performanceRunner from "../scripts/benchmark/performance.mjs";

describe("paired performance benchmark harness", () => {
  it("reproduces the pinned 3000-note, 400-character corpus and deterministic embeddings", () => {
    const corpus = performanceFixture.createPerformanceCorpus();
    expect(corpus.sha256).toBe(performanceFixture.CORPUS_SHA256);
    expect(corpus.notes).toHaveLength(3000);
    expect(corpus.notes.every((note: { content: string }) => note.content.length === 400)).toBe(
      true
    );
    expect(performanceFixture.deterministicVector("same input")).toEqual(
      performanceFixture.deterministicVector("same input")
    );
  });

  it("summarizes samples with median, spread, and p95", () => {
    expect(performanceRunner.summarize([9, 1, 5, 3, 7])).toEqual({
      count: 5,
      median: 5,
      min: 1,
      max: 9,
      p95: 9,
    });
    expect(() => performanceRunner.summarize([])).toThrow("non-empty");
  });

  it("requires equal SQLite module, WASM, and supply-chain hashes", () => {
    const hashes = { module: "m", wasm: "w", supplyChainLock: "s" };
    expect(() => performanceRunner.validateSqliteAssetHashes(hashes, hashes)).not.toThrow();
    expect(() =>
      performanceRunner.validateSqliteAssetHashes(hashes, { ...hashes, wasm: "other" })
    ).toThrow("SQLite WASM hashes differ");
  });

  it("rejects mismatched revisions, corpus hashes, and incomplete result sets", () => {
    const plan = {
      corpusSha256: performanceFixture.CORPUS_SHA256,
      runs: [{ count: 24, warmups: 0, samples: 1 }],
    };
    const sample = {
      coldIndexMs: 1,
      initial: { noteCount: 24, vectorCount: 24, databaseExportBytes: 1024 },
      finalNoteCount: 23,
      operations: {
        unchanged: { elapsedMs: 1 },
        oneEdit: { elapsedMs: 1 },
        oneDelete: { elapsedMs: 1 },
      },
      queries: {
        lexical: { timingsMs: [1] },
        hybrid: { timingsMs: [1] },
        related: { timingsMs: [1] },
      },
    };
    const baseline = {
      revision: "e03133025f3acb68b75514dfbf18448e903cbbf0",
      corpusSha256: performanceFixture.CORPUS_SHA256,
      runs: [{ count: 24, warmups: [], samples: [sample] }],
    };
    const current = {
      revision: "86423c69ef8563dabebd4db252e88a53676853db",
      corpusSha256: performanceFixture.CORPUS_SHA256,
      runs: [{ count: 24, warmups: [], samples: [sample] }],
    };
    expect(() => performanceRunner.validatePair(baseline, current, plan)).not.toThrow();
    expect(() =>
      performanceRunner.validatePair({ ...baseline, revision: "wrong" }, current, plan)
    ).toThrow("revisions");
    expect(() =>
      performanceRunner.validatePair(baseline, { ...current, corpusSha256: "wrong" }, plan)
    ).toThrow("corpus");
    expect(() =>
      performanceRunner.validatePair(
        baseline,
        { ...current, runs: [{ count: 24, warmups: [], samples: [] }] },
        plan
      )
    ).toThrow("incomplete");
  });
});
