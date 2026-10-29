import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
// @ts-expect-error The shared corpus fixture is a plain ESM module.
import * as fixture from "../scripts/benchmark/performance-fixture.mjs";
// @ts-expect-error The manual comparator is a plain ESM module.
import { compareReports, median, validateReport } from "../scripts/benchmark/compare.mjs";
// @ts-expect-error The vault preparer is a plain ESM module.
import * as benchmarkVault from "../scripts/benchmark/vault.mjs";

const { benchmarkVaultPath, prepareBenchmarkVault, validateBenchmarkVault } = benchmarkVault;

const settings = {
  embeddingEndpoint: "http://127.0.0.1:1234/v1",
  embeddingModel: "local-embedding-model",
  dimensions: 768,
  query: "D5 lexical sentinel unique phrase",
  excludedFolders: [],
  consoleDebug: true,
  cacheCondition: "warm-after-rebuild",
};

function indexPhase(phase: string, elapsedMs: number) {
  const counts = {
    rebuild: { visited: 3000, deleted: 0, numAdded: 3000, numUpdated: 0, numSkipped: 0 },
    unchanged: { visited: 3000, deleted: 0, numAdded: 0, numUpdated: 0, numSkipped: 3000 },
    delete: { visited: 2999, deleted: 1, numAdded: 0, numUpdated: 0, numSkipped: 2999 },
    restore: { visited: 3000, deleted: 0, numAdded: 1, numUpdated: 0, numSkipped: 2999 },
  }[phase] as Record<string, number>;
  return {
    label: `${phase === "rebuild" ? "Rebuilding" : "Updating"} note index completed`,
    automatic: false,
    rebuild: phase === "rebuild",
    ...counts,
    elapsedMs,
  };
}

function report(times = 10) {
  return {
    schema: "trama-app-benchmark-v1",
    corpusSha256: fixture.CORPUS_SHA256,
    corpusCount: 3000,
    context: {
      appBuild: "build-id",
      runtime: "Obsidian 1.x",
      platform: "darwin",
      machine: "test Mac",
    },
    settings: { ...settings },
    samples: Array.from({ length: 3 }, (_, index) => ({
      rebuild: indexPhase("rebuild", times + index),
      search: {
        label: "Vault search completed",
        mode: "hybrid",
        resultCount: 3,
        degraded: false,
        elapsedMs: times + index,
      },
      unchanged: indexPhase("unchanged", times + index),
      delete: indexPhase("delete", times + index),
      restore: indexPhase("restore", times + index),
    })),
  };
}

describe("current app benchmark", () => {
  it("reproduces the fixed corpus and compares raw samples with medians", () => {
    expect(fixture.createPerformanceCorpus().sha256).toBe(fixture.CORPUS_SHA256);
    const result = compareReports(report(10), report(14));
    expect(result.measurements.rebuild.beforeMs).toEqual([10, 11, 12]);
    expect(result.measurements.rebuild.beforeMedianMs).toBe(11);
    expect(result.measurements.rebuild.afterMedianMs).toBe(15);
    expect(result.measurements.rebuild.medianDeltaMs).toBe(4);
    const updatedBuild = report(14);
    updatedBuild.context.appBuild = "new-build-id";
    expect(() => compareReports(report(10), updatedBuild)).not.toThrow();
    expect(median([1, 4, 2])).toBe(2);
  });

  it("rejects incomplete, mismatched, and invalid manual app evidence", () => {
    expect(() => validateReport({ ...report(), samples: [] })).toThrow("exactly three");
    expect(() => compareReports(report(), report().samples)).toThrow();
    const bad = report();
    bad.samples[0].search.degraded = true;
    expect(() => validateReport(bad)).toThrow("non-degraded");
    const extraField = report();
    (extraField.samples[0].rebuild as Record<string, unknown>).extra = 1;
    expect(() => validateReport(extraField)).toThrow("current app debug output");
    const mismatched = report();
    mismatched.settings = { ...settings, embeddingModel: "another-model" };
    expect(() => compareReports(report(), mismatched)).toThrow("same corpus, settings");
    const reorderedSettings = report(12);
    reorderedSettings.settings = Object.fromEntries(
      Object.entries(settings).reverse()
    ) as typeof settings;
    expect(() => compareReports(report(), reorderedSettings)).not.toThrow();
    const differentRuntime = report();
    differentRuntime.context.runtime = "another Obsidian version";
    expect(() => compareReports(report(), differentRuntime)).toThrow("same corpus, settings");
    const differentQuery = report();
    differentQuery.settings.query = "another query";
    expect(() => validateReport(differentQuery)).toThrow("fixed benchmark settings");
  });

  it("refuses vault paths outside the dedicated generated location", async () => {
    await expect(validateBenchmarkVault("/tmp/personal-vault")).rejects.toThrow(
      "dedicated benchmark path"
    );
  });

  it("refuses extra Markdown anywhere in the marked benchmark vault", async () => {
    await prepareBenchmarkVault();
    const id = randomUUID();
    const extras = [
      path.join(benchmarkVaultPath, `extra-${id}.md`),
      path.join(benchmarkVaultPath, "notes", `extra-${id}.md`),
    ];
    try {
      for (const extra of extras) {
        await writeFile(extra, "keep this file", { flag: "wx" });
        await expect(validateBenchmarkVault()).rejects.toThrow("unexpected or missing Markdown");
        await expect(prepareBenchmarkVault()).rejects.toThrow("unexpected or missing Markdown");
        await expect(readFile(extra, "utf8")).resolves.toBe("keep this file");
        await rm(extra);
      }
      await expect(validateBenchmarkVault()).resolves.toBeUndefined();
    } finally {
      await Promise.all(extras.map((extra) => rm(extra, { force: true })));
    }
  }, 30_000);

  it("refuses a changed vault marker and preserves it for restoration", async () => {
    await prepareBenchmarkVault();
    const marker = path.join(benchmarkVaultPath, ".trama-benchmark-vault");
    const original = await readFile(marker);
    try {
      await writeFile(marker, "{}\n");
      await expect(validateBenchmarkVault()).rejects.toThrow("unmarked or invalid benchmark vault");
      await expect(prepareBenchmarkVault()).rejects.toThrow("unmarked or invalid benchmark vault");
    } finally {
      await writeFile(marker, original);
    }
    await expect(validateBenchmarkVault()).resolves.toBeUndefined();
  });

  it("refuses symlinks without following or removing them", async () => {
    await prepareBenchmarkVault();
    const link = path.join(benchmarkVaultPath, "notes", `link-${randomUUID()}.md`);
    try {
      await symlink("0000.md", link);
      await expect(validateBenchmarkVault()).rejects.toThrow("Refusing a symlink");
      await expect(prepareBenchmarkVault()).rejects.toThrow("Refusing a symlink");
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(link, { force: true });
    }
    await expect(validateBenchmarkVault()).resolves.toBeUndefined();
  });

  it("refuses to overwrite an edited generated note and restores the test fixture", async () => {
    await prepareBenchmarkVault();
    const note = path.join(benchmarkVaultPath, "notes", "2999.md");
    const original = await readFile(note);
    try {
      await writeFile(note, "edited benchmark note\n");
      await expect(prepareBenchmarkVault()).rejects.toThrow("overwrite an edited benchmark note");
      await expect(readFile(note, "utf8")).resolves.toBe("edited benchmark note\n");
    } finally {
      await writeFile(note, original);
    }
    await expect(readFile(note)).resolves.toEqual(original);
    await expect(validateBenchmarkVault()).resolves.toBeUndefined();
  });

  it("restores a missing generated note with its pinned corpus content", async () => {
    await prepareBenchmarkVault();
    const note = path.join(benchmarkVaultPath, "notes", "2999.md");
    const original = await readFile(note);
    try {
      await rm(note);
      await expect(validateBenchmarkVault()).rejects.toThrow("unexpected or missing Markdown");
      await prepareBenchmarkVault();
      await expect(readFile(note, "utf8")).resolves.toBe(
        fixture.createPerformanceCorpus().notes[2999].content
      );
    } finally {
      await writeFile(note, original);
    }
    await expect(validateBenchmarkVault()).resolves.toBeUndefined();
  });
});
