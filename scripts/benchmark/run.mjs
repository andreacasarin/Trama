import { spawnSync } from "node:child_process";

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
