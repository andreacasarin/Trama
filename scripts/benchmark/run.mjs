import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { benchmarkReportExitCode } from "./status.mjs";

const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  return result.status ?? 1;
};

if (run(process.execPath, ["scripts/sqlite-wasm/build.mjs"]) !== 0) process.exit(1);
if (run(process.execPath, ["scripts/sqlite-wasm/verify.mjs"]) !== 0) process.exit(1);

const vitestStatus = run(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "tests/workloads/evidence.test.ts"],
  {
    ...process.env,
    TRAMA_BENCHMARK: "1",
    TRAMA_BENCHMARK_PROFILE: process.env.TRAMA_BENCHMARK_PROFILE ?? "trama-small",
    TRAMA_BENCHMARK_TIMEOUT_MS: process.env.TRAMA_BENCHMARK_TIMEOUT_MS ?? "300000",
  }
);

const profile = process.env.TRAMA_BENCHMARK_PROFILE ?? "trama-small";
const report = JSON.parse(readFileSync(`.artifacts/trama-benchmark/${profile}.json`, "utf8"));
if (report.status === "timeout") {
  process.stdout.write(
    `\n## Trama benchmark: ${report.profile}\n\nTimed out after ${report.elapsedMs.toFixed(1)} ms (limit ${report.timeoutMs} ms).\n\n`
  );
  process.exit(1);
}
if (benchmarkReportExitCode(report.status) !== 0) {
  const error = report.error;
  const details =
    error && typeof error === "object"
      ? `${error.name ?? "Error"}: ${error.message ?? "Benchmark failed."}`
      : String(error ?? "Benchmark failed.");
  process.stdout.write(`\n## Trama benchmark: ${report.profile}\n\n${details}\n\n`);
  process.exit(1);
}
const milliseconds = (value) => `${value.toFixed(1)} ms`;
const megabytes = (value) =>
  value === "unsupported" ? value : `${(value / 1_000_000).toFixed(2)} MB`;
const bytesMetric = (metric, value) =>
  value === "unsupported"
    ? value
    : metric.toLowerCase().includes("duration")
      ? milliseconds(value)
      : megabytes(value);
const memoryMetric = (metric, value) =>
  metric.toLowerCase().includes("samplecount") ? value : bytesMetric(metric, value);
const rows = [
  ...Object.entries(report.durationMs).map(([metric, value]) => [metric, milliseconds(value)]),
  ...Object.entries(report.latencyMs).flatMap(([metric, value]) => [
    [`${metric} samples`, value.samples ?? 1],
    [`${metric} p50`, milliseconds(value.p50)],
    [`${metric} p95`, milliseconds(value.p95)],
    [`${metric} max`, milliseconds(value.max)],
  ]),
  ...Object.entries(report.rpcLatencyMs ?? {}).flatMap(([metric, value]) => [
    [`RPC ${metric} samples`, value.samples ?? 1],
    [`RPC ${metric} p50`, milliseconds(value.p50)],
    [`RPC ${metric} p95`, milliseconds(value.p95)],
    [`RPC ${metric} max`, milliseconds(value.max)],
  ]),
  ...Object.entries(report.bytes).map(([metric, value]) => [metric, bytesMetric(metric, value)]),
  ...Object.entries(report.memory).map(([metric, value]) => [metric, memoryMetric(metric, value)]),
  ...Object.entries(report.counters).flatMap(([metric, value]) =>
    typeof value === "object" ? [] : [[`counter ${metric}`, value]]
  ),
];
const summary = [
  `## Trama benchmark: ${report.profile}`,
  "",
  `Seed ${report.seed}; ${report.notes} notes; ${report.chunks} chunks.`,
  `Environment ${report.environment.node} ${report.environment.platform}/${report.environment.arch}; timeout ${report.environment.timeoutMs} ms.`,
  "",
  "| Metric | Result |",
  "| --- | ---: |",
  ...rows.map(([metric, value]) => `| ${metric} | ${value} |`),
  "",
].join("\n");
process.stdout.write(`\n${summary}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (vitestStatus !== 0) process.exit(vitestStatus);
