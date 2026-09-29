import esbuild from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const production = process.argv[2] === "production";
const runtimeBuildId = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), ".cache/runtime-build.json"), "utf8")
).buildId;

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  platform: "browser",
  target: "es2020",
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
  define: { __TRAMA_RUNTIME_BUILD_ID__: JSON.stringify(runtimeBuildId) },
});

await esbuild.build({
  entryPoints: ["src/index/sqlite/worker.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  outfile: "sqlite-worker.mjs",
  sourcemap: false,
  minify: production,
  logLevel: "info",
  define: { __TRAMA_RUNTIME_BUILD_ID__: JSON.stringify(runtimeBuildId) },
});

const root = dirname(fileURLToPath(import.meta.url));
for (const source of [join(root, "sqlite3.mjs"), join(root, "sqlite3.wasm")]) {
  if (!existsSync(source)) throw new Error(`Missing materialized SQLite asset: ${source}`);
}
