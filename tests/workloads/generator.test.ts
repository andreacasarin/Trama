import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { WORKLOAD_DIMENSIONS } from "../../test-vaults/benchmark/config";
import {
  deterministicProviderChallengeSha256,
  DETERMINISTIC_PROVIDER_BEHAVIOR_VERSION,
  computeReferenceSourceManifestSha256,
  queryVectorSha256V1,
  REFERENCE_SOURCE_MANIFEST_PATHS,
  REFERENCE_SOURCE_MANIFEST_SHA256,
  referenceBaselineV1,
  sourceDigestsV1,
  WORKLOAD_CONTRACT_VERSION,
} from "../../test-vaults/benchmark/contract-v1";
import {
  createWorkload,
  deterministicEmbeddingVector,
  deterministicProviderChallengeDigest,
  PROVIDER_CHALLENGE_INPUTS_V1,
  workloadDigest,
  workloadQueryVectorDigest,
  workloadSourceDigest,
} from "../../test-vaults/benchmark/generator";

describe("deterministic Trama workload generator", () => {
  it("keeps the committed small-vault Markdown byte-identical to the v1 workload", () => {
    for (const note of createWorkload("trama-small").notes)
      expect(readFileSync(`test-vaults/benchmark/trama-small/${note.path}`, "utf8")).toBe(
        note.content
      );
  });
  it("pins v1 source bytes independently of production chunking", () => {
    expect(WORKLOAD_CONTRACT_VERSION).toBe("trama-workload-contract-v1");
    for (const id of ["trama-small", "trama-10k", "trama-large"] as const) {
      const workload = createWorkload(id);
      expect(workloadSourceDigest(workload)).toBe(sourceDigestsV1[id]);
    }
  });

  it("generates deterministic 768d vectors from requested input text", () => {
    const first = deterministicEmbeddingVector("serialized embedding input");
    const second = deterministicEmbeddingVector("serialized embedding input");
    const other = deterministicEmbeddingVector("different serialized input");
    expect(first).toHaveLength(WORKLOAD_DIMENSIONS);
    expect(Array.from(first)).toEqual(Array.from(second));
    expect(Array.from(first)).not.toEqual(Array.from(other));
  });

  it("pins provider challenge behavior and ordered query vectors", () => {
    expect(DETERMINISTIC_PROVIDER_BEHAVIOR_VERSION).toBe("trama-deterministic-provider-v1");
    expect(deterministicProviderChallengeDigest()).toBe(deterministicProviderChallengeSha256);
    const workload = createWorkload("trama-small");
    expect(
      workload.queries.every((query) => PROVIDER_CHALLENGE_INPUTS_V1.includes(query.text as never))
    ).toBe(true);
    expect(workloadQueryVectorDigest(workload)).toBe(queryVectorSha256V1);
  });

  it("pins the reference source manifest with only its hash literal normalized", () => {
    const files = new Map<string, Uint8Array>(
      REFERENCE_SOURCE_MANIFEST_PATHS.map((path) => [path, Buffer.from(`fixture:${path}`)])
    );
    files.set(
      "test-vaults/benchmark/contract-v1.ts",
      Buffer.from(
        `export const REFERENCE_SOURCE_MANIFEST_SHA256 = "${REFERENCE_SOURCE_MANIFEST_SHA256}";`,
        "utf8"
      )
    );
    const observed = computeReferenceSourceManifestSha256((path) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`Unexpected manifest path: ${path}`);
      return bytes;
    });
    expect(observed).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      computeReferenceSourceManifestSha256((path) =>
        path === "test-vaults/benchmark/contract-v1.ts"
          ? Buffer.from(
              `export const REFERENCE_SOURCE_MANIFEST_SHA256 = "${REFERENCE_SOURCE_MANIFEST_SHA256}";\nexport const REFERENCE_SOURCE_MANIFEST_SHA256 = "${REFERENCE_SOURCE_MANIFEST_SHA256}";`
            )
          : (files.get(path) as Uint8Array)
      )
    ).toThrow("Expected exactly one reference source manifest declaration.");
    expect(referenceBaselineV1.referenceSourceManifestSha256).toBe(
      REFERENCE_SOURCE_MANIFEST_SHA256
    );
    expect(referenceBaselineV1.referenceTreeStatus).toBe("uncommitted contract implementation");
  });

  it("uses real chunking, normalized 768d vectors, and stable mutations", () => {
    const fixture = { id: "trama-10k" as const, noteCount: 10, targetChunks: 20 };
    const first = createWorkload(fixture);
    const second = createWorkload(fixture);
    expect(workloadDigest(first)).toBe(workloadDigest(second));
    expect(first.notes).toHaveLength(10);
    expect(first.notes.reduce((sum, note) => sum + note.chunks.length, 0)).toBe(20);
    expect(first.notes.map((note) => note.path)).toEqual(
      [...first.notes.map((note) => note.path)].sort()
    );
    expect(
      first.notes.flatMap((note) => note.chunks).every((chunk) => chunk.vector.length === 768)
    ).toBe(true);
    expect(first.notes.flatMap((note) => note.chunks).every((chunk) => chunk.embeddingInput)).toBe(
      true
    );
    expect(first.mutations.map((mutation) => mutation.kind)).toEqual([
      "unchanged",
      "add",
      "modify",
      "delete",
      "rename",
    ]);
  });
});
