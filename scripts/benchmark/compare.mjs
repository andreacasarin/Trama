import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { CORPUS_COUNT, CORPUS_SHA256 } from "./performance-fixture.mjs";

const phases = ["rebuild", "search", "unchanged", "delete", "restore"];
const settingFields = [
  "embeddingEndpoint",
  "embeddingModel",
  "dimensions",
  "query",
  "excludedFolders",
  "consoleDebug",
  "cacheCondition",
];
const expectedCounts = {
  rebuild: { visited: 3000, deleted: 0, numAdded: 3000, numUpdated: 0, numSkipped: 0 },
  unchanged: { visited: 3000, deleted: 0, numAdded: 0, numUpdated: 0, numSkipped: 3000 },
  delete: { visited: 2999, deleted: 1, numAdded: 0, numUpdated: 0, numSkipped: 2999 },
  restore: { visited: 3000, deleted: 0, numAdded: 1, numUpdated: 0, numSkipped: 2999 },
};

export function median(values) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error("Expected non-empty non-negative timing samples");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function validateReport(report) {
  if (report.schema !== "trama-app-benchmark-v1") throw new Error("Unsupported report schema");
  if (report.corpusSha256 !== CORPUS_SHA256 || report.corpusCount !== CORPUS_COUNT)
    throw new Error("Benchmark corpus does not match the pinned 3000-note corpus");
  if (
    !report.context ||
    !report.settings ||
    !Array.isArray(report.samples) ||
    report.samples.length !== 3
  )
    throw new Error("Report must include context, settings, and exactly three samples");
  for (const field of ["appBuild", "runtime", "platform", "machine"])
    if (typeof report.context[field] !== "string" || !report.context[field])
      throw new Error(`Report is missing context.${field}`);
  const { settings } = report;
  if (Object.keys(settings).sort().join(",") !== [...settingFields].sort().join(","))
    throw new Error("Report settings do not match the fixed benchmark settings");
  if (
    typeof settings.embeddingEndpoint !== "string" ||
    !settings.embeddingEndpoint ||
    typeof settings.embeddingModel !== "string" ||
    !settings.embeddingModel ||
    !Number.isSafeInteger(settings.dimensions) ||
    settings.dimensions < 1 ||
    settings.query !== "D5 lexical sentinel unique phrase" ||
    JSON.stringify(settings.excludedFolders) !== "[]" ||
    settings.consoleDebug !== true ||
    settings.cacheCondition !== "warm-after-rebuild"
  )
    throw new Error("Report settings do not match the fixed benchmark settings");

  for (const [index, sample] of report.samples.entries()) {
    if (!sample || Object.keys(sample).sort().join(",") !== [...phases].sort().join(","))
      throw new Error(`Sample ${index + 1} must contain exactly the five benchmark phases`);
    for (const phase of phases) validatePhase(sample[phase], phase, index + 1);
  }
  return report;
}

function validatePhase(result, phase, sampleNumber) {
  if (!result || !Number.isInteger(result.elapsedMs) || result.elapsedMs < 0)
    throw new Error(`Sample ${sampleNumber} ${phase} is missing integer elapsedMs`);
  if (phase === "search") {
    requireFields(result, ["label", "mode", "resultCount", "degraded", "elapsedMs"]);
    if (
      result.label !== "Vault search completed" ||
      result.mode !== "hybrid" ||
      !Number.isInteger(result.resultCount) ||
      result.resultCount < 1 ||
      result.degraded !== false
    )
      throw new Error(`Sample ${sampleNumber} search must be successful, hybrid, and non-degraded`);
    return;
  }
  const expectedLabel = `${phase === "rebuild" ? "Rebuilding" : "Updating"} note index completed`;
  requireFields(result, [
    "label",
    "automatic",
    "rebuild",
    "visited",
    "deleted",
    "numAdded",
    "numUpdated",
    "numSkipped",
    "elapsedMs",
  ]);
  if (result.label !== expectedLabel || result.automatic !== false)
    throw new Error(`Sample ${sampleNumber} ${phase} must be manual and complete`);
  for (const field of ["visited", "deleted", "numAdded", "numUpdated", "numSkipped"])
    if (!Number.isInteger(result[field]) || result[field] < 0)
      throw new Error(`Sample ${sampleNumber} ${phase} is missing integer ${field}`);
  if (result.rebuild !== (phase === "rebuild"))
    throw new Error(`Sample ${sampleNumber} ${phase} has an unexpected rebuild flag`);
  for (const [field, expected] of Object.entries(expectedCounts[phase]))
    if (result[field] !== expected)
      throw new Error(`Sample ${sampleNumber} ${phase} expected ${field}=${expected}`);
}

function requireFields(value, fields) {
  if (Object.keys(value).sort().join(",") !== [...fields].sort().join(","))
    throw new Error("Benchmark phase fields do not match current app debug output");
}

export function compareReports(before, after) {
  validateReport(before);
  validateReport(after);
  if (
    JSON.stringify(before.corpusSha256) !== JSON.stringify(after.corpusSha256) ||
    settingFields.some(
      (field) => JSON.stringify(before.settings[field]) !== JSON.stringify(after.settings[field])
    ) ||
    ["runtime", "platform", "machine"].some(
      (field) => before.context[field] !== after.context[field]
    )
  )
    throw new Error("Reports must use the same corpus, settings, runtime, platform, and machine");
  const measurements = Object.fromEntries(
    phases.map((phase) => {
      const beforeMs = before.samples.map((sample) => sample[phase].elapsedMs);
      const afterMs = after.samples.map((sample) => sample[phase].elapsedMs);
      const beforeMedianMs = median(beforeMs);
      const afterMedianMs = median(afterMs);
      return [
        phase,
        {
          beforeMs,
          afterMs,
          beforeMedianMs,
          afterMedianMs,
          medianDeltaMs: afterMedianMs - beforeMedianMs,
        },
      ];
    })
  );
  return { measurements };
}

async function main() {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath || process.argv.length !== 4)
    throw new Error("Usage: npm run benchmark:compare -- <before.json> <after.json>");
  const [before, after] = await Promise.all(
    [beforePath, afterPath].map(async (file) => JSON.parse(await readFile(file, "utf8")))
  );
  process.stdout.write(`${JSON.stringify(compareReports(before, after), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
