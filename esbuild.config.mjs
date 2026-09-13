import esbuild from "esbuild";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getBuildContext, resolveMaterializedAssets } from "./scripts/sqlite-wasm/build.mjs";

const production = process.argv[2] === "production";

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
});

const root = dirname(fileURLToPath(import.meta.url));
const materialized = resolveMaterializedAssets(getBuildContext({ rootDir: root }));
for (const source of [materialized.modulePath, materialized.wasmPath]) {
  if (!existsSync(source)) throw new Error(`Missing materialized SQLite asset: ${source}`);
}
