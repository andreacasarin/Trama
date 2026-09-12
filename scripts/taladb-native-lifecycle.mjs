import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cpSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generated = resolve(
  process.env.TRAMA_TALADB_GENERATED ?? resolve(root, "benchmarks/taladb/.generated")
);
const dist = resolve(generated, "native-lifecycle-dist");
const browser = resolve(
  process.env.TRAMA_TALADB_BROWSER ??
    resolve(
      root,
      "candidate/taladb/.generated/playwright-browsers/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium"
    )
);
const playwright = createRequire(
  pathToFileURL(resolve(root, "candidate/taladb/.generated/browser-tools/package.json"))
)("playwright");

async function buildFixture() {
  const plugin = resolve(dist, "plugin");
  const web = resolve(root, "node_modules/@taladb/web");
  mkdirSync(resolve(plugin, "@taladb/web/pkg"), { recursive: true });
  mkdirSync(resolve(plugin, "@taladb/web/worker"), { recursive: true });
  await build({
    entryPoints: [resolve(root, "tests/taladb/native-lifecycle-entry.mjs")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: resolve(plugin, "main.js"),
    define: { "import.meta.url": "__trama_native_lifecycle_url" },
    banner: {
      js: "const __trama_native_lifecycle_url = new URL('./main.js', document.currentScript?.src ?? location.href);",
    },
    logLevel: "silent",
  });
  cpSync(
    resolve(web, "worker/taladb.worker.js"),
    resolve(plugin, "@taladb/web/worker/taladb.worker.js")
  );
  for (const name of ["taladb_web.js", "taladb_web_bg.wasm"])
    cpSync(resolve(web, `pkg/${name}`), resolve(plugin, `@taladb/web/pkg/${name}`));
}

async function serve() {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<script src="/plugin/main.js"></script>');
      return;
    }
    const file = resolve(dist, `.${pathname}`);
    if (!file.startsWith(`${dist}${sep}`)) {
      response.writeHead(400);
      response.end();
      return;
    }
    try {
      const bytes = await readFile(file);
      response.writeHead(200, {
        "content-type": extname(file) === ".wasm" ? "application/wasm" : "text/javascript",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

await buildFixture();
const served = await serve();
const instance = await playwright.chromium.launch({ executablePath: browser, headless: true });
try {
  const context = await instance.newContext();
  const requests = [];
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    requests.push(url);
    if (!url.startsWith(served.origin)) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error?.message ?? error)));
  await page.goto(`${served.origin}/index.html`);
  await page.waitForFunction(() => window.__taladbNativeLifecycle, { timeout: 10_000 });
  const result = await page.evaluate(() => window.__taladbNativeLifecycle.run());
  await context.close();
  if (errors.length) throw new Error(`native lifecycle page errors: ${errors.join("; ")}`);
  if (!requests.every((url) => url.startsWith(served.origin)))
    throw new Error("native lifecycle requested an external asset");
  console.log(JSON.stringify({ ...result, localAssets: true, requestCount: requests.length }));
  if (
    !result.safeDatabaseName ||
    !result.namespaceIsolation ||
    !result.loaded ||
    !result.dirtyPartialSearch ||
    !result.converged ||
    !result.persisted
  )
    process.exitCode = 1;
} finally {
  await instance.close();
  served.server.close();
}
