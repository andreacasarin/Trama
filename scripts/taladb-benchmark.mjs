import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cpSync, mkdirSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generated = resolve(
  process.env.TRAMA_TALADB_GENERATED ?? resolve(root, "benchmarks/taladb/.generated")
);
const dist = resolve(generated, "browser-dist");
const profiles = resolve(generated, "profiles");
const browserExecutable = resolve(
  process.env.TRAMA_TALADB_BROWSER ??
    resolve(
      root,
      "candidate/taladb/.generated/playwright-browsers/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium"
    )
);
const playwrightPackage = resolve(
  process.env.TRAMA_TALADB_PLAYWRIGHT ??
    resolve(root, "candidate/taladb/.generated/browser-tools/package.json")
);
const requirePlaywright = createRequire(pathToFileURL(playwrightPackage));

function assertSafeReport(report) {
  const prohibited = /(?:path|text|query|vector|hash|content|embedding|result|\bid\b)/i;
  if (
    report.schemaVersion !== 1 ||
    typeof report.profile !== "string" ||
    typeof report.runner !== "string"
  )
    throw new Error("Invalid benchmark report identity");
  if (!report.metrics || Array.isArray(report.metrics))
    throw new Error("Invalid benchmark metrics");
  for (const [name, metric] of Object.entries(report.metrics)) {
    if (prohibited.test(name) || !metric || typeof metric !== "object")
      throw new Error(`Unsafe metric: ${name}`);
    if (metric.kind === "measured") {
      if (
        !Number.isFinite(metric.value) ||
        !Number.isSafeInteger(metric.sampleCount) ||
        metric.sampleCount < 1
      )
        throw new Error(`Invalid measured metric: ${name}`);
    } else if (metric.kind === "estimated") {
      if (!Number.isFinite(metric.value) || typeof metric.method !== "string")
        throw new Error(`Invalid estimate: ${name}`);
    } else if (metric.kind === "unsupported") {
      if (typeof metric.reason !== "string" || metric.reason.length === 0)
        throw new Error(`Invalid unsupported metric: ${name}`);
    } else throw new Error(`Unknown metric kind: ${name}`);
  }
}

function measured(value, unit) {
  return { kind: "measured", value, unit, sampleCount: 1 };
}
function unsupported(reason) {
  return { kind: "unsupported", reason };
}

async function buildFixture() {
  const pluginRoot = resolve(dist, "plugin");
  mkdirSync(pluginRoot, { recursive: true });
  await build({
    entryPoints: [resolve(root, "tests/taladb/native-benchmark-entry.mjs")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: resolve(pluginRoot, "main.js"),
    sourcemap: false,
    define: { "import.meta.url": "__trama_benchmark_plugin_url" },
    banner: {
      js: "const __trama_benchmark_plugin_url = new URL('./main.js', document.currentScript?.src ?? location.href);",
    },
    logLevel: "silent",
  });
  const webPackage = resolve(root, "node_modules/@taladb/web");
  const worker = resolve(pluginRoot, "@taladb/web/worker/taladb.worker.js");
  const pkg = resolve(pluginRoot, "@taladb/web/pkg");
  mkdirSync(dirname(worker), { recursive: true });
  mkdirSync(pkg, { recursive: true });
  cpSync(resolve(webPackage, "worker/taladb.worker.js"), worker);
  for (const file of ["taladb_web.js", "taladb_web_bg.wasm"])
    cpSync(resolve(webPackage, `pkg/${file}`), resolve(pkg, file));
}

async function serve() {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end('<!doctype html><meta charset="utf-8"><script src="/plugin/main.js"></script>');
      return;
    }
    const candidate = resolve(dist, `.${pathname}`);
    if (!candidate.startsWith(`${dist}${sep}`)) {
      response.writeHead(400);
      response.end();
      return;
    }
    try {
      const bytes = await readFile(candidate);
      const extension = extname(candidate);
      response.writeHead(200, {
        "content-type": extension === ".wasm" ? "application/wasm" : "text/javascript",
        "cache-control": "no-store",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function metadataReport(result) {
  const metric = {};
  const numeric = [
    ["notes", result.notes, "notes"],
    ["chunks", result.chunks, "chunks"],
    ["buildMs", result.buildMs, "ms"],
    ["semanticMs", result.semanticMs, "ms"],
    ["lexicalMs", result.lexicalMs, "ms"],
    ["hybridMs", result.hybridMs, "ms"],
    ["semanticRecallNonTied", result.semanticRecallNonTied, "ratio"],
    ["semanticMaxScoreError", result.semanticMaxScoreError, "score"],
    ["lexicalHits", result.lexicalHits, "hits"],
    ["hybridHits", result.hybridHits, "hits"],
    ["buildWorkCount", result.buildEmbedTexts, "texts"],
    ["unchangedWorkCount", result.unchangedEmbedTexts, "texts"],
    ["modifiedWorkCount", result.modifiedEmbedTexts, "texts"],
    ["eventLoopDriftMs", result.eventLoopDriftMs, "ms"],
  ];
  for (const [name, value, unit] of numeric)
    metric[name] = Number.isFinite(value)
      ? measured(value, unit)
      : unsupported("browser did not expose a finite value");
  for (const [name, value] of [
    ["addConverged", result.addConverged],
    ["deleteConverged", result.deleteConverged],
    ["renameConverged", result.renameConverged],
    ["persisted", result.persisted],
    ["loaded", result.loaded],
    ["ready", result.ready],
    ["storageOpfs", result.storageOpfs],
    ["durableWrites", result.durableWrites],
    ["hnswSupported", result.hnswSupported],
  ])
    metric[name] = measured(value ? 1 : 0, "boolean");
  metric.storageBytes = Number.isFinite(result.storageBytes)
    ? measured(result.storageBytes, "bytes")
    : unsupported("browser storage estimate unavailable");
  metric.memoryBytes = Number.isFinite(result.memoryBytes)
    ? measured(result.memoryBytes, "bytes")
    : unsupported("browser memory API unavailable");
  const report = {
    schemaVersion: 1,
    profile: result.profile,
    runner: "native-browser-wasm-production-manager",
    metrics: metric,
  };
  assertSafeReport(report);
  return report;
}

async function main() {
  mkdirSync(generated, { recursive: true });
  mkdirSync(profiles, { recursive: true });
  await buildFixture();
  const { chromium } = requirePlaywright("playwright");
  if (!browserExecutable) throw new Error("Repository-contained Chromium executable is required");
  const served = await serve();
  const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
  const all = {};
  try {
    const context = await browser.newContext();
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
    await page.waitForFunction(() => window.__taladbNativeBenchmark, { timeout: 10_000 });
    const orderedProfiles = ["oneK", "representative", "fiftyK", "oneHundredK"];
    const requestedLimit = Number(process.env.TRAMA_TALADB_PROFILE_LIMIT ?? orderedProfiles.length);
    const requestedStart = Number(process.env.TRAMA_TALADB_PROFILE_START ?? 0);
    const start = Number.isSafeInteger(requestedStart) ? Math.max(0, requestedStart) : 0;
    const selectedProfiles = orderedProfiles.slice(
      start,
      start + (Number.isSafeInteger(requestedLimit) ? requestedLimit : orderedProfiles.length)
    );
    for (const profile of selectedProfiles) {
      const result = await page.evaluate(
        async (name) => window.__taladbNativeBenchmark.runProfile(name),
        profile
      );
      all[profile] = metadataReport(result);
      const output = resolve(generated, profile, "report.json");
      mkdirSync(resolve(generated, profile), { recursive: true });
      await writeFile(output, `${JSON.stringify(all[profile], null, 2)}\n`);
      console.log(JSON.stringify({ profile, ...result }));
    }
    await context.close();
    if (errors.length) throw new Error(`native browser page errors: ${errors.join("; ")}`);
    if (!requests.every((url) => url.startsWith(served.origin)))
      throw new Error("browser requested an external asset");
  } finally {
    await browser.close();
    served.server.close();
  }
}

await main();
