import { stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runCharacterization } from "../scripts/benchmarks/characterization";

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

describe("unified Orama failure and cancellation characterization", () => {
  it("records sanitized phase, durability, and recovery outcomes", async () => {
    const artifact = new URL(
      "../.index-benchmark/candidate-characterization.json",
      import.meta.url
    );
    const before = await artifactState(artifact);
    const report = await runCharacterization();
    const after = await artifactState(artifact);
    expect(report.schemaVersion).toBe(2);
    expect(report.cancellation.durableSnapshotPreserved).toBe(true);
    expect(report.corruption.loadRejected).toBe(true);
    expect(report.fingerprint.mismatchedLoadRejected).toBe(true);
    expect(report.replacement.failedReplacementPreservedSnapshot).toBe(true);
    expect(report.postGc.onlyCompletedSnapshotRemained).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(
      /"(?:content|embedding|vector|hash|commit|id|path|raw|error|database)"/i
    );
    expect(after).toEqual(before);
  });
});
