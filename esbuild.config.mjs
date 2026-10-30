import esbuild from "esbuild";
import { generateNotices } from "./scripts/generate-notices.mjs";
import { appendFileSync, readFileSync } from "node:fs";

const production = process.argv[2] === "production";
const runtimeBuildId = JSON.parse(readFileSync(".cache/runtime-build.json", "utf8")).buildId;
const common = {
  bundle: true,
  platform: "browser",
  target: "es2020",
  minify: production,
  logLevel: "info",
  metafile: true,
  banner: { js: `/* runtime-build:${runtimeBuildId} */` },
};

// Keep runtime sources separate; only the build embeds the worker and its WASM.
const worker = await esbuild.build({
  ...common,
  entryPoints: ["src/index/note-sqlite/worker.ts"],
  format: "esm",
  outfile: ".cache/sqlite.worker.js",
  loader: { ".wasm": "binary" },
});
const main = await esbuild.build({
  ...common,
  entryPoints: ["src/main.ts"],
  external: ["obsidian"],
  format: "cjs",
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  loader: { ".worker.js": "text" },
});
const notices = await generateNotices([
  ...Object.keys(main.metafile.inputs),
  ...Object.keys(worker.metafile.inputs),
]);
// Community installation downloads main.js but does not install notice sidecars.
const licenses = `${readFileSync("LICENSE", "utf8")}\n${notices}`;
appendFileSync("main.js", `\n${licenses.replace(/^/gm, "// ")}\n`);
