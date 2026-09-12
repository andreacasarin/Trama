import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { UNIFIED_ORAMA_BENCHMARK_CONFIG } from "../scripts/benchmarks/benchmarkConfig";
import type { SanitizedBenchmarkReport } from "../scripts/benchmarks/benchmarkSchema";

interface BaselineEvidence extends SanitizedBenchmarkReport {
  readonly source: "pre-replacement current indexing source";
  readonly workload: {
    readonly schemaVersion: number;
    readonly seed: "0x517a2911";
    readonly dimensions: number;
    readonly chunkSize: number;
    readonly overlap: number;
    readonly scales: readonly number[];
    readonly queryCount: number;
    readonly warmupQueries: number;
  };
}

describe("frozen unified Orama baseline evidence", () => {
  it("validates the committed sanitized pre-replacement capture without writing it", async () => {
    const raw = await readFile(
      new URL("../docs/benchmarks/unified-orama-baseline.json", import.meta.url),
      "utf8"
    );
    const report = JSON.parse(raw) as BaselineEvidence;
    expect(report.schemaVersion).toBe(1);
    expect(report.harness).toBe("unified-orama");
    expect(report.backend).toBe("baseline-current-source");
    expect(report.source).toBe("pre-replacement current indexing source");
    expect(report.workload).toEqual({
      schemaVersion: UNIFIED_ORAMA_BENCHMARK_CONFIG.schemaVersion,
      seed: "0x517a2911",
      dimensions: UNIFIED_ORAMA_BENCHMARK_CONFIG.dimensions,
      chunkSize: UNIFIED_ORAMA_BENCHMARK_CONFIG.chunkSize,
      overlap: UNIFIED_ORAMA_BENCHMARK_CONFIG.overlap,
      scales: [...UNIFIED_ORAMA_BENCHMARK_CONFIG.scales],
      queryCount: UNIFIED_ORAMA_BENCHMARK_CONFIG.queryCount,
      warmupQueries: UNIFIED_ORAMA_BENCHMARK_CONFIG.warmupQueries,
    });
    expect(report.scales.map((result) => result.scale)).toEqual([1_000, 25_000]);
    expect(report.scales.every((result) => result.chunkCount === result.scale)).toBe(true);
    expect(report.unsupported).toEqual([
      "50000 chunks were not captured",
      "100000 chunks were not captured",
    ]);
    expect(Object.keys(report)).not.toContain("generatedAt");
    expect(JSON.stringify(report)).not.toMatch(/hash|commit|content|vector|database|raw|error/i);
  });
});
