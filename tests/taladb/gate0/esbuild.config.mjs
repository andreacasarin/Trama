import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "../../..");
const webPackage = resolve(root, "node_modules/@taladb/web");

export async function buildGate0({ outdir }) {
  const output = resolve(outdir);
  const pluginRoot = resolve(output, "plugin");
  mkdirSync(pluginRoot, { recursive: true });
  const result = await build({
    entryPoints: [resolve(root, "tests/taladb/gate0/browser-entry.mjs")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: resolve(pluginRoot, "main.js"),
    metafile: true,
    sourcemap: false,
    define: { "import.meta.url": "__trama_plugin_url" },
    banner: {
      js: "const __trama_plugin_url = new URL('./main.js', document.currentScript?.src ?? location.href); globalThis.__tramaPluginUrl = __trama_plugin_url;",
    },
    logLevel: "silent",
  });
  const worker = resolve(pluginRoot, "@taladb/web/worker/taladb.worker.js");
  const pkg = resolve(pluginRoot, "@taladb/web/pkg");
  mkdirSync(dirname(worker), { recursive: true });
  mkdirSync(pkg, { recursive: true });
  cpSync(resolve(webPackage, "worker/taladb.worker.js"), worker);
  for (const file of ["taladb_web.js", "taladb_web_bg.wasm"]) {
    cpSync(resolve(webPackage, `pkg/${file}`), resolve(pkg, file));
  }
  return {
    ...result,
    output: pluginRoot,
    assets: [worker, ...["taladb_web.js", "taladb_web_bg.wasm"].map((file) => resolve(pkg, file))],
  };
}
