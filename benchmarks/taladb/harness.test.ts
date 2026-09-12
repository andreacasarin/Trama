import { describe, expect, it } from "vitest";
import { generatedArtifactPath, WORKLOAD_PROFILES } from "./config";
import { exactCosine, exactTopK, compareRankings } from "./oracle";
import { assertBenchmarkReport, isBenchmarkReport } from "./report";
import {
  generateWorkload,
  isNormalized,
  materializedVectorCount,
  MUTATION_SEQUENCE,
  QUERY_IDS,
} from "./workload";

describe("TalaDB synthetic harness", () => {
  it("keeps committed profile and artifact contracts stable", () => {
    expect(WORKLOAD_PROFILES.representative).toMatchObject({
      noteCount: 2_740,
      targetChunkCount: 25_000,
    });
    expect(generatedArtifactPath("smoke", "report.json")).toBe(
      "benchmarks/taladb/.generated/smoke/report.json"
    );
    expect(() => generatedArtifactPath("..", "report.json")).toThrow();
  });

  it("generates exact chunks, code-unit order, and normalized Float32 vectors", () => {
    const workload = generateWorkload(
      { name: "test", noteCount: 7, targetChunkCount: 19 },
      {
        dimensions: 8,
        vectorMaterializationLimit: 19,
      }
    );
    expect(workload.chunks).toHaveLength(19);
    expect(materializedVectorCount(workload)).toBe(19);
    expect(
      workload.chunks.every(
        (chunk) => chunk.vector instanceof Float32Array && isNormalized(chunk.vector)
      )
    ).toBe(true);
    expect(workload.notes.map((note) => note.path)).toEqual(
      [...workload.notes.map((note) => note.path)].sort()
    );
  });

  it("checks the named one-k count without allocating vectors", () => {
    const workload = generateWorkload("oneK", { dimensions: 2, vectorMaterializationLimit: 0 });
    expect(workload.notes).toHaveLength(128);
    expect(workload.chunks).toHaveLength(WORKLOAD_PROFILES.oneK.targetChunkCount);
    expect(materializedVectorCount(workload)).toBe(0);
  });

  it("provides independent exact cosine and tie/ranking comparisons", () => {
    const query = new Float32Array([1, 0]);
    const hits = exactTopK(
      query,
      [
        { id: "b", path: "b.md", ordinal: 0, vector: new Float32Array([1, 0]) },
        { id: "a", path: "a.md", ordinal: 0, vector: new Float32Array([1, 0]) },
      ],
      2
    );
    expect(hits.map((hit) => hit.id)).toEqual(["a", "b"]);
    expect(exactCosine(query, new Float32Array([0, 1]))).toBe(0);
    expect(compareRankings(hits, hits)).toMatchObject({
      exactEquality: true,
      recallAt20: 1,
      ndcgAt20: 1,
    });
  });

  it("fixes query and mutation identifiers", () => {
    expect(Object.values(QUERY_IDS)).toEqual([
      "lexical",
      "semantic",
      "hybrid-conflict",
      "tie",
      "no-match",
    ]);
    expect(MUTATION_SEQUENCE.map((step) => step.kind)).toEqual([
      "unchanged",
      "add",
      "modify",
      "delete",
      "rename",
      "exclusion",
      "interruption",
      "dirty-recovery",
    ]);
  });

  it("rejects report payloads with private fields or list-shaped values", () => {
    const valid = {
      schemaVersion: 1 as const,
      profile: "test",
      runner: "baseline",
      metrics: {
        latencyMs: { kind: "measured" as const, value: 1.25, unit: "ms", sampleCount: 2 },
      },
    };
    expect(isBenchmarkReport(valid)).toBe(true);
    expect(() => assertBenchmarkReport({ ...valid, query: "secret" })).toThrow();
    expect(() => assertBenchmarkReport({ ...valid, metrics: { ids: ["secret"] } })).toThrow();
  });
});
