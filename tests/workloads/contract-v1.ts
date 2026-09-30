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
export const REFERENCE_SOURCE_MANIFEST_SHA256 = "2e174de794a0c437c3a9b3a927dcda61af48faaabf3931e700d4e34108382eec";

export const REFERENCE_SOURCE_MANIFEST_PATHS = [
  "scripts/benchmark/run.mjs",
  "tests/sqlite-test-client.ts",
  "tests/workloads/benchmark-lifecycle.ts",
  "tests/workloads/config.ts",
  "tests/workloads/contract-v1.ts",
  "tests/workloads/evidence.test.ts",
  "tests/workloads/generator.ts",
  "tests/workloads/instrumentation.ts",
  "tests/workloads/trama-benchmark.ts",
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
    if (path === "tests/workloads/contract-v1.ts") {
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

export const expectedOutputsV1ByProfile: Readonly<
  Record<WorkloadProfile["id"], ExpectedOutputsV1>
> = {
  "trama-small": {
    initial: {
      noteCount: 24,
      occurrenceCount: 128,
      perPathOccurrenceCountsSha256:
        "492469d48354dbda7c259b901097cf04be06af1c156dd8bd15553d38f8c516f2",
      occurrenceContentSha256: "f99615a817b3728839b9b11986b1ce49dee834ba5de0bfce65003e1030da3d10",
    },
    final: {
      noteCount: 24,
      occurrenceCount: 125,
      perPathOccurrenceCountsSha256:
        "1431f4bfb28a78f029bf5ccad65e0e2d6cde7e70aea9e9dd86677d5ca671e7da",
      occurrenceContentSha256: "441fa187f984aa797ede4edb9884688a1b9acb8ca9e4061924b37f0df290fd50",
    },
    semantic: {
      semanticEligibleCount: 24,
      semanticHeadCount: 24,
      semanticLagCount: 0,
      semanticMissingCount: 0,
      compatibleVectorCount: 125,
      semanticReady: true,
    },
    probes: {
      lexical: [
        {
          path: "notes/00003/note-3.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "00-special/😀.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "mutations/renamed.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "00-special/Ä.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "00-special/a.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00004/note-4.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00005/note-5.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00006/note-6.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00009/note-9.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00010/note-10.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00011/note-11.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00012/note-12.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00013/note-13.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00014/note-14.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00015/note-15.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00016/note-16.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00017/note-17.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00018/note-18.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00019/note-19.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00020/note-20.md",
          occurrenceOrdinal: 3,
        },
      ],
      hybrid: [
        {
          path: "mutations/renamed.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00006/note-6.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "00-special/a.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00012/note-12.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00013/note-13.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "00-special/😀.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00003/note-3.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00014/note-14.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00010/note-10.md",
          occurrenceOrdinal: 4,
        },
        {
          path: "00-special/Ä.md",
          occurrenceOrdinal: 4,
        },
        {
          path: "notes/00009/note-9.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00022/note-22.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00016/note-16.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00015/note-15.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00011/note-11.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00004/note-4.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00021/note-21.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00005/note-5.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00020/note-20.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00019/note-19.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00017/note-17.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00023/note-23.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00018/note-18.md",
          occurrenceOrdinal: 4,
        },
        {
          path: "mutations/added.md",
          occurrenceOrdinal: 1,
        },
      ],
      filo: [
        {
          path: "notes/00009/note-9.md",
        },
        {
          path: "notes/00018/note-18.md",
        },
        {
          path: "notes/00022/note-22.md",
        },
        {
          path: "00-special/😀.md",
        },
        {
          path: "notes/00020/note-20.md",
        },
        {
          path: "notes/00021/note-21.md",
        },
        {
          path: "notes/00006/note-6.md",
        },
      ],
      voce: [
        {
          path: "mutations/renamed.md",
        },
        {
          path: "notes/00006/note-6.md",
        },
        {
          path: "00-special/a.md",
        },
        {
          path: "notes/00012/note-12.md",
        },
        {
          path: "notes/00013/note-13.md",
        },
        {
          path: "00-special/😀.md",
        },
        {
          path: "notes/00003/note-3.md",
        },
      ],
    },
  },
  "trama-10k": {
    initial: {
      noteCount: 1100,
      occurrenceCount: 10000,
      perPathOccurrenceCountsSha256:
        "9e5c798bc07f7094d7dcac0f1b8fe97f05368c33001b833aa3b7cb7eb928c68f",
      occurrenceContentSha256: "719a6a3b02c8980cce220f3c07abcc2f8cb03fb0b4bb22ff3bec6959eff55c81",
    },
    final: {
      noteCount: 1100,
      occurrenceCount: 9993,
      perPathOccurrenceCountsSha256:
        "a63948fd204987bb84ee6748a8e61b8626e02e08b7d596e7c2b1af186a81cd5a",
      occurrenceContentSha256: "5476c2d03af1f3f4f8c78a71a69dc4b34ad14e420b9aff0e7d57883f5c554113",
    },
    semantic: {
      semanticEligibleCount: 1100,
      semanticHeadCount: 1100,
      semanticLagCount: 0,
      semanticMissingCount: 0,
      compatibleVectorCount: 9993,
      semanticReady: true,
    },
    probes: {
      lexical: [
        {
          path: "notes/00003/note-3.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "00-special/😀.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "mutations/renamed.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "00-special/Ä.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "00-special/a.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00004/note-4.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00005/note-5.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00006/note-6.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00009/note-9.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00010/note-10.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00011/note-11.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00012/note-12.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00013/note-13.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00014/note-14.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00015/note-15.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00016/note-16.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00017/note-17.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00018/note-18.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00019/note-19.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00020/note-20.md",
          occurrenceOrdinal: 3,
        },
      ],
      hybrid: [
        {
          path: "notes/00054/note-54.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00030/note-30.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00012/note-12.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00013/note-13.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00039/note-39.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00116/note-116.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00156/note-156.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00149/note-149.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00286/note-286.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00003/note-3.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00909/note-909.md",
          occurrenceOrdinal: 8,
        },
        {
          path: "00-special/😀.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00490/note-490.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "mutations/renamed.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00384/note-384.md",
          occurrenceOrdinal: 4,
        },
        {
          path: "00-special/Ä.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00061/note-61.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00041/note-41.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00671/note-671.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "00-special/a.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00455/note-455.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00004/note-4.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00100/note-100.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/00779/note-779.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/00005/note-5.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00776/note-776.md",
          occurrenceOrdinal: 4,
        },
        {
          path: "notes/00006/note-6.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00088/note-88.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00059/note-59.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00998/note-998.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00009/note-9.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01047/note-1047.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00010/note-10.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00074/note-74.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00558/note-558.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00011/note-11.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00150/note-150.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00171/note-171.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/00106/note-106.md",
          occurrenceOrdinal: 4,
        },
        {
          path: "notes/00322/note-322.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00014/note-14.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00057/note-57.md",
          occurrenceOrdinal: 9,
        },
        {
          path: "notes/00429/note-429.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00015/note-15.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00101/note-101.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00158/note-158.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00653/note-653.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00016/note-16.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00146/note-146.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00710/note-710.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00017/note-17.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00018/note-18.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00019/note-19.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00773/note-773.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00020/note-20.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00021/note-21.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00844/note-844.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00022/note-22.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00377/note-377.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00023/note-23.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00081/note-81.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00425/note-425.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00024/note-24.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00330/note-330.md",
          occurrenceOrdinal: 4,
        },
        {
          path: "notes/00025/note-25.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00616/note-616.md",
          occurrenceOrdinal: 4,
        },
        {
          path: "notes/00026/note-26.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00218/note-218.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/00027/note-27.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00130/note-130.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/01003/note-1003.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00028/note-28.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00087/note-87.md",
          occurrenceOrdinal: 8,
        },
        {
          path: "notes/00369/note-369.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/00029/note-29.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00863/note-863.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00759/note-759.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/00031/note-31.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00908/note-908.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/00032/note-32.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00214/note-214.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/00033/note-33.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00836/note-836.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00034/note-34.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00345/note-345.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00035/note-35.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00637/note-637.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00036/note-36.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00364/note-364.md",
          occurrenceOrdinal: 8,
        },
        {
          path: "notes/00037/note-37.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00778/note-778.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00038/note-38.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00911/note-911.md",
          occurrenceOrdinal: 4,
        },
        {
          path: "notes/00941/note-941.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00040/note-40.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00512/note-512.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00302/note-302.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00042/note-42.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01056/note-1056.md",
          occurrenceOrdinal: 4,
        },
        {
          path: "notes/00043/note-43.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01006/note-1006.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00044/note-44.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00045/note-45.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00215/note-215.md",
          occurrenceOrdinal: 8,
        },
        {
          path: "notes/00046/note-46.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00352/note-352.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00047/note-47.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00922/note-922.md",
          occurrenceOrdinal: 8,
        },
        {
          path: "notes/00048/note-48.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00049/note-49.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00246/note-246.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00050/note-50.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00402/note-402.md",
          occurrenceOrdinal: 8,
        },
        {
          path: "notes/00051/note-51.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00783/note-783.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00052/note-52.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00946/note-946.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00053/note-53.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00055/note-55.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00056/note-56.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00268/note-268.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00531/note-531.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00058/note-58.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01036/note-1036.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00816/note-816.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00060/note-60.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00965/note-965.md",
          occurrenceOrdinal: 8,
        },
        {
          path: "notes/00062/note-62.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00572/note-572.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00063/note-63.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00504/note-504.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00064/note-64.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00397/note-397.md",
          occurrenceOrdinal: 8,
        },
        {
          path: "notes/00065/note-65.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00066/note-66.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00163/note-163.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00067/note-67.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01057/note-1057.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00068/note-68.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00263/note-263.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00069/note-69.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00070/note-70.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00787/note-787.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00071/note-71.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00904/note-904.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00072/note-72.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00247/note-247.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00073/note-73.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00811/note-811.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/01087/note-1087.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00075/note-75.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00076/note-76.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00724/note-724.md",
          occurrenceOrdinal: 8,
        },
        {
          path: "notes/00077/note-77.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01001/note-1001.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00078/note-78.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00362/note-362.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00079/note-79.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00554/note-554.md",
          occurrenceOrdinal: 4,
        },
        {
          path: "notes/00080/note-80.md",
          occurrenceOrdinal: 3,
        },
      ],
      filo: [
        {
          path: "notes/00508/note-508.md",
        },
        {
          path: "notes/00807/note-807.md",
        },
        {
          path: "notes/00633/note-633.md",
        },
        {
          path: "notes/00406/note-406.md",
        },
        {
          path: "notes/00437/note-437.md",
        },
        {
          path: "notes/00308/note-308.md",
        },
        {
          path: "notes/00999/note-999.md",
        },
      ],
      voce: [
        {
          path: "notes/00054/note-54.md",
        },
        {
          path: "notes/00030/note-30.md",
        },
        {
          path: "notes/00012/note-12.md",
        },
        {
          path: "notes/00013/note-13.md",
        },
        {
          path: "notes/00039/note-39.md",
        },
        {
          path: "notes/00116/note-116.md",
        },
        {
          path: "notes/00156/note-156.md",
        },
      ],
    },
  },
  "trama-large": {
    initial: {
      noteCount: 2750,
      occurrenceCount: 25000,
      perPathOccurrenceCountsSha256:
        "4633ffbf4b7d19aeccf48df6fb58242f351c187354e15b22ba64fd10ee2c3164",
      occurrenceContentSha256: "e24e11adbaa782f9c93e6a41b157a7102ffefbb85d4dc05afd48d6cd6a6c033c",
    },
    final: {
      noteCount: 2750,
      occurrenceCount: 24993,
      perPathOccurrenceCountsSha256:
        "4cce20e482b3f351d4cd4f582bdb066d6e253325722494e4a7f3ad3f0203644c",
      occurrenceContentSha256: "2e72723a07035cf81f328e36eca519450a33caa104948c1e278fd6d82d375686",
    },
    semantic: {
      semanticEligibleCount: 2750,
      semanticHeadCount: 2750,
      semanticLagCount: 0,
      semanticMissingCount: 0,
      compatibleVectorCount: 24993,
      semanticReady: true,
    },
    probes: {
      lexical: [
        {
          path: "notes/00003/note-3.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "00-special/😀.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "mutations/renamed.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "00-special/Ä.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "00-special/a.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00004/note-4.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00005/note-5.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00006/note-6.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00009/note-9.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00010/note-10.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00011/note-11.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00012/note-12.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00013/note-13.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00014/note-14.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00015/note-15.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00016/note-16.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00017/note-17.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00018/note-18.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00019/note-19.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00020/note-20.md",
          occurrenceOrdinal: 3,
        },
      ],
      hybrid: [
        {
          path: "notes/00054/note-54.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00030/note-30.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/02162/note-2162.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00003/note-3.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02376/note-2376.md",
          occurrenceOrdinal: 8,
        },
        {
          path: "00-special/😀.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02732/note-2732.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "mutations/renamed.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02452/note-2452.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "00-special/Ä.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01994/note-1994.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "00-special/a.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00286/note-286.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00004/note-4.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00039/note-39.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01636/note-1636.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00005/note-5.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00909/note-909.md",
          occurrenceOrdinal: 8,
        },
        {
          path: "notes/00006/note-6.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00490/note-490.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00009/note-9.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00116/note-116.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00384/note-384.md",
          occurrenceOrdinal: 4,
        },
        {
          path: "notes/00010/note-10.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02199/note-2199.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00011/note-11.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02654/note-2654.md",
          occurrenceOrdinal: 8,
        },
        {
          path: "notes/00012/note-12.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00156/note-156.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00149/note-149.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00671/note-671.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00013/note-13.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00455/note-455.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00014/note-14.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01879/note-1879.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00015/note-15.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01893/note-1893.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00016/note-16.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01802/note-1802.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00017/note-17.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00779/note-779.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/00018/note-18.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00776/note-776.md",
          occurrenceOrdinal: 4,
        },
        {
          path: "notes/00019/note-19.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02400/note-2400.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00020/note-20.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01853/note-1853.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00021/note-21.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01726/note-1726.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00022/note-22.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02122/note-2122.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00023/note-23.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00998/note-998.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00024/note-24.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01420/note-1420.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00025/note-25.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02724/note-2724.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00026/note-26.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01768/note-1768.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00027/note-27.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01294/note-1294.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00028/note-28.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01047/note-1047.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00029/note-29.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00100/note-100.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/02697/note-2697.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/02259/note-2259.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00031/note-31.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02737/note-2737.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00032/note-32.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00558/note-558.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00033/note-33.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01414/note-1414.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00034/note-34.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02704/note-2704.md",
          occurrenceOrdinal: 8,
        },
        {
          path: "notes/00035/note-35.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02414/note-2414.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00036/note-36.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00171/note-171.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/00037/note-37.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01951/note-1951.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00038/note-38.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01111/note-1111.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00322/note-322.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00040/note-40.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00150/note-150.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/01667/note-1667.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00041/note-41.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00042/note-42.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01552/note-1552.md",
          occurrenceOrdinal: 4,
        },
        {
          path: "notes/00043/note-43.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00429/note-429.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00044/note-44.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00653/note-653.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00045/note-45.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00158/note-158.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00710/note-710.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00046/note-46.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01650/note-1650.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00047/note-47.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01481/note-1481.md",
          occurrenceOrdinal: 8,
        },
        {
          path: "notes/00048/note-48.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01535/note-1535.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/00049/note-49.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00050/note-50.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01374/note-1374.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00051/note-51.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00052/note-52.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00773/note-773.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00053/note-53.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02672/note-2672.md",
          occurrenceOrdinal: 2,
        },
        {
          path: "notes/00055/note-55.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00844/note-844.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00056/note-56.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01313/note-1313.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00057/note-57.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01212/note-1212.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00058/note-58.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01133/note-1133.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00059/note-59.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00377/note-377.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00060/note-60.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01322/note-1322.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00061/note-61.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00425/note-425.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00062/note-62.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02692/note-2692.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00063/note-63.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02599/note-2599.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00064/note-64.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02010/note-2010.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00065/note-65.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00330/note-330.md",
          occurrenceOrdinal: 4,
        },
        {
          path: "notes/00066/note-66.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01603/note-1603.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00067/note-67.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00616/note-616.md",
          occurrenceOrdinal: 4,
        },
        {
          path: "notes/00068/note-68.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00236/note-236.md",
          occurrenceOrdinal: 9,
        },
        {
          path: "notes/00069/note-69.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00218/note-218.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/00070/note-70.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/01003/note-1003.md",
          occurrenceOrdinal: 7,
        },
        {
          path: "notes/00071/note-71.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00369/note-369.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/00072/note-72.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02043/note-2043.md",
          occurrenceOrdinal: 1,
        },
        {
          path: "notes/00073/note-73.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02484/note-2484.md",
          occurrenceOrdinal: 0,
        },
        {
          path: "notes/00074/note-74.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00863/note-863.md",
          occurrenceOrdinal: 5,
        },
        {
          path: "notes/00075/note-75.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/02149/note-2149.md",
          occurrenceOrdinal: 8,
        },
        {
          path: "notes/00076/note-76.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00759/note-759.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/00077/note-77.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00908/note-908.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/00078/note-78.md",
          occurrenceOrdinal: 3,
        },
        {
          path: "notes/00214/note-214.md",
          occurrenceOrdinal: 6,
        },
        {
          path: "notes/00079/note-79.md",
          occurrenceOrdinal: 3,
        },
      ],
      filo: [
        {
          path: "notes/01445/note-1445.md",
        },
        {
          path: "notes/00508/note-508.md",
        },
        {
          path: "notes/01332/note-1332.md",
        },
        {
          path: "notes/01825/note-1825.md",
        },
        {
          path: "notes/02052/note-2052.md",
        },
        {
          path: "notes/01125/note-1125.md",
        },
        {
          path: "notes/00807/note-807.md",
        },
      ],
      voce: [
        {
          path: "notes/00054/note-54.md",
        },
        {
          path: "notes/00030/note-30.md",
        },
        {
          path: "notes/00003/note-3.md",
        },
        {
          path: "notes/02162/note-2162.md",
        },
        {
          path: "00-special/😀.md",
        },
        {
          path: "notes/02376/note-2376.md",
        },
        {
          path: "mutations/renamed.md",
        },
      ],
    },
  },
};
