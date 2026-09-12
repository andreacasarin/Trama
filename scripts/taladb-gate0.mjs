import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { buildGate0 } from "../tests/taladb/gate0/esbuild.config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generated = resolve(root, "candidate/taladb/.generated");
const evidence = resolve(generated, "gate0");
const dist = resolve(generated, "browser-dist");
const npmCache = resolve(generated, "npm-cache");
const tarballs = resolve(generated, "tarballs");
const packageVersions = { taladb: "0.11.3", "@taladb/web": "0.11.3" };
const browserExecutable = resolve(
  generated,
  "playwright-browsers/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium"
);
const requirePlaywright = createRequire(
  pathToFileURL(resolve(generated, "browser-tools/package.json"))
);

mkdirSync(evidence, { recursive: true });
const checks = [];
const record = (id, status, details = {}) => checks.push({ id, status, ...details });
const pass = (id, details) => record(id, "PASS", details);
const fail = (id, details) => record(id, "FAIL", details);

async function sha512Integrity(file) {
  const bytes = await readFile(file);
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

async function packageInventory() {
  const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
  const rootPackage = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const lockEntries = lock.packages ?? {};
  const inventory = { versions: packageVersions, packages: {} };
  for (const [name, version] of Object.entries(packageVersions)) {
    const packagePath = resolve(root, "node_modules", name);
    const packageJson = JSON.parse(await readFile(resolve(packagePath, "package.json"), "utf8"));
    const lockEntry = lockEntries[`node_modules/${name}`];
    const tarball = resolve(
      tarballs,
      name === "taladb" ? "taladb-0.11.3.tgz" : "taladb-web-0.11.3.tgz"
    );
    const integrity = await sha512Integrity(tarball);
    const packageFiles = [];
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else
          packageFiles.push({ path: relative(packagePath, path), bytes: (await stat(path)).size });
      }
    }
    await walk(packagePath);
    inventory.packages[name] = {
      version: packageJson.version,
      lockVersion: lockEntry?.version,
      lockIntegrity: lockEntry?.integrity,
      tarballIntegrity: integrity,
      license: packageJson.license,
      exports: packageJson.exports,
      types: packageJson.types,
      files: packageFiles.sort((a, b) => a.path.localeCompare(b.path)),
      dependencies: packageJson.dependencies ?? {},
    };
  }
  const exact = Object.entries(packageVersions).every(
    ([name, version]) =>
      rootPackage.dependencies?.[name] === version &&
      inventory.packages[name].version === version &&
      inventory.packages[name].lockVersion === version &&
      inventory.packages[name].lockIntegrity === inventory.packages[name].tarballIntegrity
  );
  if (exact) pass("package-resolution-integrity", { versions: packageVersions });
  else fail("package-resolution-integrity", { versions: packageVersions });
  const taladb = inventory.packages.taladb;
  const web = inventory.packages["@taladb/web"];
  const publicApi = [
    "openDB",
    "findNearest",
    "searchText",
    "hybridSearch",
    "createVectorIndex",
    "close",
  ];
  const taladbTypes = await readFile(resolve(root, "node_modules/taladb/dist/index.d.ts"), "utf8");
  const publicApiPresent = [
    "openDB",
    "findNearest",
    "searchText",
    "hybridSearch",
    "createVectorIndex",
  ].every((term) => taladbTypes.includes(term));
  if (publicApiPresent && taladb.license && web.license)
    pass("public-exports-types-licenses", { publicApi, licenses: [taladb.license, web.license] });
  else
    fail("public-exports-types-licenses", { publicApi, licenses: [taladb.license, web.license] });
  const assets = web.files.filter(({ path }) =>
    /worker\/taladb\.worker\.js$|pkg\/taladb_web\.js$|pkg\/taladb_web_bg\.wasm$/.test(path)
  );
  if (assets.length === 3) pass("worker-wasm-glue-assets", { assets });
  else fail("worker-wasm-glue-assets", { assets });
  return inventory;
}

async function serve(directory) {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      // Load the fixture exactly as an installed plugin: main.js and all
      // copied Tala assets live below one plugin directory.
      response.end('<!doctype html><meta charset="utf-8"><script src="/plugin/main.js"></script>');
      return;
    }
    const candidate = resolve(directory, `.${pathname}`);
    if (!candidate.startsWith(`${directory}${sep}`)) {
      response.writeHead(400);
      response.end();
      return;
    }
    try {
      const bytes = await readFile(candidate);
      const type =
        extname(candidate) === ".js"
          ? "text/javascript"
          : extname(candidate) === ".wasm"
            ? "application/wasm"
            : "text/html";
      response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function browserRun({ chromium, origin, mode, args = [] }) {
  const browser = await chromium.launch({
    executablePath: browserExecutable,
    headless: true,
    args,
  });
  const profile = resolve(generated, `profiles/${mode}`);
  mkdirSync(profile, { recursive: true });
  const context = await browser.newContext({ acceptDownloads: false });
  const requests = [];
  const forbiddenApiCalls = [];
  const forcedWorker =
    mode === "indexeddb"
      ? `${await readFile(resolve(root, "node_modules/@taladb/web/worker/taladb.worker.js"), "utf8")}\nObject.defineProperty(navigator, 'storage', { value: {} });\n`
      : null;
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    requests.push(url);
    if (!url.startsWith(origin)) return route.abort();
    if (forcedWorker && url.endsWith("/@taladb/web/worker/taladb.worker.js")) {
      return route.fulfill({ status: 200, contentType: "text/javascript", body: forcedWorker });
    }
    return route.continue();
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error?.message ?? error)));
  await page.addInitScript(() => {
    const forbidden =
      (name) =>
      (...args) => {
        window.__forbiddenApiCalls.push(name);
        throw new Error(`${name} disabled by Gate 0`);
      };
    window.__forbiddenApiCalls = [];
    window.WebSocket = forbidden("WebSocket");
    window.EventSource = forbidden("EventSource");
    const OriginalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = class extends OriginalXHR {
      open(...args) {
        window.__forbiddenApiCalls.push("XMLHttpRequest");
        return super.open(...args);
      }
    };
  });
  await page.goto(`${origin}/index.html`);
  try {
    await page.waitForFunction(() => window.__taladbGate0, { timeout: 5000 });
  } catch {
    await context.close();
    await browser.close();
    return {
      mode,
      result: { error: pageErrors.join("; ") || "fixture did not initialize" },
      requests,
      forbiddenApiCalls,
      profile,
    };
  }
  const evaluate = (expression) => page.evaluate(expression);
  let result;
  try {
    result = await evaluate(
      async (selectedMode) => window.__taladbGate0.runtime(selectedMode),
      mode
    );
  } catch (error) {
    result = { error: String(error?.message ?? error) };
  }
  let snapshot;
  try {
    snapshot = await evaluate(async () => window.__taladbGate0.snapshot());
  } catch (error) {
    snapshot = { error: String(error?.message ?? error) };
  }
  let contender;
  try {
    contender = await evaluate(async () => window.__taladbGate0.contender());
  } catch (error) {
    contender = { error: String(error?.message ?? error) };
  }
  forbiddenApiCalls.push(...(await page.evaluate(() => window.__forbiddenApiCalls)));
  await context.close();
  await browser.close();
  return { mode, result, snapshot, contender, requests, forbiddenApiCalls, pageErrors, profile };
}

function evaluateBrowser(result, expectedStorage) {
  if (result.result?.error) {
    fail(`browser-${result.mode}-runtime`, { error: result.result.error });
    return;
  }
  const runtime = result.result;
  const expected = {
    storage: runtime.storage === expectedStorage,
    durableWrites: runtime.durableWrites === true,
    hnswDisabled: runtime.hnsw === false,
    crud:
      runtime.crud?.bulkCount === 4 &&
      runtime.crud.found &&
      runtime.crud.updated &&
      runtime.crud.deleted,
    vectorOracle: runtime.vectorOracleExactOrder === true,
    prefilter: runtime.prefilterBeforeTopK === true,
    fts: runtime.textPass === true,
    hybrid: runtime.hybridPass === true,
    filters: Object.values(runtime.filters ?? {}).every(Boolean),
    indexes:
      runtime.indexes?.btree?.includes("locale") &&
      runtime.indexes?.fts?.includes("body") &&
      runtime.indexes?.vector?.includes("embedding"),
    closeReopen: runtime.beforeClose && runtime.afterReopen,
    closeObservation: runtime.closeSecondCall === "rejected",
    localNetwork:
      result.requests.every((url) => url.startsWith(result.origin)) &&
      result.forbiddenApiCalls.length === 0,
    productionAssetResolver: runtime.pluginResource === `${result.origin}/plugin/main.js`,
  };
  for (const [name, ok] of Object.entries(expected))
    (ok ? pass : fail)(`browser-${result.mode}-${name}`, ok ? {} : { runtime });
  const snapshot = result.snapshot;
  if (!snapshot.error && snapshot.restored && snapshot.corruptRejected)
    pass(`browser-${result.mode}-snapshot-import-corruption`, { bytes: snapshot.bytes });
  else fail(`browser-${result.mode}-snapshot-import-corruption`, { snapshot });
  if (
    !result.contender.error &&
    result.contender.firstOwner === true &&
    result.contender.secondOwner === false
  )
    pass(`browser-${result.mode}-writer-contender`);
  else fail(`browser-${result.mode}-writer-contender`, { contender: result.contender });
}

async function main() {
  const inventory = await packageInventory();
  const built = await buildGate0({ outdir: dist });
  const builtAssets = [];
  for (const file of built.assets)
    builtAssets.push({ path: relative(root, file), bytes: (await stat(file)).size });
  const manifest = {
    selected: packageVersions,
    build: {
      metafileInputs: Object.keys(built.metafile?.inputs ?? {}).length,
      assets: builtAssets,
    },
    checks: ["local-worker", "local-wasm", "local-glue", "commonjs-compatible-root-main"],
  };
  await writeFile(resolve(evidence, "build-manifest.json"), JSON.stringify(manifest, null, 2));
  pass("local-bundle-assets-metafile", {
    inputCount: manifest.build.metafileInputs,
    assets: manifest.build.assets,
  });
  const { chromium } = requirePlaywright("playwright");
  if (!existsSync(browserExecutable)) {
    fail("supported-browser-runtime", {
      blocker: "Repository-contained Chromium executable is missing.",
    });
  } else {
    const served = await serve(dist);
    try {
      const opfs = await browserRun({ chromium, origin: served.origin, mode: "opfs" });
      opfs.origin = served.origin;
      evaluateBrowser(opfs, "opfs");
      const idb = await browserRun({
        chromium,
        origin: served.origin,
        mode: "indexeddb",
        args: ["--disable-features=FileSystemAccessAPI"],
      });
      idb.origin = served.origin;
      evaluateBrowser(idb, "indexeddb");
    } finally {
      served.server.close();
    }
  }
  const result = {
    selected: packageVersions,
    checks,
    inventory: { packageNames: Object.keys(inventory.packages) },
  };
  await writeFile(resolve(evidence, "result.json"), JSON.stringify(result, null, 2));
  const failed = checks.filter((check) => check.status === "FAIL");
  const status = failed.length ? "FAIL" : "PASS_WITH_APPROVED_EXCEPTIONS";
  console.log(
    JSON.stringify(
      {
        selected: packageVersions,
        status,
        firstBlocker: failed[0] ?? null,
        checkCount: checks.length,
        evidence: relative(root, evidence),
      },
      null,
      2
    )
  );
  if (failed.length) process.exitCode = 1;
}

await main();
