import { readFile, writeFile } from "node:fs/promises";
import type { SanitizedBenchmarkReport, SanitizedBenchmarkScaleResult } from "./benchmarkSchema";

function indexByScale(
  report: SanitizedBenchmarkReport
): Map<number, SanitizedBenchmarkScaleResult> {
  return new Map(report.scales.map((result) => [result.scale, result]));
}

/** Aggregates only public, sanitized measurements; no digests or hashes. */
export function aggregateReports(
  baseline: SanitizedBenchmarkReport,
  candidate: SanitizedBenchmarkReport
): Record<string, unknown> {
  const left = indexByScale(baseline);
  const right = indexByScale(candidate);
  const scales = [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a - b);
  return {
    schemaVersion: 1,
    harness: "unified-orama",
    baselineBackend: baseline.backend,
    candidateBackend: candidate.backend,
    scales: scales.map((scale) => {
      const before = left.get(scale);
      const after = right.get(scale);
      return {
        scale,
        baseline: before
          ? {
              buildMs: before.buildMs,
              restartMs: before.restartMs,
              search: before.search,
              eventLoop: before.eventLoop,
              storageBytes: before.storageBytes,
              memory: before.memory,
            }
          : { unsupported: "baseline missing" },
        candidate: after
          ? {
              buildMs: after.buildMs,
              restartMs: after.restartMs,
              search: after.search,
              eventLoop: after.eventLoop,
              storageBytes: after.storageBytes,
              memory: after.memory,
            }
          : { unsupported: "candidate missing" },
      };
    }),
    unsupported: [...new Set([...baseline.unsupported, ...candidate.unsupported])],
  };
}

export async function aggregateReportFiles(
  baselinePath: string,
  candidatePath: string,
  outputPath: string
): Promise<void> {
  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as SanitizedBenchmarkReport;
  const candidate = JSON.parse(await readFile(candidatePath, "utf8")) as SanitizedBenchmarkReport;
  await writeFile(
    outputPath,
    `${JSON.stringify(aggregateReports(baseline, candidate), null, 2)}\n`,
    "utf8"
  );
}
