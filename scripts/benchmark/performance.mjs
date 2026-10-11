import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  createPerformanceCorpus,
  CORPUS_SHA256,
  DIMENSIONS,
  QUERIES,
} from "./performance-fixture.mjs";

export const BASELINE_REVISION = "e03133025f3acb68b75514dfbf18448e903cbbf0";
export const CURRENT_REVISION = "86423c69ef8563dabebd4db252e88a53676853db";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const entry = path.resolve(process.argv[1] ?? "");

export function summarize(values) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => !Number.isFinite(value))
  )
    throw new Error("Expected a non-empty list of finite measurements");
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    count: sorted.length,
    median: percentile(sorted, 0.5),
    min: sorted[0],
    max: sorted.at(-1),
    p95: percentile(sorted, 0.95),
  };
}

export function validatePair(baseline, current, plan) {
  if (baseline.revision !== BASELINE_REVISION || current.revision !== CURRENT_REVISION)
    throw new Error("Benchmark revisions do not match the pinned comparison");
  if (baseline.corpusSha256 !== plan.corpusSha256 || current.corpusSha256 !== plan.corpusSha256)
    throw new Error("Benchmark corpus differs between revisions");
  for (const run of plan.runs) {
    for (const [label, report] of [
      ["baseline", baseline],
      ["current", current],
    ]) {
      const result = report.runs.find((item) => item.count === run.count);
      if (!result || result.samples.length !== run.samples || result.warmups.length !== run.warmups)
        throw new Error(`${label} report has incomplete ${run.count}-note samples`);
      for (const sample of result.samples) validateSample(sample, run.count);
    }
  }
}

export function validateSqliteAssetHashes(baseline, current) {
  for (const [key, label] of [
    ["module", "SQLite module"],
    ["wasm", "SQLite WASM"],
    ["supplyChainLock", "SQLite supply-chain lock"],
  ]) {
    if (!baseline[key] || baseline[key] !== current[key])
      throw new Error(`${label} hashes differ between benchmark revisions`);
  }
}

function validateSample(sample, noteCount) {
  if (sample.initial.noteCount !== noteCount || sample.finalNoteCount !== noteCount - 1)
    throw new Error("Benchmark sample has unexpected indexed note counts");
  if (!Number.isFinite(sample.coldIndexMs) || sample.coldIndexMs < 0)
    throw new Error("Benchmark sample has invalid index timing");
  for (const operation of ["unchanged", "oneEdit", "oneDelete"])
    if (!Number.isFinite(sample.operations[operation]?.elapsedMs))
      throw new Error(`Benchmark sample is missing ${operation} timing`);
  for (const query of ["lexical", "hybrid", "related"]) {
    const result = sample.queries[query];
    if (!result || result.timingsMs.some((value) => !Number.isFinite(value)))
      throw new Error(`Benchmark sample has invalid ${query} timings`);
    if (result.timingsMs.length === 0)
      throw new Error(`Benchmark sample has no ${query} timing measurements`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(
    args.outputDir ??
      path.join(
        root,
        ".ai/bench/langchain-assessment",
        new Date().toISOString().replaceAll(":", "-")
      )
  );
  await mkdir(outputDir, { recursive: true });
  const corpus = createPerformanceCorpus();
  const corpusPath = path.join(outputDir, "corpus.json");
  await writeFile(corpusPath, JSON.stringify(corpus));

  const runs = args.smoke
    ? [{ count: 24, warmups: 0, samples: 1, queryWarmups: 0, querySamples: 1 }]
    : [
        { count: 24, warmups: 0, samples: 1, queryWarmups: 0, querySamples: 1 },
        { count: 300, warmups: 1, samples: 5, queryWarmups: 5, querySamples: 30 },
        { count: 3000, warmups: 1, samples: 3, queryWarmups: 5, querySamples: 30 },
      ];
  const plan = {
    corpusSha256: CORPUS_SHA256,
    dimensions: DIMENSIONS,
    endpoint: "http://127.0.0.1:1234/v1",
    modelId: "paired-local-deterministic-fixture",
    namespace: "b".repeat(64),
    queries: QUERIES,
    runs,
  };
  const planPath = path.join(outputDir, "plan.json");
  await writeFile(planPath, JSON.stringify(plan, null, 2));

  const scratch = await mkdtemp(path.join(os.tmpdir(), "trama-performance-"));
  try {
    const baselineDir = args.baselineDir
      ? path.resolve(args.baselineDir)
      : await unpackSnapshot(
          args.baselineTar ??
            process.env.TRAMA_BENCHMARK_BASELINE_TAR ??
            "/private/tmp/trama-benchmark-inputs/baseline.tar",
          path.join(scratch, "baseline")
        );
    const currentDir = args.currentDir
      ? path.resolve(args.currentDir)
      : await unpackSnapshot(
          args.currentTar ??
            process.env.TRAMA_BENCHMARK_CURRENT_TAR ??
            "/private/tmp/trama-benchmark-inputs/current.tar",
          path.join(scratch, "current")
        );
    await prepareAdapter(
      baselineDir,
      path.join(root, "scripts/benchmark/baseline-adapter.ts"),
      "legacy"
    );
    await prepareAdapter(
      currentDir,
      path.join(root, "scripts/benchmark/current-adapter.ts"),
      "native"
    );
    const buildCommands = [];
    if (!args.prepared) {
      await npmInstallIfNeeded(baselineDir);
      await runCommand("npm", ["run", "build"], baselineDir);
      buildCommands.push({ revision: BASELINE_REVISION, command: "npm run build" });
      await reuseSqliteAssetsIfCompatible(baselineDir, currentDir);
      await npmInstallIfNeeded(currentDir);
      await runCommand("npm", ["run", "build"], currentDir);
      buildCommands.push({ revision: CURRENT_REVISION, command: "npm run build" });
    } else {
      await requireBuildArtifacts(baselineDir);
      await requireBuildArtifacts(currentDir);
      buildCommands.push({ revision: BASELINE_REVISION, command: "prepared isolated build" });
      buildCommands.push({ revision: CURRENT_REVISION, command: "prepared isolated build" });
    }

    await validateSharedSqliteAssets(baselineDir, currentDir);
    const baselineBuild = await instrumentBuild(baselineDir);
    const currentBuild = await instrumentBuild(currentDir);
    const baselineOut = path.join(outputDir, "baseline-raw.json");
    const currentOut = path.join(outputDir, "current-raw.json");
    await runAdapter(baselineDir, planPath, corpusPath, baselineOut);
    await runAdapter(currentDir, planPath, corpusPath, currentOut);
    const baselineRuns = JSON.parse(await readFile(baselineOut, "utf8"));
    const currentRuns = JSON.parse(await readFile(currentOut, "utf8"));
    const baseline = {
      revision: BASELINE_REVISION,
      corpusSha256: corpus.sha256,
      runs: baselineRuns,
    };
    const current = { revision: CURRENT_REVISION, corpusSha256: corpus.sha256, runs: currentRuns };
    validatePair(baseline, current, plan);

    const report = {
      schema: "trama-langchain-performance-v1",
      generatedAt: new Date().toISOString(),
      revisions: { baseline: BASELINE_REVISION, current: CURRENT_REVISION },
      corpus: { sha256: corpus.sha256, noteCount: corpus.notes.length, noteCharacters: 400 },
      plan,
      comparisonNotes: [
        "Baseline vectors count is compatible, deduplicated embedding-cache entries; legacy chunk count counts structural chunks. Repeated embedding inputs share cached vectors, so those values are not expected to match.",
        "Current vectors count is persisted note vectors, one per default-splitter chunk.",
        "Baseline related-note timings call RelatedNotes.find with refresh=true to bypass its cached result path; current timings use the SQL related lookup.",
        "Hybrid timing includes observed embedding calls: the baseline may reuse its query-embedding cache, while the current adapter performs query embeddings through the production interface.",
      ],
      provenance: {
        ...(await provenance(baselineDir, currentDir, buildCommands)),
        snapshots: await snapshotInputs(args, baselineDir, currentDir),
      },
      builds: { baseline: baselineBuild, current: currentBuild },
      bundles: {
        baseline: await bundleFiles(baselineDir),
        current: await bundleFiles(currentDir),
      },
      measurements: { baseline: summarizeRuns(baseline), current: summarizeRuns(current) },
      raw: { baseline: baselineRuns, current: currentRuns },
    };
    const reportPath = path.join(outputDir, "report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ reportPath, corpusSha256: corpus.sha256, summary: report.measurements }, null, 2)}\n`
    );
  } finally {
    if (!args.keepScratch) await rm(scratch, { recursive: true, force: true });
  }
}

async function prepareAdapter(workspace, sourcePath, kind) {
  const folder = path.join(workspace, "scripts/benchmark");
  await mkdir(folder, { recursive: true });
  await copyFile(
    path.join(root, "scripts/benchmark/performance-fixture.mjs"),
    path.join(folder, "performance-fixture.mjs")
  );
  const destination = path.join(workspace, "tests/performance-benchmark.test.ts");
  await copyFile(sourcePath, destination);
  if (kind !== "legacy" && kind !== "native") throw new Error("Unknown adapter kind");
}

async function runAdapter(workspace, planPath, corpusPath, outputPath) {
  await runCommand(
    "npx",
    ["vitest", "run", "tests/performance-benchmark.test.ts"],
    workspace,
    {
      TRAMA_BENCHMARK_PLAN: planPath,
      TRAMA_BENCHMARK_CORPUS: corpusPath,
      TRAMA_BENCHMARK_OUT: outputPath,
    },
    60 * 60 * 1000
  );
}

async function instrumentBuild(workspace) {
  const normal = {
    main: await fileDigest(path.join(workspace, "main.js")),
    worker: await fileDigest(path.join(workspace, "sqlite-worker.mjs")),
  };
  const script = `
    import esbuild from 'esbuild';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    const id=JSON.parse(readFileSync('.cache/runtime-build.json','utf8')).buildId;
    const old=readFileSync('esbuild.config.mjs','utf8').includes('__TRAMA_RUNTIME_BUILD_ID__');
    const common={bundle:true,platform:'browser',target:'es2020',minify:true,logLevel:'silent',metafile:true,write:false};
    const main=await esbuild.build({...common,entryPoints:['src/main.ts'],external:['obsidian'],format:'cjs',outfile:'main.js',...(old?{define:{__TRAMA_RUNTIME_BUILD_ID__:JSON.stringify(id)}}:{banner:{js:'/* runtime-build:'+id+' */'}})});
    const workerPath=old?'src/index/sqlite/worker.ts':'src/index/note-sqlite/worker.ts';
    const worker=await esbuild.build({...common,entryPoints:[workerPath],format:'esm',outfile:'sqlite-worker.mjs',...(old?{define:{__TRAMA_RUNTIME_BUILD_ID__:JSON.stringify(id)}}:{banner:{js:'/* runtime-build:'+id+' */'}})});
    const digest=b=>createHash('sha256').update(b).digest('hex');
    const outputs={main,worker}; const files={}; const result={};
    for(const [key,build] of Object.entries(outputs)){
      const file=build.outputFiles.find(item=>item.path.endsWith(key==='main'?'main.js':'sqlite-worker.mjs'));
      files[key]=digest(file.contents);
      const record=Object.values(build.metafile.outputs)[0];
      const sums={vendor:0,local:0,other:0,packages:{}};
      for(const [name,input] of Object.entries(record.inputs)){
        const n=input.bytesInOutput||0;
        if(name.includes('node_modules/')){
          sums.vendor+=n;
          const match=name.match(/(?:^|\\/)node_modules\\/((?:@[^/]+\\/)?[^/]+)/);
          const pkg=match?.[1]||'unknown'; sums.packages[pkg]=(sums.packages[pkg]||0)+n;
        } else if(name.includes('/src/')||name.startsWith('src/')) sums.local+=n;
        else sums.other+=n;
      }
      result[key]={bytes:file.contents.byteLength,inputs:sums};
    }
    writeFileSync('.cache/performance-metafile.json',JSON.stringify({files,result}));
  `;
  await runCommand(process.execPath, ["--input-type=module", "-e", script], workspace);
  const metafile = JSON.parse(
    await readFile(path.join(workspace, ".cache/performance-metafile.json"), "utf8")
  );
  if (normal.main !== metafile.files.main || normal.worker !== metafile.files.worker)
    throw new Error("Metafile instrumentation changed normal production bundle bytes");
  for (const output of Object.values(metafile.result)) {
    const attributed = output.inputs.vendor + output.inputs.local + output.inputs.other;
    output.inputs.overhead = output.bytes - attributed;
    output.inputs.largestPackages = Object.entries(output.inputs.packages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, bytes]) => ({ name, bytes }));
    delete output.inputs.packages;
  }
  return metafile.result;
}

async function bundleFiles(workspace) {
  const paths = [
    "main.js",
    "sqlite-worker.mjs",
    "sqlite3.mjs",
    "sqlite3.wasm",
    "manifest.json",
    "styles.css",
  ];
  const entries = {};
  for (const relativePath of paths) {
    const bytes = await readFile(path.join(workspace, relativePath));
    entries[relativePath] = { bytes: bytes.byteLength, gzipBytes: gzipSync(bytes).byteLength };
  }
  return entries;
}

async function provenance(baselineDir, currentDir, buildCommands) {
  const npmVersion = runCommand("npm", ["--version"], root).stdout.trim();
  return {
    node: process.version,
    npm: npmVersion,
    platform: `${os.platform()}-${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    buildCommands,
    sqlite: {
      baselineLockSha256: await fileDigest(
        path.join(baselineDir, "vendor/sqlite-wasm/supply-chain.json")
      ),
      currentLockSha256: await fileDigest(
        path.join(currentDir, "vendor/sqlite-wasm/supply-chain.json")
      ),
      baselineWasmSha256: await fileDigest(path.join(baselineDir, "sqlite3.wasm")),
      currentWasmSha256: await fileDigest(path.join(currentDir, "sqlite3.wasm")),
      baselineModuleSha256: await fileDigest(path.join(baselineDir, "sqlite3.mjs")),
      currentModuleSha256: await fileDigest(path.join(currentDir, "sqlite3.mjs")),
    },
    baselineLockSha256: await fileDigest(path.join(baselineDir, "package-lock.json")),
    currentLockSha256: await fileDigest(path.join(currentDir, "package-lock.json")),
  };
}

async function validateSharedSqliteAssets(baselineDir, currentDir) {
  const paths = {
    module: "sqlite3.mjs",
    wasm: "sqlite3.wasm",
    supplyChainLock: "vendor/sqlite-wasm/supply-chain.json",
  };
  const hashes = {};
  for (const [key, relativePath] of Object.entries(paths)) {
    hashes[key] = {
      baseline: await fileDigest(path.join(baselineDir, relativePath)),
      current: await fileDigest(path.join(currentDir, relativePath)),
    };
  }
  validateSqliteAssetHashes(
    Object.fromEntries(Object.entries(hashes).map(([key, value]) => [key, value.baseline])),
    Object.fromEntries(Object.entries(hashes).map(([key, value]) => [key, value.current]))
  );
}

async function snapshotInputs(args, baselineDir, currentDir) {
  const archives = {
    baseline: path.resolve(
      args.baselineTar ??
        process.env.TRAMA_BENCHMARK_BASELINE_TAR ??
        "/private/tmp/trama-benchmark-inputs/baseline.tar"
    ),
    current: path.resolve(
      args.currentTar ??
        process.env.TRAMA_BENCHMARK_CURRENT_TAR ??
        "/private/tmp/trama-benchmark-inputs/current.tar"
    ),
  };
  const archiveDetails = {};
  for (const [label, archive] of Object.entries(archives)) {
    try {
      archiveDetails[label] = { path: archive, sha256: await fileDigest(archive) };
    } catch {
      archiveDetails[label] = { path: archive, sha256: null };
    }
  }
  return {
    revisionLabels: { baseline: BASELINE_REVISION, current: CURRENT_REVISION },
    revisionLabelsAreDeclaredNotGitValidated: true,
    workspaceMode: args.prepared ? "prepared-directories" : "extracted-tar-archives",
    workspaceDirectories: { baseline: baselineDir, current: currentDir },
    workspaceContentsVerifiedAgainstArchives: !args.prepared,
    archives: archiveDetails,
  };
}

function summarizeRuns(report) {
  return report.runs.map((run) => {
    const measured = run.samples;
    const coldIndex = measured.map((sample) => sample.coldIndexMs);
    const operations = Object.fromEntries(
      ["unchanged", "oneEdit", "oneDelete"].map((name) => [
        name,
        summarize(measured.map((sample) => sample.operations[name].elapsedMs)),
      ])
    );
    const queries = Object.fromEntries(
      ["lexical", "hybrid", "related"].map((name) => {
        const values = measured.flatMap((sample) => sample.queries[name].timingsMs);
        const provider = measured.reduce(
          (total, sample) => {
            for (const key of ["calls", "texts", "characters", "elapsedMs"])
              total[key] += sample.queries[name].provider[key];
            return total;
          },
          { calls: 0, texts: 0, characters: 0, elapsedMs: 0 }
        );
        return [name, { ...summarize(values), provider }];
      })
    );
    return {
      count: run.count,
      samples: measured.length,
      coldIndex: summarize(coldIndex),
      operations,
      queries,
      actualChunkCounts: measured.map(
        (sample) => sample.initial.chunkCount ?? sample.initial.vectorCount
      ),
      vectors: measured.map((sample) => sample.initial.vectorCount),
      databaseExportBytes: measured.map((sample) => sample.initial.databaseExportBytes),
    };
  });
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function npmInstallIfNeeded(workspace) {
  try {
    await stat(path.join(workspace, "node_modules"));
  } catch {
    await runCommand("npm", ["ci", "--offline", "--ignore-scripts"], workspace);
  }
}

async function requireBuildArtifacts(workspace) {
  for (const file of ["main.js", "sqlite-worker.mjs", "sqlite3.mjs", "sqlite3.wasm"])
    await stat(path.join(workspace, file));
}

async function reuseSqliteAssetsIfCompatible(source, target) {
  const sourceFingerprint = runCommand(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import('./scripts/sqlite-wasm/build.mjs').then(m=>console.log(m.getBuildContext().fingerprint))",
    ],
    source
  ).stdout.trim();
  const targetFingerprint = runCommand(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import('./scripts/sqlite-wasm/build.mjs').then(m=>console.log(m.getBuildContext().fingerprint))",
    ],
    target
  ).stdout.trim();
  if (sourceFingerprint !== targetFingerprint)
    throw new Error("Baseline/current pinned SQLite WASM build inputs differ");
  for (const file of ["sqlite3.mjs", "sqlite3.wasm"])
    await copyFile(path.join(source, file), path.join(target, file));
  await mkdir(path.join(target, ".cache/sqlite-wasm"), { recursive: true });
  await copyFile(
    path.join(source, ".cache/sqlite-wasm/fingerprint.json"),
    path.join(target, ".cache/sqlite-wasm/fingerprint.json")
  );
}

async function unpackSnapshot(archive, destination) {
  await mkdir(destination, { recursive: true });
  runCommand("tar", ["-xf", path.resolve(archive), "-C", destination], root);
  return destination;
}

function runCommand(command, args, cwd, extraEnv = {}, timeout = 30 * 60 * 1000) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`
    );
  return result;
}

async function fileDigest(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--smoke") result.smoke = true;
    else if (key === "--prepared") result.prepared = true;
    else if (key === "--keep-scratch") result.keepScratch = true;
    else if (key === "--baseline-dir") result.baselineDir = args[++index];
    else if (key === "--current-dir") result.currentDir = args[++index];
    else if (key === "--baseline-tar") result.baselineTar = args[++index];
    else if (key === "--current-tar") result.currentTar = args[++index];
    else if (key === "--output-dir") result.outputDir = args[++index];
    else throw new Error(`Unknown benchmark option ${key}`);
  }
  return result;
}

if (pathToFileURL(entry).href === import.meta.url) await main();
