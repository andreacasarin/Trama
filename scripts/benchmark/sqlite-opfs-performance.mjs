import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const browser = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const args = new Map(
  process.argv
    .slice(2)
    .map((value, index, values) =>
      value.startsWith("--") ? [value.slice(2), values[index + 1]] : null
    )
    .filter(Boolean)
);
const label = args.get("label") ?? "current";
const profileMode = args.has("profile");
const output = resolve(
  args.get("output") ??
    join(root, ".ai/bench/sqlite-embedding-cache/opfs-performance-smoke", `${label}.json`)
);
const planPath = resolve(
  args.get("plan") ??
    join(root, ".ai/bench/sqlite-embedding-cache/publication-20261013/current-final/plan.json")
);
const corpusPath = resolve(
  args.get("corpus") ??
    join(root, ".ai/bench/sqlite-embedding-cache/publication-20261013/current-final/corpus.json")
);
const scratch = mkdtempSync(`/private/tmp/trama-opfs-performance-${randomUUID()}-`);
const profile = join(scratch, `profile-${randomUUID()}`);
const site = join(scratch, "site");
mkdirSync(site, { recursive: true });
mkdirSync(join(profile, "crashes"), { recursive: true });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let child;
let server;

async function stopChild() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((done) => child.once("exit", done)),
    new Promise((done) => setTimeout(done, 1500)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function instrumentWorkerSource(source, label) {
  const connectionMarker = 'const connection = new pool.OpfsSAHPoolDb("/notes.sqlite3", "c");';
  const callMarker = "const result = await database.database.call(";
  if (!source.includes(connectionMarker) || !source.includes(callMarker))
    throw new Error(`${label} worker benchmark instrumentation anchors changed`);
  source = source.replace(
    connectionMarker,
    `${connectionMarker}\n  (globalThis as any).__tramaBenchConnection = connection;\n  (globalThis as any).__tramaBenchPool = pool;`
  );
  if (profileMode)
    source = source.replace(
      "globalThis as any).__tramaBenchPool = pool;",
      "globalThis as any).__tramaBenchPool = pool;\n  (globalThis as any).__tramaBenchProfile ??= { phases: {} };"
    );
  const dispatchMarker = `const result = await database.database.call(\n            method as NoteStoreMethod,\n            payload as NoteStoreRpc[NoteStoreMethod],\n            controller?.signal\n          );`;
  if (!source.includes(dispatchMarker))
    throw new Error(`${label} worker RPC instrumentation anchor changed`);
  source = source.replace(
    dispatchMarker,
    `${profileMode ? `const rpcStarted = performance.now();\n          ` : ""}${dispatchMarker}${profileMode ? `\n          if (method === "embeddingCacheSqliteMarkPublished") {\n            const profile = (globalThis as any).__tramaBenchProfile;\n            const value = profile.phases["receipt.rpc"] ??= { calls: 0, elapsedMs: 0, rows: 0, bytes: 0 };\n            value.calls++; value.elapsedMs += performance.now() - rpcStarted; value.rows += Number((payload as any)?.hashes?.length ?? 0);\n          }` : ""}`
  );
  const inspection = `if (method === "__benchSnapshot") {
            const state = globalThis as any;
            const connection = state.__tramaBenchConnection;
            const pool = state.__tramaBenchPool;
            const scalar = (sql: string): number => {
              let value = 0;
              connection.exec({ sql, callback: (row: Record<string, unknown>) => { value = Number(Object.values(row)[0] ?? 0); } });
              return value;
            };
            const tables = ["note_index", "note_vectors", "embedding_cache", "embedding_cache_imports", "embedding_cache_publications", "embedding_cache_sqlite_imports", "embedding_cache_sqlite_publications"];
            const counts = Object.fromEntries(tables.map((table) => {
              const exists = scalar("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='" + table + "'");
              return [table, exists ? scalar("SELECT count(*) FROM " + table) : 0];
            }));
            const pageCount = scalar("PRAGMA page_count");
            const pageSize = scalar("PRAGMA page_size");
            const result = { pageCount, pageSize, mainDatabaseBytes: pageCount * pageSize, counts, poolNames: pool.getFileNames?.(), poolFileCount: pool.getFileCount?.(), poolCapacity: pool.getCapacity?.()${profileMode ? `, profile: state.__tramaBenchProfile?.phases ?? {}` : ""} };
            scope.postMessage({ id, ok: true, result });
            return;
          }
          `;
  return source.replace(callMarker, `${inspection}${callMarker}`);
}

function instrumentDatabaseExport(source, label) {
  const methodStart = source.indexOf("  private async embeddingCacheSqliteExport(");
  const methodEnd = source.indexOf("  private async embeddingCacheSqliteImport(", methodStart);
  if (methodStart < 0 || methodEnd < 0)
    throw new Error(`${label} database export instrumentation anchors changed`);
  const helper = `\nfunction __tramaBenchRecord(name: string, elapsedMs: number, rows = 0, bytes = 0): void {\n  const state = globalThis as any;\n  const profile = state.__tramaBenchProfile ??= { phases: {} };\n  const value = profile.phases[name] ??= { calls: 0, elapsedMs: 0, rows: 0, bytes: 0 };\n  value.calls++; value.elapsedMs += elapsedMs; value.rows += rows; value.bytes += bytes;\n}\nfunction __tramaBenchMeasure<T>(name: string, work: () => T, rows = 0, bytes = 0): T {\n  const started = performance.now();\n  try { return work(); } finally { __tramaBenchRecord(name, performance.now() - started, rows, bytes); }\n}\nfunction __tramaBenchSqlName(options: any): string {\n  const sql = typeof options === "string" ? options : String(options?.sql ?? "");\n  if (/^\\s*ATTACH/i.test(sql)) return "scratch.attach";\n  if (/^\\s*DETACH/i.test(sql)) return "scratch.detach";\n  if (/^\\s*VACUUM\\s+INTO/i.test(sql)) return "scratch.vacuumInto";\n  if (/INSERT INTO vectors/i.test(sql) && /SELECT/i.test(sql)) return "scratch.insertSelect";\n  if (/^\\s*DELETE FROM vectors/i.test(sql)) return "scratch.batchReset";\n  if (/^\\s*(CREATE|PRAGMA|INSERT INTO metadata)/i.test(sql)) return "scratch.setupSql";\n  return "scratch.otherSql";\n}\nfunction __tramaBenchScratchExec(scratch: any, ...args: any[]): any {\n  const name = __tramaBenchSqlName(args[0]);\n  const rows = name === "scratch.insertSelect" ? Number(args[0]?.bind?.[1] ?? 0) : 0;\n  return __tramaBenchMeasure(name, () => scratch.exec(...args), rows);\n}\n`;
  source = source.replace(
    "const SQLITE_SHARD_APPLICATION_ID",
    `${helper}\nconst SQLITE_SHARD_APPLICATION_ID`
  );
  const receiptHelper = `\nfunction __tramaBenchReceiptExec(db: any, ...args: any[]): any {\n  const options = args[0];\n  const sql = typeof options === "string" ? options : String(options?.sql ?? "");\n  const name = /embedding_cache_sqlite_publications/i.test(sql) ? "receipt.vectorSql" : /embedding_cache_sqlite_imports/i.test(sql) ? "receipt.artifactSql" : /^\\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql) ? "receipt.transactionSql" : "receipt.otherSql";\n  return __tramaBenchMeasure(name, () => db.exec(...args), name === "receipt.vectorSql" ? 1 : 0);\n}\n`;
  source = source.replace(
    "const SQLITE_SHARD_APPLICATION_ID",
    `${receiptHelper}\nconst SQLITE_SHARD_APPLICATION_ID`
  );
  const adjustedStart = source.indexOf("  private async embeddingCacheSqliteExport(");
  const adjustedEnd = source.indexOf("  private async embeddingCacheSqliteImport(", adjustedStart);
  let method = source.slice(adjustedStart, adjustedEnd);
  method = method.replace(
    'const scratch = pool.openDatabase(scratchPath, "c");',
    'const scratch = __tramaBenchMeasure("scratch.open", () => pool.openDatabase(scratchPath, "c"));'
  );
  method = method.replaceAll("scratch.exec(", "__tramaBenchScratchExec(scratch, ");
  method = method.replace(
    'const hashes = rows(scratch, "SELECT hash FROM vectors ORDER BY hash COLLATE BINARY").map(\n          (row) => String(row.hash)\n        );',
    'const hashes = __tramaBenchMeasure("scratch.hashQuery", () => { const values = rows(scratch, "SELECT hash FROM vectors ORDER BY hash COLLATE BINARY").map((row) => String(row.hash)); __tramaBenchRecord("scratch.hashRows", 0, values.length); return values; });'
  );
  method = method.replace(
    "const bytes = pool.exportFile(targetPath);",
    'const bytes = __tramaBenchMeasure("target.exportFile", () => pool.exportFile(targetPath), hashes.length);'
  );
  method = method.replace(
    "pool.unlink(targetPath);",
    '__tramaBenchMeasure("target.unlink", () => pool.unlink(targetPath));'
  );
  method = method.replace(
    "scratch.close();",
    '__tramaBenchMeasure("scratch.close", () => scratch.close());'
  );
  method = method.replace(
    "pool.unlink(scratchPath);",
    '__tramaBenchMeasure("scratch.unlink", () => pool.unlink(scratchPath));'
  );
  method = method.replaceAll(
    "await yieldSqlite(signal);",
    'await (async () => { const started = performance.now(); try { await yieldSqlite(signal); } finally { __tramaBenchRecord("scratch.yield", performance.now() - started); } })();'
  );
  source = source.slice(0, adjustedStart) + method + source.slice(adjustedEnd);
  const receiptStart = source.indexOf("  private async embeddingCacheSqliteMarkPublished(");
  const receiptEnd = source.indexOf("  private async hybridSearch(", receiptStart);
  if (receiptStart < 0 || receiptEnd < 0)
    throw new Error(`${label} receipt instrumentation anchors changed`);
  let receipt = source.slice(receiptStart, receiptEnd);
  receipt = receipt.replaceAll("this.db.exec(", "__tramaBenchReceiptExec(this.db, ");
  receipt = receipt.replaceAll(
    "await yieldSqlite(signal);",
    'await (async () => { const started = performance.now(); try { await yieldSqlite(signal); } finally { __tramaBenchRecord("receipt.yield", performance.now() - started); } })();'
  );
  return source.slice(0, receiptStart) + receipt + source.slice(receiptEnd);
}

function validateReports(reports, plan) {
  for (const side of Object.keys(reports)) {
    if (!Array.isArray(reports[side]) || reports[side].length !== plan.runs.length)
      throw new Error(`${side} report is missing planned run sizes`);
    for (let index = 0; index < plan.runs.length; index++) {
      const expected = plan.runs[index];
      const run = reports[side][index];
      if (
        run.count !== expected.count ||
        run.warmups.length !== expected.warmups ||
        run.samples.length !== expected.samples
      )
        throw new Error(`${side} report has incomplete ${expected.count}-note samples`);
      for (const sample of [...run.warmups, ...run.samples]) {
        if (
          sample.initial.noteCount !== expected.count ||
          sample.finalSqlite?.counts?.note_index !== expected.count - 1
        )
          throw new Error(`${side} ${expected.count}-note index counts are incorrect`);
        if (sample.initial.sqlite?.mainDatabaseBytes <= 0)
          throw new Error(`${side} ${expected.count}-note SQL database page stats are missing`);
        if (
          sample.initial.sharedBootstrap.noteCount !== expected.count ||
          sample.initial.sharedBootstrap.providerCalls !== 0 ||
          sample.initial.sharedBootstrap.sharing !== "complete"
        )
          throw new Error(`${side} ${expected.count}-note shared bootstrap failed`);
        const names = sample.finalSqlite?.poolNames;
        if (!Array.isArray(names) || names.length !== 1 || names[0] !== "/notes.sqlite3")
          throw new Error(`${side} left logical SAH pool scratch files allocated`);
        for (const [kind, expectedPath] of [
          ["lexical", "notes/0000.md"],
          ["hybrid", "notes/0001.md"],
          ["related", "notes/0002.md"],
        ])
          if (!sample.queries[kind].sentinelPaths.includes(expectedPath))
            throw new Error(`${side} ${kind} query sentinel is missing`);
      }
    }
  }
}

try {
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  if (plan.corpusSha256 !== corpus.sha256) throw new Error("Plan/corpus SHA-256 mismatch");
  if (plan.dimensions !== 768 || corpus.notes.length !== 3000)
    throw new Error("Unexpected pinned benchmark inputs");
  const effectivePlan = args.has("smoke")
    ? { ...plan, runs: [plan.runs[0]] }
    : profileMode
      ? { ...plan, runs: plan.runs.slice(1) }
      : plan;
  writeFileSync(join(site, "plan.json"), JSON.stringify(effectivePlan));
  copyFileSync(corpusPath, join(site, "corpus.json"));
  copyFileSync(
    join(root, "scripts/benchmark/sqlite-opfs-performance/page.html"),
    join(site, "page.html")
  );
  copyFileSync(
    join(root, "scripts/benchmark/sqlite-opfs-performance/page.js"),
    join(site, "page.js")
  );

  const workspaces = args.has("pair")
    ? [
        {
          label: "baseline",
          workspace: resolve(args.get("baseline-workspace")),
          worker: "/baseline-worker.mjs",
          bundle: "/baseline-workload.mjs",
        },
        {
          label: "current",
          workspace: resolve(args.get("current-workspace")),
          worker: "/current-worker.mjs",
          bundle: "/current-workload.mjs",
        },
      ]
    : [
        {
          label,
          workspace: resolve(args.get("workspace") ?? root),
          worker: "/note-worker.mjs",
          bundle: "/workload.mjs",
        },
      ];
  for (const version of workspaces) {
    const aliasPlugin = {
      name: `benchmark-${version.label}-src`,
      setup(api) {
        api.onResolve({ filter: /^@\// }, ({ path }) => ({
          path: `${resolve(version.workspace, "src", path.slice(2))}.ts`,
        }));
      },
    };
    const benchWorkerPlugin = {
      name: "benchmark-readonly-sqlite-inspector",
      setup(api) {
        api.onLoad({ filter: /src\/index\/note-sqlite\/worker\.ts$/ }, ({ path }) => {
          let contents = readFileSync(path, "utf8");
          contents = instrumentWorkerSource(contents, version.label);
          return { contents, loader: "ts" };
        });
        if (profileMode) {
          api.onLoad({ filter: /src\/index\/note-sqlite\/database\.ts$/ }, ({ path }) => ({
            contents: instrumentDatabaseExport(readFileSync(path, "utf8"), version.label),
            loader: "ts",
          }));
          api.onLoad({ filter: /src\/plugin\/VaultEmbeddingCache\.ts$/ }, ({ path }) => {
            const marker =
              'const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));';
            const contents = readFileSync(path, "utf8");
            if (!contents.includes(marker))
              throw new Error(`${version.label} checksum instrumentation anchor changed`);
            return {
              contents: contents.replace(
                marker,
                'const digest = new Uint8Array(await (globalThis as any).__tramaBenchMeasureAsync("vault.checksum", () => crypto.subtle.digest("SHA-256", input), 0, input.byteLength));'
              ),
              loader: "ts",
            };
          });
        }
      },
    };
    const common = {
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      sourcemap: false,
      logLevel: "silent",
      nodePaths: [join(root, "node_modules")],
      plugins: [aliasPlugin, benchWorkerPlugin],
    };
    await build({
      ...common,
      entryPoints: [join(root, "scripts/benchmark/sqlite-opfs-performance/workload.ts")],
      outfile: join(site, version.bundle.slice(1)),
    });
    await build({
      ...common,
      entryPoints: [join(version.workspace, "src/index/note-sqlite/worker.ts")],
      outfile: join(site, version.worker.slice(1)),
    });
  }
  writeFileSync(
    join(site, "runner.json"),
    JSON.stringify({
      versions: workspaces.map(({ label, worker, bundle }) => ({ label, worker, bundle })),
    })
  );
  copyFileSync(join(root, "sqlite3.mjs"), join(site, "sqlite3.mjs"));
  copyFileSync(join(root, "sqlite3.wasm"), join(site, "sqlite3.wasm"));

  const types = new Map([
    ["page.html", "text/html"],
    ["page.js", "text/javascript"],
    ["runner.json", "application/json"],
    ["sqlite3.mjs", "text/javascript"],
    ["sqlite3.wasm", "application/wasm"],
    ["plan.json", "application/json"],
    ["corpus.json", "application/json"],
  ]);
  for (const version of workspaces) {
    types.set(version.bundle.slice(1), "text/javascript");
    types.set(version.worker.slice(1), "text/javascript");
  }
  server = createServer((request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const name = pathname === "/" ? "page.html" : pathname.slice(1);
    const type = types.get(name);
    if (!type) return response.writeHead(404).end("not found");
    response.setHeader("Content-Type", type);
    response.end(readFileSync(join(site, name)));
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const version = spawnSync(browser, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (version.status !== 0) throw new Error(`Brave version failed: ${version.stderr}`);
  const launchArgs = [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-crash-reporter",
    "--disable-breakpad",
    `--crash-dumps-dir=${join(profile, "crashes")}`,
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "about:blank",
  ];
  const stderr = [];
  child = spawn(browser, launchArgs, { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 8000;
  let devtoolsPort;
  while (Date.now() < deadline && !devtoolsPort) {
    try {
      devtoolsPort = Number(readFileSync(portFile, "utf8").split("\n")[0]);
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  if (!devtoolsPort)
    throw new Error(
      `Brave did not expose DevTools: ${Buffer.concat(stderr).toString().slice(-2000)}`
    );
  const target = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)
    .then((r) => r.json())
    .then((rows) => rows.find((row) => row.type === "page"));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    ws.addEventListener("open", resolveOpen, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message));
    else callback.resolve(message.result);
  });
  const command = (method, params = {}) =>
    new Promise((resolveCommand, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timed out: ${method}`));
      }, 5000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveCommand(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Page.navigate", {
    url: `http://127.0.0.1:${server.address().port}/${profileMode ? "?profile" : ""}`,
  });
  let result;
  const runDeadline = Date.now() + 30 * 60_000;
  while (Date.now() < runDeadline) {
    const evaluation = await command("Runtime.evaluate", {
      expression: "document.querySelector('#result')?.textContent ?? ''",
      returnByValue: true,
    });
    const value = evaluation.result?.value;
    if (value && value !== "running") {
      try {
        result = JSON.parse(value);
        break;
      } catch {
        /* wait for completed assignment */
      }
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!result) throw new Error("Browser workload timed out");
  await command("Browser.close").catch(() => undefined);
  ws.close();
  await stopChild();
  if (!result.ok) throw new Error(`Browser workload failed: ${result.error}\n${result.stack}`);
  validateReports(result.reports, effectivePlan);
  const archivePaths = args.has("pair")
    ? {
        baseline: resolve(
          args.get("baseline-archive") ?? "/private/tmp/trama-publication-d9-warmup.tar"
        ),
        current: resolve(args.get("current-archive") ?? "/private/tmp/trama-sqlite-shards-t8.tar"),
      }
    : { [label]: args.get("archive") ? resolve(args.get("archive")) : null };
  const snapshots = Object.fromEntries(
    Object.entries(archivePaths).map(([side, archive]) => [
      side,
      {
        path: archive,
        sha256: archive ? digest(readFileSync(archive)) : null,
      },
    ])
  );
  const report = {
    schema: "trama-opfs-publication-benchmark-smoke-v1",
    label,
    corpusSha256: corpus.sha256,
    plan: effectivePlan,
    planSha256: digest(readFileSync(planPath)),
    snapshots,
    runtime: {
      node: process.version,
      platform: `${os.platform()}-${os.arch()}`,
      cpu: os.cpus()[0]?.model,
    },
    browser: version.stdout.trim(),
    launchArgs,
    isolatedUserDataDir: profile,
    bundles: Object.fromEntries(
      workspaces.map(({ label, worker, bundle }) => [
        label,
        {
          workerSha256: digest(readFileSync(join(site, worker.slice(1)))),
          workloadSha256: digest(readFileSync(join(site, bundle.slice(1)))),
        },
      ])
    ),
    sqliteModuleSha256: digest(readFileSync(join(site, "sqlite3.mjs"))),
    sqliteWasmSha256: digest(readFileSync(join(site, "sqlite3.wasm"))),
    sqliteSupplyChainSha256: Object.fromEntries(
      workspaces.map(({ label, workspace }) => [
        label,
        digest(readFileSync(join(workspace, "vendor/sqlite-wasm/supply-chain.json"))),
      ])
    ),
    packageLockSha256: Object.fromEntries(
      workspaces.map(({ label, workspace }) => [
        label,
        digest(readFileSync(join(workspace, "package-lock.json"))),
      ])
    ),
    driverSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    pageSha256: digest(
      readFileSync(join(root, "scripts/benchmark/sqlite-opfs-performance/page.js"))
    ),
    workloadSourceSha256: digest(
      readFileSync(join(root, "scripts/benchmark/sqlite-opfs-performance/workload.ts"))
    ),
    profileMode,
    report: result.reports,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ output, corpusSha256: corpus.sha256, sides: Object.keys(result.reports), runs: Object.fromEntries(Object.entries(result.reports).map(([side, runs]) => [side, runs.map((run) => ({ count: run.count, samples: run.samples.length }))])) }, null, 2)}\n`
  );
} finally {
  await stopChild();
  server?.close();
  rmSync(scratch, { recursive: true, force: true });
}
