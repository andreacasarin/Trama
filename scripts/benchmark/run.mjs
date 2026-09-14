import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(process.execPath, ["scripts/sqlite-wasm/build.mjs"]);
run(process.execPath, ["scripts/sqlite-wasm/verify.mjs"]);

run(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "tests/workloads/evidence.test.ts"],
  {
    ...process.env,
    TRAMA_BENCHMARK: "1",
  }
);

const report = JSON.parse(readFileSync(".artifacts/trama-benchmark/trama-10k.json", "utf8"));
const milliseconds = (value) => `${value.toFixed(1)} ms`;
const megabytes = (value) =>
  value === "unsupported" ? value : `${(value / 1_000_000).toFixed(2)} MB`;
const rows = [
  ...Object.entries(report.durationMs).map(([metric, value]) => [metric, milliseconds(value)]),
  ...Object.entries(report.latencyMs).flatMap(([metric, value]) => [
    [`${metric} p50`, milliseconds(value.p50)],
    [`${metric} p95`, milliseconds(value.p95)],
  ]),
  ...Object.entries(report.bytes).map(([metric, value]) => [metric, megabytes(value)]),
];
const summary = [
  `## Trama benchmark: ${report.profile}`,
  "",
  `Seed ${report.seed}; ${report.notes} notes; ${report.chunks} chunks.`,
  "",
  "| Metric | Result |",
  "| --- | ---: |",
  ...rows.map(([metric, value]) => `| ${metric} | ${value} |`),
  "",
].join("\n");
process.stdout.write(`\n${summary}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
