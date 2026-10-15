/* global Buffer, URL, setTimeout, clearTimeout, fetch, WebSocket */
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const browser = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const outputDir = join(root, ".ai/bench/sqlite-embedding-cache/opfs-20261014");
const outputArgument = process.argv.indexOf("--output");
const outputPath =
  outputArgument >= 0
    ? resolve(process.argv[outputArgument + 1])
    : join(outputDir, "production-worker-opfs.json");
const scratch = mkdtempSync(`/private/tmp/trama-d11-opfs-${randomUUID()}-`);
const profileDir = join(scratch, "profile-" + randomUUID());
const site = join(scratch, "site");
mkdirSync(site, { recursive: true });
mkdirSync(join(profileDir, "crashes"), { recursive: true });
mkdirSync(outputDir, { recursive: true });

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (path) => readFileSync(path);
const fixtureProfile = digest(Buffer.from("opfs-proof-profile"));
function createInvalidFixture(path, hash, vector) {
  const blob = Buffer.from(vector).toString("hex");
  const sql = `PRAGMA journal_mode=DELETE;
PRAGMA application_id=1414679873;
PRAGMA user_version=1;
CREATE TABLE metadata(profile TEXT NOT NULL,dimensions INTEGER NOT NULL,task TEXT NOT NULL);
CREATE TABLE vectors(hash TEXT NOT NULL UNIQUE,vector BLOB NOT NULL);
CREATE TABLE _sqliteai_vector(tblname TEXT,colname TEXT,key TEXT,value ANY,PRIMARY KEY(tblname,colname,key));
INSERT INTO metadata VALUES('${fixtureProfile}',8,'document');
INSERT INTO vectors VALUES('${hash}',X'${blob}');
VACUUM;`;
  const created = spawnSync("/usr/bin/sqlite3", [path], {
    input: sql,
    encoding: "utf8",
    timeout: 5000,
  });
  if (created.status !== 0)
    throw new Error(`Could not create invalid SQLite fixture: ${created.stderr}`);
}
const normalVector = Buffer.alloc(8 * 4);
for (let index = 0; index < 8; index++) normalVector.writeFloatLE((index + 1) / 100, index * 4);
const nonfiniteVector = Buffer.from(normalVector);
nonfiniteVector.writeUInt32LE(0x7fc00000, 0);
let child;
let server;

async function stopChild() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  if (
    await Promise.race([
      exited.then(() => true),
      new Promise((resolveWait) => setTimeout(() => resolveWait(false), 1500)),
    ])
  )
    return;
  child.kill("SIGKILL");
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 1500))]);
}

try {
  createInvalidFixture(join(site, "bad-hash.sqlite3"), `G${"0".repeat(63)}`, normalVector);
  createInvalidFixture(join(site, "nonfinite-vector.sqlite3"), "1".repeat(64), nonfiniteVector);
  const built = await build({
    entryPoints: [join(root, "src/index/note-sqlite/worker.ts")],
    outfile: join(site, "note-worker.mjs"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: false,
    logLevel: "silent",
    metafile: true,
    plugins: [
      {
        name: "d11-opfs-pool-inspector",
        setup(buildApi) {
          buildApi.onLoad({ filter: /src\/index\/note-sqlite\/worker\.ts$/ }, ({ path }) => {
            let contents = read(path).toString("utf8");
            const poolMarker = "await pool.reserveMinimumCapacity(8);";
            const handlerMarker = "const { id, method, payload } = event.data;";
            if (!contents.includes(poolMarker) || !contents.includes(handlerMarker))
              throw new Error("Expected worker instrumentation anchors were not found");
            contents = contents.replace(
              poolMarker,
              `${poolMarker}\n  (globalThis as any).__tramaD11PoolInspector = pool;`
            );
            contents = contents.replace(
              handlerMarker,
              `${handlerMarker}\n    if (method === "__testOpfsPool") {\n      const pool = (globalThis as any).__tramaD11PoolInspector;\n      scope.postMessage({ id, ok: true, result: { names: pool.getFileNames(), count: pool.getFileCount(), capacity: pool.getCapacity() } });\n      return;\n    }`
            );
            return { contents, loader: "ts" };
          });
        },
      },
    ],
  });
  copyFileSync(join(root, "sqlite3.mjs"), join(site, "sqlite3.mjs"));
  copyFileSync(join(root, "sqlite3.wasm"), join(site, "sqlite3.wasm"));
  copyFileSync(
    join(root, "scripts/benchmark/sqlite-opfs-shard/page.html"),
    join(site, "page.html")
  );
  copyFileSync(join(root, "scripts/benchmark/sqlite-opfs-shard/page.js"), join(site, "page.js"));

  server = createServer((request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const file = pathname === "/" ? "page.html" : pathname.slice(1);
    const fixture = file.startsWith("fixtures/") ? file.slice("fixtures/".length) : undefined;
    const safeFixture =
      fixture && ["bad-hash.sqlite3", "nonfinite-vector.sqlite3"].includes(fixture);
    const types = {
      "page.html": "text/html",
      "page.js": "text/javascript",
      "note-worker.mjs": "text/javascript",
      "sqlite3.mjs": "text/javascript",
      "sqlite3.wasm": "application/wasm",
    };
    const sourceFile = safeFixture ? join(site, fixture) : join(site, file);
    if ((!Object.hasOwn(types, file) && !safeFixture) || !readFileSync(sourceFile)) {
      response.writeHead(404).end("not found");
      return;
    }
    response.setHeader("Content-Type", safeFixture ? "application/vnd.sqlite3" : types[file]);
    response.end(readFileSync(sourceFile));
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address().port;
  const version = spawnSync(browser, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (version.status !== 0) throw new Error(`Brave --version failed: ${version.stderr}`);
  const args = [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-crash-reporter",
    "--disable-breakpad",
    `--crash-dumps-dir=${join(profileDir, "crashes")}`,
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "about:blank",
  ];
  const stderr = [];
  child = spawn(browser, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const activePortPath = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + 8000;
  let devtoolsPort;
  while (Date.now() < deadline && !devtoolsPort) {
    try {
      devtoolsPort = Number(readFileSync(activePortPath, "utf8").split("\n")[0]);
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  if (!devtoolsPort)
    throw new Error(
      `Brave did not start DevTools; stderr=${Buffer.concat(stderr).toString("utf8").slice(-3000)}`
    );
  const target = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)
    .then((response) => response.json())
    .then((targets) => targets.find((item) => item.type === "page"));
  if (!target) throw new Error("Brave exposed no page DevTools target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    ws.addEventListener("open", resolveOpen, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let commandId = 0;
  const replies = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const pending = replies.get(message.id);
    if (!pending) return;
    replies.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  });
  const command = (method, params = {}) =>
    new Promise((resolveCommand, reject) => {
      const id = ++commandId;
      const timeout = setTimeout(() => {
        replies.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 5000);
      replies.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolveCommand(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  let result;
  const browserDeadline = Date.now() + 30000;
  while (Date.now() < browserDeadline) {
    const evaluated = await command("Runtime.evaluate", {
      expression: "document.querySelector('#result')?.textContent ?? ''",
      returnByValue: true,
    });
    const value = evaluated.result?.value;
    if (value && value !== "running") {
      try {
        result = JSON.parse(value);
        break;
      } catch {
        /* wait for complete JSON assignment */
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!result) {
    const status = await command("Runtime.evaluate", {
      expression: "document.querySelector('#result')?.textContent ?? ''",
      returnByValue: true,
    })
      .then((item) => item.result?.value)
      .catch(() => "unavailable");
    throw new Error(
      `Browser harness exceeded 30-second limit at ${status}; stderr=${Buffer.concat(stderr).toString("utf8").slice(-3000)}`
    );
  }
  await command("Browser.close").catch(() => undefined);
  ws.close();
  const exit = await Promise.race([
    new Promise((resolveExit) =>
      child.once("exit", (code, signal) => resolveExit({ code, signal }))
    ),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(null), 5000)),
  ]);
  if (!exit) child.kill("SIGTERM");
  if (!result.ok) throw new Error(`Browser integration failed: ${result.error}\n${result.stack}`);
  const report = {
    ...result,
    exportPath: "production NoteSqliteDatabase.embeddingCacheSqliteExport using SQL VACUUM INTO",
    testBundleInstrumentation:
      "read-only SAH pool names/count/capacity inspection; no RPC or SQLite changes",
    browser: version.stdout.trim(),
    browserExit: exit,
    launchArgs: args,
    isolation: { userDataDir: profileDir, origin: `http://127.0.0.1:${port}` },
    temporaryProfileRemoved: true,
    assets: {
      worker: digest(read(join(site, "note-worker.mjs"))),
      workerSource: digest(read(join(root, "src/index/note-sqlite/worker.ts"))),
      sqliteModule: digest(read(join(site, "sqlite3.mjs"))),
      sqliteWasm: digest(read(join(site, "sqlite3.wasm"))),
      browserHarness: digest(read(join(site, "page.js"))),
    },
    buildInputs: Object.keys(built.metafile.inputs),
    capturedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: true, report: outputPath, browser: report.browser, rows: result.artifactRows, bytes: result.artifactBytes, importedRows: result.importedRows, browserExit: exit })}\n`
  );
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  await stopChild();
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(scratch, { recursive: true, force: true });
}
