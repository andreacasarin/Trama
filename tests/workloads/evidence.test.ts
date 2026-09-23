import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { describe, it } from "vitest";
import { createWorkload } from "./generator";
import {
  benchmarkCorrectnessFailure,
  benchmarkFailureStatus,
  sanitizeBenchmarkError,
} from "./benchmark-lifecycle";
import { runTramaBenchmark } from "./trama-benchmark";

describe("Trama deterministic benchmark", () => {
  it.runIf(Boolean(process.env.TRAMA_BENCHMARK))(
    "measures the selected deterministic workload",
    async () => {
      const profile = (process.env.TRAMA_BENCHMARK_PROFILE ?? "trama-small") as
        "trama-small" | "trama-10k" | "trama-large";
      const timeoutMs = Number(process.env.TRAMA_BENCHMARK_TIMEOUT_MS ?? 300_000);
      const started = performance.now();
      const outputDirectory = ".artifacts/trama-benchmark";
      mkdirSync(outputDirectory, { recursive: true });
      const workload = createWorkload(profile);
      let partial: {
        readonly durationMs: Readonly<Record<string, number>>;
        readonly scenarios: Readonly<Record<string, unknown>>;
        readonly counters: unknown;
      } = { durationMs: {}, scenarios: {}, counters: {} };
      let evidence;
      try {
        evidence = await runTramaBenchmark(workload, {
          repetitions: Number(process.env.TRAMA_BENCHMARK_REPETITIONS ?? 1),
          timeoutMs,
          onScenario: (_name, _scenario, counters, durationMs, scenarios) => {
            partial = { durationMs: { ...durationMs }, scenarios: { ...scenarios }, counters };
          },
        });
        const correctnessFailure = benchmarkCorrectnessFailure(evidence.correctness);
        if (correctnessFailure) throw correctnessFailure;
        writeFileSync(
          `${outputDirectory}/${evidence.profile}.json`,
          `${JSON.stringify({ status: "completed", ...evidence }, null, 2)}\n`
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
