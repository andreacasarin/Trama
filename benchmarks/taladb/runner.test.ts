import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { generatedArtifactPath, WORKLOAD_PROFILES, type WorkloadProfileName } from "./config";
import { createBenchmarkReport, serializeBenchmarkReport } from "./report";
import { generateWorkload } from "./workload";

/** Opt-in profile runner; output is aggregate metadata in the ignored directory. */
describe("TalaDB profile runner", () => {
  it("runs fixed profiles in ascending order", async () => {
    const names: WorkloadProfileName[] = ["oneK", "representative", "fiftyK", "oneHundredK"];
    const reports: Record<string, ReturnType<typeof createBenchmarkReport>> = {};
    for (const name of names) {
      const started = performance.now();
      const workload = generateWorkload(name, { vectorMaterializationLimit: 0 });
      const elapsed = performance.now() - started;
      reports[name] = createBenchmarkReport(name, "synthetic-chunker", {
        notes: {
          kind: "measured",
          value: workload.notes.length,
          unit: "notes",
          sampleCount: 1,
        },
        chunks: {
          kind: "measured",
          value: workload.chunks.length,
          unit: "chunks",
          sampleCount: 1,
        },
        generationMs: { kind: "measured", value: elapsed, unit: "ms", sampleCount: 1 },
      });
      const output = generatedArtifactPath(name, "report.json");
      await mkdir(output.slice(0, output.lastIndexOf("/")), { recursive: true });
      await writeFile(output, serializeBenchmarkReport(reports[name]));
    }
    expect(Object.keys(reports)).toEqual(names);
    expect(reports.oneK.metrics.chunks).toMatchObject({
      value: WORKLOAD_PROFILES.oneK.targetChunkCount,
    });
    expect(reports.representative.metrics.chunks).toMatchObject({ value: 25_000 });
    expect(reports.fiftyK.metrics.chunks).toMatchObject({ value: 50_000 });
    expect(reports.oneHundredK.metrics.chunks).toMatchObject({ value: 100_000 });
  }, 60_000);
});
