import { describe, expect, it, vi } from "vitest";
import {
  benchmarkCorrectnessFailure,
  benchmarkFailureStatus,
  sanitizeBenchmarkError,
} from "./benchmark-lifecycle";
import { createBenchmarkMemorySampler } from "./instrumentation";
import { benchmarkRssWindow, latency } from "./trama-benchmark";

// @ts-expect-error The benchmark runner is an untyped JavaScript module.
import { benchmarkReportExitCode } from "../../scripts/benchmark/status.mjs";

describe("benchmark lifecycle evidence", () => {
  it("keeps completed reports successful", () => {
    expect(benchmarkReportExitCode("completed")).toBe(0);
  });

  it("marks completed and incomplete RSS windows without implying publication", () => {
    expect(benchmarkRssWindow(true)).toEqual({
      start: "before-full-build-call",
      end: "after-successful-publish",
      excludes: [
        "fixture-generation",
        "manager-construction",
        "adoption",
        "retrieval-queries",
        "chat-tool-turn",
      ],
    });
    expect(benchmarkRssWindow(false)).toEqual({
      start: "before-full-build-call",
      excludes: [
        "fixture-generation",
        "manager-construction",
        "adoption",
        "retrieval-queries",
        "chat-tool-turn",
      ],
    });
  });

  it("classifies explicit aborts as timeout failures", () => {
    expect(benchmarkFailureStatus({ name: "AbortError", message: "aborted" })).toBe("timeout");
    expect(benchmarkReportExitCode("timeout")).toBe(1);
  });

  it("keeps late ordinary errors as errors", () => {
    const error = new Error("late benchmark failure");
    expect(benchmarkFailureStatus(error)).toBe("error");
    expect(benchmarkReportExitCode("error")).toBe(1);
    expect(sanitizeBenchmarkError(error, ["note content that must not persist"])).toEqual({
      name: "Error",
      message: "late benchmark failure",
    });
  });

  it("writes correctness assertion failures as non-completing evidence", () => {
    const assertionFailure = new Error("Expected finalCountsMatch to be true");
    const report = {
      status: benchmarkFailureStatus(assertionFailure),
      error: sanitizeBenchmarkError(assertionFailure),
    };
    expect(report).toEqual({
      status: "error",
      error: { name: "Error", message: "Expected finalCountsMatch to be true" },
    });
    expect(benchmarkReportExitCode(report.status)).toBe(1);
  });

  it("gates every correctness key and emits an error for each failed key", () => {
    const keys = [
      "fixtureChunkCount",
      "initialCountsMatch",
      "semanticUncachedConverged",
      "semanticCachedNoProviderWork",
      "semanticPartialConverged",
      "semanticScoresFinite",
      "semanticResultsPresent",
      "finalCountsMatch",
      "allMutationsConverged",
      "publicationPublished",
      "publicationAdopted",
      "publishedOutputMatchesAdopted",
      "outputOracleMatches",
      "occurrenceContentMatches",
      "mutationArithmeticMatches",
      "publishedSemanticMatchesAdopted",
      "sourceDigestPinned",
      "providerIdentityMatches",
      "queryVectorIdentityMatches",
    ];
    for (const failedKey of keys) {
      const correctness = Object.fromEntries(keys.map((key) => [key, key !== failedKey]));
      const error = benchmarkCorrectnessFailure(correctness);
      expect(error?.message).toContain(failedKey);
      expect(benchmarkFailureStatus(error)).toBe("error");
      expect(benchmarkReportExitCode("error")).toBe(1);
    }
  });

  it("tracks an observed memory maximum and stops sampling", () => {
    vi.useFakeTimers();
    const readings = [10, 20, 15, 5];
    const sampler = createBenchmarkMemorySampler({
      intervalMs: 10,
      readRss: () => readings.shift() ?? 15,
    });
    expect(sampler.peak).toBe(10);
    vi.advanceTimersByTime(10);
    expect(sampler.peak).toBe(20);
    expect(sampler.reset()).toBe(15);
    expect(sampler.peak).toBe(15);
    expect(sampler.sampleCount).toBe(1);
    vi.advanceTimersByTime(10);
    const samples = sampler.sampleCount;
    sampler.stop();
    expect(sampler.sampleCount).toBe(samples + 1);
    vi.advanceTimersByTime(30);
    expect(sampler.sampleCount).toBe(samples + 1);
    vi.useRealTimers();
  });

  it("records one sample explicitly for single sample latency", async () => {
    const result = await latency(async () => undefined, 1);
    expect(result.samples).toBe(1);
  });
});
