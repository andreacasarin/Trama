import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const required = [
  "main.js",
  "manifest.json",
  "styles.css",
  "@taladb/web/worker/taladb.worker.js",
  "@taladb/web/pkg/taladb_web.js",
  "@taladb/web/pkg/taladb_web_bg.wasm",
];

for (const file of required) await access(resolve(root, file));
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
if (manifest.id !== "trama") throw new Error("Artifact manifest id must be trama");

const main = await readFile(resolve(root, "main.js"), "utf8");
// The browser bundle must not retain package imports, private paths, or an ANN
// selector. (Tala's bundled public implementation contains documentation URLs
// and capability names; those are not runtime network imports or selectors.)
for (const pattern of [/from\s*["'](?:@taladb\/node|@taladb\/web)["']/, /(?:^|["'`])candidate\//]) {
  if (pattern.test(main)) throw new Error(`Forbidden production artifact content: ${pattern}`);
}
if (!main.includes("@taladb/web/worker/taladb.worker.js"))
  throw new Error("Production bundle does not reference the local Tala worker");
if (!main.includes("__tramaPluginUrl") || !main.includes("new URL('./main.js', document.baseURI)"))
  throw new Error("Production bundle does not retain the plugin-relative Tala asset anchor");

process.stdout.write(`Verified ${required.length} local Trama artifact files\n`);
