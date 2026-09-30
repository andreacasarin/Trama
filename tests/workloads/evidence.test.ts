import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createWorkload } from "./generator";
import {
  benchmarkCorrectnessFailure,
  benchmarkFailureStatus,
  sanitizeBenchmarkError,
} from "./benchmark-lifecycle";
import { benchmarkRssWindow, runTramaBenchmark } from "./trama-benchmark";
import {
  computeReferenceSourceManifestSha256,
  REFERENCE_SOURCE_MANIFEST_SHA256,
} from "./contract-v1";

type ManifestEvidence = {
  expectedSha256: string;
  observedSha256: string | null;
  status: "match" | "mismatch" | "error";
};

function assertManifestRunnable(manifest: ManifestEvidence, capture: boolean): void {
  if (manifest.status === "error") throw new Error("Reference source manifest could not be read.");
  if (manifest.status === "mismatch" && !capture) {
    throw new Error("Reference source manifest mismatch.");
  }
}

function observeReferenceManifest(): ManifestEvidence {
  try {
    const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
    const observedSha256 = computeReferenceSourceManifestSha256((path) =>
      readFileSync(resolve(root, path))
    );
    return {
      expectedSha256: REFERENCE_SOURCE_MANIFEST_SHA256,
      observedSha256,
      status: observedSha256 === REFERENCE_SOURCE_MANIFEST_SHA256 ? "match" : "mismatch",
    };
  } catch {
    return {
      expectedSha256: REFERENCE_SOURCE_MANIFEST_SHA256,
      observedSha256: null,
      status: "error",
    };
  }
}

describe("Trama deterministic benchmark", () => {
  let referenceManifest: ManifestEvidence;
  const capture = Boolean(process.env.TRAMA_BENCHMARK_CAPTURE);

  beforeAll(() => {
    referenceManifest = observeReferenceManifest();
    try {
      assertManifestRunnable(referenceManifest, capture);
    } catch (error) {
      if (process.env.TRAMA_BENCHMARK) {
        const profile = process.env.TRAMA_BENCHMARK_PROFILE ?? "trama-small";
        const outputDirectory = ".artifacts/trama-benchmark";
        mkdirSync(outputDirectory, { recursive: true });
        writeFileSync(
          `${outputDirectory}/${profile}.json`,
          `${JSON.stringify(
            {
              status: "error",
              profile,
              referenceManifest,
              error: sanitizeBenchmarkError(error),
            },
            null,
            2
          )}\n`
        );
      }
      throw error;
    }
  });

  it("gates workload creation and execution on the reference manifest", () => {
    const create = vi.fn();
    const run = vi.fn();
    const invoke = (manifest: ManifestEvidence, capture = false) => {
      assertManifestRunnable(manifest, capture);
      run(create());
    };
    const mismatch: ManifestEvidence = {
      expectedSha256: "expected",
      observedSha256: "observed",
      status: "mismatch",
    };
    const readError: ManifestEvidence = {
      expectedSha256: "expected",
      observedSha256: null,
      status: "error",
    };
    expect(() => invoke(mismatch)).toThrow("Reference source manifest mismatch.");
    expect(() => invoke(readError)).toThrow("could not be read");
    expect(create).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(() => invoke(mismatch, true)).not.toThrow();
  });

  it("keeps core observations stable when diagnostics and query repetitions vary", async () => {
    expect(referenceManifest.status).toBe("match");
    const workload = createWorkload("trama-small");
    const diagnostic = await runTramaBenchmark(workload, { diagnostics: true, repetitions: 1 });
    const coreOnly = await runTramaBenchmark(workload, { diagnostics: false, repetitions: 1 });
    expect(coreOnly.core.scenarioNames).toEqual(diagnostic.core.scenarioNames);
    expect(coreOnly.core.providerCalls).toBe(diagnostic.core.providerCalls);
    expect(coreOnly.core.providerTexts).toBe(diagnostic.core.providerTexts);
    expect(coreOnly.core.observable).toEqual(diagnostic.core.observable);
    expect(coreOnly.provider).toEqual(diagnostic.provider);
    expect(diagnostic.memory.rssWindow).toEqual(benchmarkRssWindow(true));
    expect(coreOnly.correctness.providerIdentityMatches).toBe(true);
    expect(coreOnly.correctness.queryVectorIdentityMatches).toBe(true);
    expect(coreOnly.correctness.occurrenceContentMatches).toBe(true);
    expect(coreOnly.correctness.publishedSemanticMatchesAdopted).toBe(true);
    expect(coreOnly.sourceDigest).toBe(diagnostic.sourceDigest);
    expect(coreOnly.correctness).toEqual(diagnostic.correctness);
    expect(coreOnly.diagnostics).toBeUndefined();
    expect(coreOnly.rpcLatencyMs).toBeUndefined();
    expect(coreOnly.counters).toBeUndefined();
  });

  it.runIf(Boolean(process.env.TRAMA_BENCHMARK))(
    "measures the selected deterministic workload",
    async () => {
      const profile = (process.env.TRAMA_BENCHMARK_PROFILE ?? "trama-small") as
        "trama-small" | "trama-10k" | "trama-large";
      const timeoutMs = Number(process.env.TRAMA_BENCHMARK_TIMEOUT_MS ?? 300_000);
      const outputDirectory = ".artifacts/trama-benchmark";
      mkdirSync(outputDirectory, { recursive: true });
      const started = performance.now();
      const workload = createWorkload(profile);
      let partial: {
        readonly durationMs: Readonly<Record<string, number>>;
        readonly scenarios: Readonly<Record<string, unknown>>;
        readonly counters: unknown;
        readonly publicationCompleted: boolean;
      } = { durationMs: {}, scenarios: {}, counters: {}, publicationCompleted: false };
      let evidence;
      try {
        evidence = await runTramaBenchmark(workload, {
          repetitions: Number(process.env.TRAMA_BENCHMARK_REPETITIONS ?? 1),
          timeoutMs,
          diagnostics: process.env.TRAMA_BENCHMARK_DIAGNOSTICS !== "0",
          onScenario: (name, scenario, counters, durationMs, scenarios) => {
            partial = {
              durationMs: { ...durationMs },
              scenarios: { ...scenarios },
              counters,
              publicationCompleted:
                partial.publicationCompleted || (name === "publish" && scenario.converged === true),
            };
          },
        });
        const evidenceWithManifest = {
          ...evidence,
          referenceManifest,
          correctness: {
            ...evidence.correctness,
            referenceManifestMatches: referenceManifest.status === "match",
          },
        };
        const correctnessFailure = benchmarkCorrectnessFailure(evidenceWithManifest.correctness);
        if (correctnessFailure && !capture) throw correctnessFailure;
        writeFileSync(
          `${outputDirectory}/${evidence.profile}.json`,
          `${JSON.stringify({ status: capture ? "reference-capture" : "completed", ...evidenceWithManifest }, null, 2)}\n`
        );
      } catch (error) {
        const elapsedMs = performance.now() - started;
        const status = benchmarkFailureStatus(error);
        writeFileSync(
          `${outputDirectory}/${profile}.json`,
          `${JSON.stringify(
            {
              status,
              profile,
              referenceManifest,
              timeoutMs,
              elapsedMs,
              environment: {
                node: process.version,
                platform: process.platform,
                arch: process.arch,
                repetitions: Number(process.env.TRAMA_BENCHMARK_REPETITIONS ?? 1),
              },
              error: sanitizeBenchmarkError(error, [
                ...workload.notes.map((note) => note.content),
                ...workload.mutations.flatMap((mutation) =>
                  mutation.note ? [mutation.note.content] : []
                ),
              ]),
              completedScenarios: Object.keys(partial.scenarios),
              durationMs: partial.durationMs,
              scenarios: partial.scenarios,
              counters: partial.counters,
              memory: { rssWindow: benchmarkRssWindow(partial.publicationCompleted) },
              limitations:
                status === "timeout"
                  ? [
                      "Current product code exceeded the configured benchmark timeout before completing the lifecycle.",
                    ]
                  : ["The benchmark lifecycle failed before completing the evidence run."],
            },
            null,
            2
          )}\n`
        );
        throw error;
      }
    },
    3_600_000
  );
});
