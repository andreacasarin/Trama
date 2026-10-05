import type { WorkloadProfile } from "./config";
import { createHash } from "node:crypto";

export const WORKLOAD_CONTRACT_VERSION = "trama-workload-contract-v1" as const;

export interface OccurrenceOracleV1 {
  readonly noteCount: number;
  readonly occurrenceCount: number;
  /** SHA-256 of canonical ordered active occurrence tuples, including full content and inputs. */
  readonly occurrenceContentSha256: string;
  /** SHA-256 of sorted JSON `[path, activeOccurrenceCount]` pairs. */
  readonly perPathOccurrenceCountsSha256: string;
}

export interface SemanticOracleV1 {
  readonly semanticEligibleCount: number;
  readonly semanticHeadCount: number;
  readonly semanticLagCount: number;
  readonly semanticMissingCount: number;
  readonly compatibleVectorCount: number;
  readonly semanticReady: boolean;
}

export interface ResultIdentityV1 {
  readonly path: string;
  /** Included only for APIs that expose occurrence ordinals. */
  readonly occurrenceOrdinal?: number;
}

/** Lifecycle oracle values are captured from the v1 reference behavior by T2. */
export interface ExpectedOutputsV1 {
  readonly initial: OccurrenceOracleV1;
  readonly final: OccurrenceOracleV1;
  readonly semantic: SemanticOracleV1;
  readonly probes: {
    readonly lexical: readonly ResultIdentityV1[];
    readonly hybrid: readonly ResultIdentityV1[];
    readonly filo: readonly ResultIdentityV1[];
    readonly voce: readonly ResultIdentityV1[];
  };
}

export const sourceDigestsV1: Readonly<Record<WorkloadProfile["id"], string>> = {
  "trama-small": "86174d77fdec03cec1fae47980dabe682817e1b6bcb9acecf110cedb56060d37",
  "trama-10k": "822ac8dce2629647387b9f90eea2aca6980e90cc1355e5d5ef049af01436bff9",
  "trama-large": "d34ca817aac3605e20960644c6dd1964f97ae9df3ef05aaca13a8fd5b1ded108",
};

// prettier-ignore
export const REFERENCE_SOURCE_MANIFEST_SHA256 = "f6d7e424735a0b32545fcf1551f7aa521d57b62a9ecb3c38f33df2822c53c15c";

export const REFERENCE_SOURCE_MANIFEST_PATHS = [
  "scripts/benchmark/run.mjs",
  "tests/workloads/legacy-oracle.ts",
  "tests/sqlite-test-client.ts",
  "tests/workloads/benchmark-lifecycle.ts",
  "test-vaults/benchmark/config.ts",
  "test-vaults/benchmark/contract-v1.ts",
  "tests/workloads/evidence.test.ts",
  "test-vaults/benchmark/generator.ts",
  "tests/workloads/instrumentation.ts",
  "tests/workloads/trama-benchmark.ts",
  "tests/workloads/ranking-reference.ts",
  "tests/workloads/ranking-reference.test.ts",
] as const;

export function computeReferenceSourceManifestSha256(
  readBytes: (path: string) => Uint8Array
): string {
  const hash = createHash("sha256");
  const paths = [...REFERENCE_SOURCE_MANIFEST_PATHS].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
  const declaration = /export const REFERENCE_SOURCE_MANIFEST_SHA256 = "([0-9a-f]{64})";/g;
  for (const path of paths) {
    let sourceBytes = Buffer.from(readBytes(path));
    if (path === "test-vaults/benchmark/contract-v1.ts") {
      const source = sourceBytes.toString("utf8");
      const declarations = [...source.matchAll(declaration)];
      if (declarations.length !== 1) {
        throw new Error("Expected exactly one reference source manifest declaration.");
      }
      sourceBytes = Buffer.from(
        source.replace(
          declaration,
          'export const REFERENCE_SOURCE_MANIFEST_SHA256 = "' + "0".repeat(64) + '";'
        ),
        "utf8"
      );
    }
    const pathBytes = Buffer.from(path, "utf8");
    const pathLength = Buffer.alloc(8);
    pathLength.writeBigUInt64LE(BigInt(pathBytes.length));
    const sourceLength = Buffer.alloc(8);
    sourceLength.writeBigUInt64LE(BigInt(sourceBytes.length));
    hash.update(pathLength).update(pathBytes).update(sourceLength).update(sourceBytes);
  }
  return hash.digest("hex");
}

export const referenceBaselineV1 = {
  referenceBaseRevision: "17455e78f3654a2033999e786dad527f8a463e3c",
  referenceTreeStatus: "uncommitted contract implementation",
  referenceSourceManifestSha256: REFERENCE_SOURCE_MANIFEST_SHA256,
  settings: { timeoutMs: 300000, repetitions: 1, diagnostics: true },
  sourceDigests: sourceDigestsV1,
} as const;

export const DETERMINISTIC_PROVIDER_BEHAVIOR_VERSION = "trama-deterministic-provider-v1" as const;
export const deterministicProviderChallengeSha256 =
  "da609bed7a65f51e21ed579971f02dab7d70eb60dbeecc34dc72a3e441983747";
export const queryVectorSha256V1 =
  "7b0fa73abfdf474642ea98dac60e72c29c5566e5814f760c8365c5e3b3fe118b";

export { expectedOutputsV1ByProfile } from "../../tests/workloads/legacy-oracle";
