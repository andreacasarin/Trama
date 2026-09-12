import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

const production = process.argv[2] === "production";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  platform: "browser",
  target: "es2020",
  conditions: ["browser", "import"],
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production,
  // TalaDB's browser client resolves its worker relative to import.meta.url.
  // Obsidian loads the CommonJS bundle from the plugin directory, so keep that
  // URL rooted at the plugin document and ship the vendor assets beside it.
  // TalaDB's public browser entry constructs its worker from import.meta.url.
  // Obsidian's document base is the vault/app shell, so anchor that URL to the
  // installed plugin's main.js; the copied @taladb/web assets then resolve
  // within the plugin directory in both dev and production artifacts.
  define: { "import.meta.url": "__trama_plugin_url" },
  banner: {
    js: "const __trama_plugin_url = new URL('./main.js', document.baseURI); globalThis.__tramaPluginUrl = __trama_plugin_url;",
  },
  logLevel: "info",
});

const root = resolve(import.meta.dirname, ".");
const webPackage = resolve(root, "node_modules/@taladb/web");
const worker = resolve(root, "@taladb/web/worker/taladb.worker.js");
const pkg = resolve(root, "@taladb/web/pkg");
mkdirSync(dirname(worker), { recursive: true });
mkdirSync(pkg, { recursive: true });
cpSync(resolve(webPackage, "worker/taladb.worker.js"), worker);
for (const file of ["taladb_web.js", "taladb_web_bg.wasm"])
  cpSync(resolve(webPackage, `pkg/${file}`), resolve(pkg, file));
