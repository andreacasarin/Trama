import { describe, expect, it } from "vitest";
import { createWorkload } from "../../test-vaults/benchmark/generator";
import { expectedOutputsV1ByProfile } from "./expected-results";
import {
  computedInputKeyCounts,
  deriveRankingProbes,
  symmetricRelatedScore,
  voceWorkerOrder,
} from "./ranking-reference";

function passage(input: string, vector: Float32Array) {
  return { input, vector };
}

describe("independent related-score reference", () => {
  it("uses the symmetric mean of each side's top two passage matches", () => {
    const aligned = new Float32Array([1, 0]);
    const orthogonal = new Float32Array([0, 1]);
    expect(
      symmetricRelatedScore(
        [passage("s1", aligned), passage("s2", orthogonal)],
        [passage("t1", aligned)]
      )
    ).toBeCloseTo(0.75);
    expect(
      symmetricRelatedScore(
        [passage("s1", aligned)],
        [passage("t1", aligned), passage("t2", orthogonal)]
      )
    ).toBeCloseTo(0.75);
  });

  it("deduplicates exact inputs but preserves distinct inputs with equal vectors", () => {
    const aligned = new Float32Array([1, 0]);
    const orthogonal = new Float32Array([0, 1]);
    const separate = new Float32Array([0, -1]);
    expect(
      symmetricRelatedScore(
        [passage("same", aligned), passage("same", aligned), passage("other", orthogonal)],
        [passage("target-a", aligned), passage("target-b", separate)]
      )
    ).toBeCloseTo(0.5);
    expect(
      symmetricRelatedScore(
        [
          passage("aligned-a", aligned),
          passage("aligned-b", aligned),
          passage("orthogonal", orthogonal),
        ],
        [passage("target-a", aligned), passage("target-b", separate)]
      )
    ).toBeCloseTo(0.75);
  });

  it("uses worker RRF tie order for Voce and score-aware tie order for Lente", () => {
    const hits = [
      {
        path: "z-semantic-first.md",
        ordinal: 0,
        id: "semantic-first",
        fused: 1 / 61 + 1 / 62,
        semanticScore: 0.9,
        lexicalScore: 0.1,
      },
      {
        path: "a-lexical-first.md",
        ordinal: 0,
        id: "lexical-first",
        fused: 1 / 61 + 1 / 62,
        semanticScore: 0.1,
        lexicalScore: 0.9,
      },
    ];
    expect(voceWorkerOrder(hits).map(({ path }) => path)).toEqual([
      "a-lexical-first.md",
      "z-semantic-first.md",
    ]);
    expect(
      [...hits]
        .sort(
          (left, right) =>
            right.fused - left.fused ||
            right.semanticScore - left.semanticScore ||
            right.lexicalScore - left.lexicalScore ||
            (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
        )
        .map(({ path }) => path)
    ).toEqual(["z-semantic-first.md", "a-lexical-first.md"]);
  });

  it("is symmetric when the source and target notes are reversed", () => {
    const source = [
      passage("s1", new Float32Array([1, 0])),
      passage("s2", new Float32Array([0, 1])),
    ];
    const target = [
      passage("t1", new Float32Array([0.8, 0.6])),
      passage("t2", new Float32Array([0, -1])),
    ];
    expect(symmetricRelatedScore(source, target)).toBeCloseTo(
      symmetricRelatedScore(target, source)
    );
  });

  it("counts all distinct input keys computed across fixture mutations independently", () => {
    const expected = {
      "trama-small": { initial: 128, everComputed: 131, finalActive: 125 },
      "trama-10k": { initial: 10_000, everComputed: 10_003, finalActive: 9_993 },
      "trama-large": { initial: 25_000, everComputed: 25_003, finalActive: 24_993 },
    } as const;
    for (const id of ["trama-small", "trama-10k", "trama-large"] as const)
      expect(computedInputKeyCounts(createWorkload(id))).toEqual(expected[id]);
  }, 30_000);

  it("rederives the pinned ranking projections from each unchanged workload", async () => {
    for (const id of ["trama-small", "trama-10k", "trama-large"] as const) {
      const actual = await deriveRankingProbes(createWorkload(id));
      expect(actual.lexical, id).toEqual(expectedOutputsV1ByProfile[id].probes.lexical);
      expect(actual.hybrid, id).toEqual(expectedOutputsV1ByProfile[id].probes.hybrid);
      expect(actual.filo, id).toEqual(expectedOutputsV1ByProfile[id].probes.filo);
      expect(actual.voce, id).toEqual(expectedOutputsV1ByProfile[id].probes.voce);
    }
  }, 120_000);
});
