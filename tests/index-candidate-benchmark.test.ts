import { stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runBenchmark } from "../scripts/benchmarks/benchmarkRunner";

async function artifactState(
  path: URL
): Promise<{ readonly mtimeMs: number; readonly size: number } | null> {
  try {
    const value = await stat(path);
    return { mtimeMs: value.mtimeMs, size: value.size };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

describe("frozen unified Orama candidate workload", () => {
  it("captures sanitized measurements from the candidate indexing source", async () => {
    const artifact = new URL("../.index-benchmark/candidate.json", import.meta.url);
    const before = await artifactState(artifact);
    const report = await runBenchmark("candidate-unified-orama");
    const after = await artifactState(artifact);
    expect(report.schemaVersion).toBe(1);
    expect(report.harness).toBe("unified-orama");
    expect(report.scales.length).toBeGreaterThan(0);
    expect(report.scales.every((scale) => Number.isFinite(scale.buildMs))).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(
      /"(?:content|embedding|vector|hash|commit|id|path|raw|error|database)"/i
    );
    expect(after).toEqual(before);
  }, 120_000);
});
