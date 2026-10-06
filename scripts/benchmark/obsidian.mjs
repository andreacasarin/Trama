import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { installPlugin } from "../install-plugin.mjs";
import { startSimpleFixtureProvider } from "./fixture-provider.mjs";

const runFile = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputRoot = path.join(root, ".artifacts/benchmarks");
const vaultRoot = path.join(root, ".artifacts/test-vaults/benchmark");
const archiveRoot = path.join(root, ".artifacts/benchmarks/archive");
export const benchmarkVaultName = "Trama Benchmark Vault";
export const benchmarkVaultPath = path.join(vaultRoot, benchmarkVaultName);
const markerVersion = "trama-simple-benchmark-v1";
const reportName = ".trama-benchmark-report.json";
const markerName = ".trama-benchmark-vault";
const noteCount = 3000;
const corpusSha256 = "66d061b6c61c157587bf1dace04c6e72e7b0c5d3f8dd44393699d3b50f7b1c8a";
const providerPort = 18765;
const providerEndpoint = `http://127.0.0.1:${providerPort}/v1`;
const providerModel = "trama-benchmark-fixture-v1";
const readinessTimeoutMs = 90_000;
const cliPathStages = new Set([
  "initial-idle",
  "post-restore-idle",
  "post-reload-idle",
  "report-archive",
  "corpus-restore",
  "reload",
  "command-poll",
  "debug-attach",
  "benchmark-dispatch",
  "console-capture",
]);
const retryablePathClasses = new Set(["empty", "known-error-prefix", "uncaught-prefix"]);
const waitableMaintenanceLanes = new Set(["adoption", "update", "rebuild", "automatic"]);
const safeSignals = new Set(["SIGINT", "SIGTERM", "SIGKILL"]);
const correctnessFields = [
  "corpusNoteCount",
  "corpusPaths",
  "coldIndex",
  "cacheCleared",
  "indexedAllNotes",
  "semanticReady",
  "lexicalSentinel",
  "hybridSentinel",
  "relatedSentinel",
  "cacheShardsPublished",
  "cacheShardHashesValid",
  "cacheShardCheckStable",
];
const readinessEval =
  "JSON.stringify((()=>{const p=app.plugins.plugins.trama;return {pluginPresent:!!p,loadResult:p?.indexLoadResult,running:p?.benchmarkRunning,resetting:p?.benchmarkResetting,lane:p?.maintenance?.snapshot?.lane,timeOrigin:performance.timeOrigin}})())";
export const benchmarkDispatchEval = `JSON.stringify((()=>{const p=app.plugins.plugins.trama;const exact=app.vault.getName()===${JSON.stringify(benchmarkVaultName)}&&app.vault.adapter.getBasePath()===${JSON.stringify(benchmarkVaultPath)};if(!exact||!p||p.indexLoadResult!==true||p.benchmarkRunning!==false||p.benchmarkResetting!==false)return {invoked:false,running:p?.benchmarkRunning===true};const invoked=app.commands.executeCommandById("trama:run-obsidian-benchmark");return {invoked:invoked===true,running:p.benchmarkRunning===true}})())`;
const runCliCommand = async (command, parameters = []) =>
  runFile("obsidian", benchmarkCliArgs(benchmarkVaultName, command, parameters), {
    cwd: root,
    timeout: 30_000,
    killSignal: "SIGKILL",
  });

function childProcessStatus(error) {
  const signal = safeSignals.has(error?.signal) ? error.signal : "other";
  return {
    exitCode: Number.isInteger(error?.code) ? error.code : null,
    signal,
    timedOut: error?.code === "ETIMEDOUT" || (error?.killed === true && signal === "SIGKILL"),
  };
}

function childProcessFailure(label, stage, error) {
  const status = childProcessStatus(error);
  return new Error(
    `${label} failed at ${stage}: exitCode=${status.exitCode}, signal=${status.signal}, timedOut=${status.timedOut}.`
  );
}

export function childErrorObservation(stage, error) {
  const status = childProcessStatus(error);
  const signal =
    error?.signal === null || error?.signal === undefined
      ? null
      : safeSignals.has(error.signal)
        ? error.signal
        : "other";
  const message =
    typeof error?.message === "string"
      ? error.message.replace(/(?:[A-Za-z]:\\|\/)[^\s"'<>]+/g, "<path>").slice(0, 400)
      : "";
  return {
    stage,
    error: {
      name: typeof error?.name === "string" ? error.name : "Error",
      message,
      code: typeof error?.code === "string" || Number.isInteger(error?.code) ? error.code : null,
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      signal,
      killed: error?.killed === true,
      timedOut: status.timedOut,
    },
    stdout: typeof error?.stdout === "string" ? error.stdout : "",
    stderr: typeof error?.stderr === "string" ? error.stderr : "",
  };
}

const cli = async (command, parameters = [], stage = command) => {
  if (command !== "vault") await verifyCliTarget(benchmarkVaultPath, benchmarkVaultName, stage);
  try {
    return await runCliCommand(command, parameters);
  } catch (error) {
    const failure = childProcessFailure(`${command} CLI`, stage, error);
    failure.cliResult = childErrorObservation(stage, error);
    failure.cliArtifact = await saveCliResponse(stage, failure.cliResult);
    throw failure;
  }
};

export function benchmarkCliArgs(vaultName, command, parameters = []) {
  if (vaultName !== benchmarkVaultName) throw new Error("Refusing a non-benchmark vault target.");
  const permitted =
    (command === "vault" && parameters.length === 1 && parameters[0] === "info=path") ||
    (command === "reload" && parameters.length === 0) ||
    (command === "eval" &&
      parameters.length === 1 &&
      [`code=${readinessEval}`, `code=${benchmarkDispatchEval}`].includes(parameters[0])) ||
    (command === "dev:debug" && parameters.length === 1 && parameters[0] === "on") ||
    (command === "dev:debug" && parameters.length === 1 && parameters[0] === "off") ||
    (command === "dev:console" &&
      parameters.length === 2 &&
      ["level=info", "level=error"].includes(parameters[0]) &&
      parameters[1] === "limit=2000") ||
    (command === "command" &&
      parameters.length === 1 &&
      parameters[0] === "id=trama:run-obsidian-benchmark") ||
    (command === "commands" && parameters.length === 1 && parameters[0] === "filter=trama");
  if (!permitted) throw new Error("Refusing an unscoped or unsupported CLI command.");
  return [`vault=${vaultName}`, command, ...parameters];
}

const exists = async (file) =>
  access(file).then(
    () => true,
    () => false
  );
const corpusArtifact = path.join(outputRoot, "simple-corpus-v1.json");

async function ensureCorpusArtifact() {
  if ((await exists(outputRoot)) && (await realpath(outputRoot)) !== outputRoot)
    throw new Error("Refusing a symlinked benchmark artifact directory.");
  if (await exists(corpusArtifact)) {
    if (
      (await lstat(corpusArtifact)).isSymbolicLink() ||
      (await realpath(corpusArtifact)) !== corpusArtifact
    )
      throw new Error("Refusing a symlinked benchmark corpus artifact.");
    return JSON.parse(await readFile(corpusArtifact, "utf8"));
  }
  await mkdir(outputRoot, { recursive: true });
  if ((await realpath(outputRoot)) !== outputRoot)
    throw new Error("Refusing a symlinked benchmark artifact directory.");
  const bundle = path.join(outputRoot, ".simple-corpus-generator.mjs");
  if (
    (await exists(bundle)) &&
    ((await lstat(bundle)).isSymbolicLink() || (await realpath(bundle)) !== bundle)
  )
    throw new Error("Refusing a symlinked benchmark generator bundle.");
  await build({
    entryPoints: [path.join(root, "test-vaults/benchmark/generator.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    tsconfig: path.join(root, "tsconfig.json"),
  });
  const generator = await import(`${pathToFileURL(bundle).href}?v=${Date.now()}`);
  const corpus = generator.createSimpleBenchmarkCorpus();
  if (
    corpus.notes.length !== noteCount ||
    corpus.sha256 !== corpusSha256 ||
    corpus.notes.some((note) => note.content.length !== 400)
  )
    throw new Error("Simple benchmark corpus must contain exactly 3,000 400-character notes.");
  await writeFile(corpusArtifact, `${JSON.stringify(corpus)}\n`, { flag: "wx" });
  return corpus;
}

function digestCorpus(notes) {
  const hash = createHash("sha256");
  for (const note of notes) {
    for (const value of [note.path, note.content]) {
      const bytes = Buffer.from(value, "utf8");
      const length = Buffer.alloc(4);
      length.writeUInt32LE(bytes.length);
      hash.update(length).update(bytes);
    }
  }
  return hash.digest("hex");
}

async function rejectSymlinks(file) {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || (await realpath(file)) !== file)
    throw new Error("Refusing a symlink in the benchmark vault.");
  if (stat.isDirectory())
    for (const name of await readdir(file)) await rejectSymlinks(path.join(file, name));
}

export async function validateMarkedVaultRoot(
  vaultPath = benchmarkVaultPath,
  expectedName = benchmarkVaultName
) {
  if (vaultPath !== benchmarkVaultPath || expectedName !== benchmarkVaultName)
    throw new Error("Refusing a vault outside the exact benchmark output path.");
  if ((await realpath(vaultRoot)) !== vaultRoot || (await realpath(vaultPath)) !== vaultPath)
    throw new Error("Refusing a symlinked benchmark vault path.");
  const markerPath = path.join(vaultPath, markerName);
  const markerStat = await lstat(markerPath);
  if (markerStat.isSymbolicLink() || (await realpath(markerPath)) !== markerPath)
    throw new Error("Refusing a symlinked benchmark marker.");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  if (
    marker.version !== markerVersion ||
    marker.vaultName !== benchmarkVaultName ||
    marker.expectedPath !== benchmarkVaultPath ||
    marker.noteCount !== noteCount ||
    marker.corpusSha256 !== corpusSha256
  )
    throw new Error("Invalid generated benchmark marker.");
  return marker;
}

export async function validateGeneratedVault(
  vaultPath = benchmarkVaultPath,
  expectedName = benchmarkVaultName
) {
  const marker = await validateMarkedVaultRoot(vaultPath, expectedName);
  await rejectSymlinks(vaultPath);
  return marker;
}

export async function prepareVault() {
  const corpus = await ensureCorpusArtifact();
  if (
    corpus.notes.length !== noteCount ||
    corpus.sha256 !== corpusSha256 ||
    digestCorpus(corpus.notes) !== corpus.sha256
  )
    throw new Error("Prepared simple benchmark corpus failed its digest check.");
  await mkdir(vaultRoot, { recursive: true });
  if ((await realpath(vaultRoot)) !== vaultRoot)
    throw new Error("Refusing a symlinked benchmark vault root.");
  if (await exists(benchmarkVaultPath)) {
    const marker = await validateGeneratedVault();
    if (marker.corpusSha256 !== corpus.sha256) throw new Error("Prepared corpus identity changed.");
    await refreshFixtureEmbeddingSettings(benchmarkVaultPath, benchmarkVaultName);
    return { vaultPath: benchmarkVaultPath, vaultName: benchmarkVaultName, marker };
  }
  await mkdir(path.join(benchmarkVaultPath, ".obsidian/plugins/trama"), { recursive: true });
  await writeCorpus(corpus.notes);
  const marker = {
    version: markerVersion,
    vaultName: benchmarkVaultName,
    expectedPath: benchmarkVaultPath,
    noteCount,
    corpusSha256: corpus.sha256,
  };
  await writeFile(
    path.join(benchmarkVaultPath, markerName),
    `${JSON.stringify(marker, null, 2)}\n`
  );
  const dataPath = path.join(benchmarkVaultPath, ".obsidian/plugins/trama/data.json");
  const settings = {
    schemaVersion: 6,
    diagnosticsMode: "performance",
    automaticMaintenance: false,
    publicationDirectory: "Trama/index",
    lente: { searchMethod: "hybrid", automaticSearches: false },
    filo: { excludedPaths: [] },
    embedding: {
      endpoint: providerEndpoint,
      modelId: providerModel,
      dimensions: 768,
      batchSize: 32,
    },
    chat: { endpoint: providerEndpoint, modelId: providerModel },
  };
  await writeFile(dataPath, `${JSON.stringify(settings, null, 2)}\n`);
  await validateGeneratedVault();
  return { vaultPath: benchmarkVaultPath, vaultName: benchmarkVaultName, marker };
}

export function withFixtureEmbeddingSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("Benchmark plugin settings must be an object.");
  const embedding = settings.embedding;
  if (!embedding || typeof embedding !== "object" || Array.isArray(embedding))
    throw new Error("Benchmark embedding settings must be an object.");
  return {
    ...settings,
    embedding: {
      ...embedding,
      endpoint: providerEndpoint,
      modelId: providerModel,
    },
  };
}

export async function refreshFixtureEmbeddingSettings(
  vaultPath = benchmarkVaultPath,
  vaultName = benchmarkVaultName
) {
  await validateGeneratedVault(vaultPath, vaultName);
  const dataPath = path.join(vaultPath, ".obsidian/plugins/trama/data.json");
  const settings = JSON.parse(await readFile(dataPath, "utf8"));
  const updated = withFixtureEmbeddingSettings(settings);
  if (JSON.stringify(updated) !== JSON.stringify(settings))
    await writeFile(dataPath, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

async function writeCorpus(notes) {
  const notesRoot = path.join(benchmarkVaultPath, "notes");
  await rm(notesRoot, { recursive: true, force: true });
  await mkdir(notesRoot, { recursive: true });
  for (const note of notes) {
    if (!/^notes\/\d{4}\.md$/.test(note.path)) throw new Error("Unsafe generated note path.");
    await writeFile(path.join(benchmarkVaultPath, note.path), note.content);
  }
}

export async function installBenchmarkPlugin(
  vaultPath = benchmarkVaultPath,
  vaultName = benchmarkVaultName,
  install = installPlugin
) {
  await validateGeneratedVault(vaultPath, vaultName);
  const pluginsFile = path.join(vaultPath, ".obsidian/community-plugins.json");
  const existing = (await exists(pluginsFile))
    ? JSON.parse(await readFile(pluginsFile, "utf8"))
    : [];
  if (!Array.isArray(existing) || existing.some((id) => id !== "trama"))
    throw new Error("Refusing to change non-benchmark community plugin configuration.");
  await install({ vaultPath, preserveExistingFiles: true });
  await validateGeneratedVault(vaultPath, vaultName);
  await writeFile(pluginsFile, '["trama"]\n');
}

export async function verifyCliTarget(
  vaultPath = benchmarkVaultPath,
  vaultName = benchmarkVaultName,
  stage = "initial-idle",
  invoke = runCliCommand
) {
  if (!cliPathStages.has(stage)) throw new Error("Unsupported benchmark CLI path stage.");
  await validateMarkedVaultRoot(vaultPath, vaultName);
  let result;
  try {
    result = await invoke("vault", ["info=path"]);
  } catch (error) {
    const status = childProcessStatus(error);
    const observation = childErrorObservation(`path-proof-${stage}`, error);
    observation.stdout = observation.stdout
      .slice(0, 2000)
      .replace(/(?:[A-Za-z]:\\|\/)[^\s"'<>]+/g, "<path>");
    observation.stderr = observation.stderr
      .slice(0, 2000)
      .replace(/(?:[A-Za-z]:\\|\/)[^\s"'<>]+/g, "<path>");
    const artifact = await saveCliResponse(`path-proof-${stage}`, observation);
    const failure = new Error(
      `Obsidian CLI path proof failed at ${stage}: cli-error (exitCode=${status.exitCode}, signal=${status.signal}, timedOut=${status.timedOut}); response saved at ${artifact}.`
    );
    failure.pathProof = { stage, classification: "cli-error", ...status, artifact };
    throw failure;
  }
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  if (stdout.trim() !== vaultPath) {
    const trimmed = stdout.trim();
    const lines = trimmed ? trimmed.split(/\r?\n/) : [];
    const classification = !trimmed
      ? "empty"
      : lines.length > 1
        ? "multiline"
        : /^error\b/i.test(trimmed)
          ? "known-error-prefix"
          : /^(?:uncaught|unhandled)\b/i.test(trimmed)
            ? "uncaught-prefix"
            : path.isAbsolute(trimmed)
              ? "single-absolute"
              : "other";
    const stderr = typeof result?.stderr === "string" ? result.stderr : "";
    const boundedOutput = (value) =>
      value.slice(0, 2000).replace(/(?:[A-Za-z]:\\|\/)[^\s"'<>]+/g, "<path>");
    const artifact = await saveCliResponse(`path-proof-${stage}`, {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: boundedOutput(stdout),
      stderr: boundedOutput(stderr),
    });
    const failure = new Error(
      `Obsidian CLI path proof failed at ${stage}: ${classification} (${Buffer.byteLength(stdout)} bytes); response saved at ${artifact}.`
    );
    failure.pathProof = { stage, classification, stdoutBytes: Buffer.byteLength(stdout), artifact };
    throw failure;
  }
}

function isTransientPathFailure(error, stage) {
  return (
    error?.pathProof?.stage === stage && retryablePathClasses.has(error.pathProof.classification)
  );
}

export async function waitForBenchmarkCommand({
  listCommands = () => cli("commands", ["filter=trama"], "command-poll"),
  wait = delay,
  now = Date.now,
  timeoutMs = readinessTimeoutMs,
} = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    let output;
    try {
      output = await listCommands();
    } catch (error) {
      if (!isTransientPathFailure(error, "command-poll")) throw error;
      await wait(1000);
      continue;
    }
    if (output.stdout.split(/\r?\n/).some((line) => line.trim() === "trama:run-obsidian-benchmark"))
      return;
    await wait(1000);
  }
  throw new Error("Trama benchmark command did not register before the readiness deadline.");
}

export async function readiness(stage = "initial-idle") {
  const output = await cli("eval", [`code=${readinessEval}`], stage);
  try {
    return parseReadinessStdout(output.stdout);
  } catch {
    throw new Error(`Readiness eval returned invalid JSON at ${stage}.`);
  }
}

export function parseReadinessStdout(stdout) {
  let serialized = stdout.trim();
  if (serialized.startsWith("=>")) {
    const wrapper = /^=>\s+/.exec(serialized);
    if (!wrapper) throw new Error("Invalid readiness CLI output wrapper.");
    serialized = serialized.slice(wrapper[0].length);
  }
  if (!serialized.startsWith("{")) throw new Error("Invalid readiness CLI output.");
  const parsed = JSON.parse(serialized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid readiness CLI state.");
  return parsed;
}

export function assertBenchmarkDispatchReceipt(stdout) {
  const receipt = parseReadinessStdout(stdout);
  if (receipt.invoked !== true || receipt.running !== true)
    throw new Error("Benchmark dispatch did not start.");
  return receipt;
}

export function benchmarkIdleFailures(state) {
  const failures = [];
  if (state.pluginPresent !== true) failures.push("plugin");
  if (state.loadResult === false) failures.push("load-failed");
  else if (state.loadResult !== true)
    failures.push(
      state.loadResult === null || state.loadResult === undefined ? "load-pending" : "load-unknown"
    );
  if (state.running !== false) failures.push("running-or-unknown");
  if (state.resetting !== false) failures.push("resetting-or-unknown");
  if (state.lane !== "idle") failures.push("lane");
  return failures;
}

export async function verifyBenchmarkIdle(
  vaultPath = benchmarkVaultPath,
  vaultName = benchmarkVaultName,
  stage = "initial-idle",
  {
    verifyPath = (name) => verifyCliTarget(vaultPath, vaultName, name),
    readReadiness = readiness,
    wait = delay,
    now = Date.now,
    afterTimeOrigin,
  } = {}
) {
  process.stdout.write(`Benchmark readiness started (${stage}).\n`);
  const deadline = now() + readinessTimeoutMs;
  let lastLane;
  let lastTimeOrigin;
  let observedNewEpoch = stage !== "post-reload-idle";
  let loggedAfterEpoch = false;
  if (stage === "post-reload-idle" && !Number.isFinite(afterTimeOrigin))
    throw new Error("Benchmark renderer epoch before reload is unavailable.");
  let pathVerified = false;
  while (now() < deadline && !pathVerified) {
    try {
      await verifyPath(stage);
      pathVerified = true;
    } catch (error) {
      if (stage !== "post-reload-idle" || !isTransientPathFailure(error, stage)) throw error;
      await wait(Math.min(1000, Math.max(0, deadline - now())));
    }
  }
  if (!pathVerified)
    throw new Error(
      "Exact benchmark window CLI path proof did not succeed before the readiness deadline."
    );

  while (now() < deadline) {
    let state;
    try {
      state = await readReadiness(stage);
    } catch (error) {
      if (stage !== "post-reload-idle" || !isTransientPathFailure(error, stage)) throw error;
      await wait(Math.min(1000, Math.max(0, deadline - now())));
      continue;
    }
    if (stage === "post-reload-idle") {
      if (!Number.isFinite(state.timeOrigin))
        throw new Error("Benchmark renderer epoch after reload is invalid.");
      lastTimeOrigin = state.timeOrigin;
      if (!loggedAfterEpoch) {
        loggedAfterEpoch = true;
        process.stdout.write(
          `Benchmark renderer epoch after reload observed: ${state.timeOrigin}; newer=${state.timeOrigin > afterTimeOrigin}.\n`
        );
      }
      if (state.timeOrigin <= afterTimeOrigin) {
        await wait(Math.min(1000, Math.max(0, deadline - now())));
        continue;
      }
      observedNewEpoch = true;
      if (state.pluginPresent === false) {
        await wait(Math.min(1000, Math.max(0, deadline - now())));
        continue;
      }
      if (state.pluginPresent !== true)
        throw new Error("Exact benchmark window plugin state after reload is invalid.");
      if (state.loadResult === null || state.loadResult === undefined) {
        await wait(Math.min(1000, Math.max(0, deadline - now())));
        continue;
      }
      if (state.loadResult === false)
        throw new Error("Exact benchmark window is not loaded and idle: load-failed.");
      if (state.loadResult !== true)
        throw new Error("Exact benchmark window load state after reload is invalid.");
      if (state.running !== false || state.resetting !== false)
        throw new Error("Exact benchmark window is not loaded and idle: running-or-resetting.");
      if (state.lane === "idle") {
        process.stdout.write(`Benchmark readiness passed (${stage}).\n`);
        return state;
      }
      if (!waitableMaintenanceLanes.has(state.lane))
        throw new Error("Exact benchmark window has an unknown maintenance lane.");
      process.stdout.write(
        `Benchmark post-reload window is loaded; maintenance lane=${state.lane}.\n`
      );
      return state;
    }
    const failures = benchmarkIdleFailures(state).filter(
      (failure) => failure !== "lane" && failure !== "load-pending"
    );
    if (failures.length)
      throw new Error(`Exact benchmark window is not loaded and idle: ${failures.join(", ")}.`);
    if (state.lane === "idle" && state.loadResult === true) {
      process.stdout.write(`Benchmark readiness passed (${stage}).\n`);
      return state;
    }
    if (!waitableMaintenanceLanes.has(state.lane))
      throw new Error("Exact benchmark window has an unknown maintenance lane.");
    lastLane = state.lane;
    await wait(Math.min(1000, Math.max(0, deadline - now())));
  }
  if (!observedNewEpoch)
    throw new Error(
      `Exact benchmark renderer did not reload before the readiness deadline; renderer epoch: ${lastTimeOrigin}.`
    );
  throw new Error(
    `Exact benchmark window maintenance did not become idle before the readiness deadline; last lane: ${lastLane}; renderer epoch: ${lastTimeOrigin}.`
  );
}

export async function attachBenchmarkDebugger({
  invoke = (command, parameters, stage) => cli(command, parameters, stage),
  wait = delay,
  now = Date.now,
} = {}) {
  const off = await invoke("dev:debug", ["off"], "debug-attach");
  const offArtifact = await saveCliResponse("debug-detach", {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: off.stdout,
    stderr: off.stderr,
  });
  process.stdout.write(
    `Debugger detach response saved at ${offArtifact}; stdout=${JSON.stringify(off.stdout.slice(0, 1000))}; stderr=${JSON.stringify(off.stderr.slice(0, 1000))}\n`
  );
  if (
    !/debugger.*detached/i.test(off.stdout.trim()) ||
    !/capture stopped/i.test(off.stdout.trim()) ||
    off.stderr.trim()
  )
    throw new Error("Performance diagnostics debugger did not detach cleanly.");

  const deadline = now() + readinessTimeoutMs;
  while (now() < deadline) {
    const debug = await invoke("dev:debug", ["on"], "debug-attach");
    const artifact = await saveCliResponse("debug-attach", {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: debug.stdout,
      stderr: debug.stderr,
    });
    process.stdout.write(
      `Debugger attach response saved at ${artifact}; stdout=${JSON.stringify(debug.stdout.slice(0, 1000))}; stderr=${JSON.stringify(debug.stderr.slice(0, 1000))}\n`
    );
    if (
      /debugger.*attached/i.test(debug.stdout.trim()) &&
      /capture started/i.test(debug.stdout.trim()) &&
      !debug.stderr.trim()
    )
      return;
    if (
      debug.stdout.trim() !==
        'Error: Command "dev:debug" not found. It may require a plugin to be enabled.' ||
      debug.stderr.trim()
    )
      throw new Error("Performance diagnostics debugger did not attach.");
    await wait(Math.min(1000, Math.max(0, deadline - now())));
  }
  throw new Error("Performance diagnostics debugger did not attach before the readiness deadline.");
}

export async function reloadBenchmarkWindow(
  vaultPath,
  {
    verifyIdle = verifyBenchmarkIdle,
    reload = () => cli("reload", [], "reload"),
    waitForCommand = waitForBenchmarkCommand,
  } = {}
) {
  const beforeReload = await verifyIdle(vaultPath, benchmarkVaultName, "post-restore-idle");
  const beforeReloadEpoch = beforeReload?.timeOrigin;
  if (!Number.isFinite(beforeReloadEpoch))
    throw new Error("Benchmark renderer epoch before reload is unavailable.");
  process.stdout.write(`Benchmark renderer epoch before reload: ${beforeReloadEpoch}.\n`);
  process.stdout.write("Benchmark reload started.\n");
  await reload();
  await waitForCommand();
  const afterReload = await verifyIdle(vaultPath, benchmarkVaultName, "post-reload-idle", {
    afterTimeOrigin: beforeReloadEpoch,
  });
  process.stdout.write(
    `Benchmark reload completed with renderer epoch ${afterReload.timeOrigin} after ${beforeReloadEpoch}; readiness passed.\n`
  );
}

async function restoreGeneratedMarkdown(corpus) {
  const expected = new Set(corpus.notes.map((note) => note.path));
  const actual = [];
  async function walk(directory) {
    for (const name of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, name.name);
      if (name.isSymbolicLink())
        throw new Error("Refusing a symlink while restoring generated notes.");
      if (name.isDirectory()) await walk(file);
      else if (name.name.endsWith(".md"))
        actual.push(path.relative(benchmarkVaultPath, file).split(path.sep).join("/"));
    }
  }
  await walk(benchmarkVaultPath);
  if (actual.some((path) => !expected.has(path)) || actual.length !== expected.size)
    throw new Error("Benchmark vault contains Markdown outside the fixed generated corpus.");
  await writeCorpus(corpus.notes);
}

async function archivePreviousReport(marker) {
  const reportPath = path.join(benchmarkVaultPath, reportName);
  if (!(await exists(reportPath))) return;
  const reportStat = await lstat(reportPath);
  if (reportStat.isSymbolicLink() || (await realpath(reportPath)) !== reportPath)
    throw new Error("Refusing a symlinked benchmark report.");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (
    report.corpusSha256 !== marker.corpusSha256 ||
    typeof report.runId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(report.runId)
  )
    throw new Error("Existing benchmark report identity does not match this corpus.");
  await mkdir(archiveRoot, { recursive: true });
  if ((await realpath(archiveRoot)) !== archiveRoot)
    throw new Error("Refusing a symlinked benchmark report archive.");
  const destination = path.join(archiveRoot, `trama-simple-${report.runId}.json`);
  if (await exists(destination)) throw new Error("Benchmark report archive already exists.");
  await rename(reportPath, destination);
}

async function saveCliResponse(stage, response) {
  const diagnosticsRoot = path.join(outputRoot, "diagnostics");
  await mkdir(diagnosticsRoot, { recursive: true });
  const artifact = path.join(diagnosticsRoot, `${stage}-${randomUUID()}.json`);
  await writeFile(artifact, `${JSON.stringify({ stage, ...response }, null, 2)}\n`, { flag: "wx" });
  return artifact;
}

export async function runBenchmarkOnce({
  assertFreshReport,
  beforeDispatch = async () => {},
  dispatch,
  waitForReport,
  captureConsole,
  saveConsole,
  savePerformance,
}) {
  await assertFreshReport();
  await beforeDispatch();
  process.stdout.write("Benchmark dispatch started.\n");
  const dispatchResult = await dispatch();
  if (
    !dispatchResult ||
    typeof dispatchResult.stdout !== "string" ||
    typeof dispatchResult.stderr !== "string"
  )
    throw new Error("Benchmark CLI dispatch returned no bounded acknowledgment.");
  if (dispatchResult.exitCode !== undefined && dispatchResult.exitCode !== 0)
    throw new Error("Benchmark CLI dispatch failed before report wait.");
  const dispatchOutput = `${dispatchResult.stdout}\n${dispatchResult.stderr}`;
  if (
    /^\s*(?:Error|Uncaught)\b/im.test(dispatchOutput) ||
    /(?:command|id)[^\n]*not found/i.test(dispatchOutput)
  )
    throw new Error("Benchmark CLI returned an explicit dispatch error.");
  const report = await waitForReport();
  if (
    !report ||
    report.version !== "trama-simple-benchmark-report-v1" ||
    report.corpusSha256 !== corpusSha256 ||
    report.noteCount !== noteCount ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(report.runId) ||
    !["completed", "error"].includes(report.status)
  )
    throw new Error("No fresh benchmark report appeared before the 900-second benchmark deadline.");
  process.stdout.write(`Benchmark report received: ${report.runId} status=${report.status}.\n`);

  const performancePath = savePerformance ? await savePerformance(report) : undefined;
  const consoleText = await captureConsole(report);
  await saveConsole(report, consoleText);
  const finishMarkerPresent =
    consoleText.includes("[Trama] benchmark_finished") && consoleText.includes(report.runId);
  if (!finishMarkerPresent)
    throw new Error("Production console tail is missing the benchmark completion marker.");

  if (savePerformance) {
    const capture = report.performanceCapture;
    const records = capture?.records;
    if (
      capture?.complete !== true ||
      !Array.isArray(records) ||
      records.length > 10_000 ||
      Buffer.byteLength(records.map((record) => JSON.stringify(record)).join("\n")) +
        records.length >
        8 * 1024 * 1024
    )
      throw new Error(
        `Production performance record capture is missing, incomplete, or over its bound: ${performancePath}`
      );
    const operations = new Set(
      records
        .filter(
          (record) =>
            record?.tier === "performance" &&
            Number.isFinite(record.durationMs) &&
            record.durationMs >= 0
        )
        .map((record) => record.operation)
    );
    if (
      !["lexical", "semantic", "related", "publication"].every((operation) =>
        operations.has(operation)
      )
    )
      throw new Error(
        `Production performance records are missing required workflow operations: ${performancePath}`
      );
    if (
      !Number.isFinite(Date.parse(report.startedAt)) ||
      !Number.isFinite(Date.parse(report.finishedAt)) ||
      Date.parse(report.finishedAt) < Date.parse(report.startedAt)
    )
      throw new Error(
        `Benchmark report is missing valid workflow start/end timestamps: ${performancePath}`
      );
    const related = report.relatedLookup;
    if (
      !related ||
      !Array.isArray(related.results) ||
      related.results.length > 20 ||
      typeof related.semanticPartial !== "boolean" ||
      typeof related.maintenanceBefore !== "boolean" ||
      typeof related.maintenanceAfter !== "boolean" ||
      (related.unavailableReason !== undefined &&
        !["semantic-unavailable", "incomplete-vectors"].includes(related.unavailableReason)) ||
      !related.results.every(
        (result) => /^notes\/\d{4}\.md$/.test(result.path) && Number.isFinite(result.score)
      )
    )
      throw new Error("Benchmark report is missing bounded related lookup metadata.");
  }

  if (report.status !== "completed")
    throw new Error(`Benchmark reported failure: ${report.error ?? "unknown error"}`);
  if (!correctnessFields.every((field) => report.correctness?.[field] === true))
    throw new Error("Benchmark correctness checks did not all pass.");
  process.stdout.write(`Benchmark completed: ${report.runId}.\n`);
  return report;
}

async function captureLiveProgress() {
  const stateResponse = await cli("eval", [`code=${readinessEval}`], "console-capture");
  const stateArtifact = await saveCliResponse("live-status", {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: stateResponse.stdout,
    stderr: stateResponse.stderr,
  });
  const state = parseReadinessStdout(stateResponse.stdout);
  const safeState = {
    pluginPresent: state.pluginPresent === true,
    running: state.running === true ? true : state.running === false ? false : "unknown",
    resetting: state.resetting === true ? true : state.resetting === false ? false : "unknown",
    lane: ["idle", "adoption", "update", "rebuild", "automatic"].includes(state.lane)
      ? state.lane
      : "unknown",
  };
  const consoleResponse = await cli(
    "dev:console",
    ["level=error", "limit=2000"],
    "console-capture"
  );
  const consoleArtifact = await saveCliResponse("live-errors", {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: consoleResponse.stdout,
    stderr: consoleResponse.stderr,
  });
  process.stdout.write(
    `Live benchmark state: ${JSON.stringify(safeState)}; error console bytes=${Buffer.byteLength(consoleResponse.stdout)}; artifacts=${stateArtifact},${consoleArtifact}\n`
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--prepare"))
    throw new Error("Usage: node scripts/benchmark/obsidian.mjs [--prepare]");
  if (args[0] === "--prepare") {
    await runFile(process.execPath, ["scripts/generate-build-identity.mjs"], { cwd: root });
    await runFile(process.execPath, ["scripts/sqlite-wasm/build.mjs"], { cwd: root });
    await runFile(process.execPath, ["scripts/sqlite-wasm/verify.mjs"], { cwd: root });
    await runFile(process.execPath, ["esbuild.config.mjs", "production"], { cwd: root });
    const { vaultPath, vaultName } = await prepareVault();
    await installBenchmarkPlugin(vaultPath, vaultName);
    process.stdout.write(`Prepared ${vaultPath}. Open this exact vault in Obsidian.\n`);
    return;
  }

  process.stdout.write("Benchmark preflight started.\n");
  const marker = await validateGeneratedVault();
  const corpus = JSON.parse(await readFile(corpusArtifact, "utf8"));
  if (corpus.sha256 !== marker.corpusSha256 || digestCorpus(corpus.notes) !== marker.corpusSha256)
    throw new Error("Benchmark corpus artifact does not match the marked vault.");
  process.stdout.write("Benchmark preflight passed for the marked 3,000-note corpus.\n");
  const provider = await startSimpleFixtureProvider(providerPort, providerModel);
  try {
    await verifyBenchmarkIdle(benchmarkVaultPath, benchmarkVaultName, "initial-idle");
    await verifyCliTarget(benchmarkVaultPath, benchmarkVaultName, "report-archive");
    await archivePreviousReport(marker);
    await verifyCliTarget(benchmarkVaultPath, benchmarkVaultName, "corpus-restore");
    await restoreGeneratedMarkdown(corpus);
    await reloadBenchmarkWindow(benchmarkVaultPath);
    const reportPath = path.join(benchmarkVaultPath, reportName);
    const report = await runBenchmarkOnce({
      assertFreshReport: async () => {
        if (await exists(reportPath)) throw new Error("Benchmark report exists before dispatch.");
      },
      beforeDispatch: attachBenchmarkDebugger,
      dispatch: async () => {
        let result;
        try {
          result = await cli("eval", [`code=${benchmarkDispatchEval}`], "benchmark-dispatch");
        } catch (error) {
          if (error?.cliArtifact) {
            process.stdout.write(
              `Dispatch CLI failed; response saved at ${error.cliArtifact}: ${JSON.stringify(error.cliResult.stdout.slice(0, 1000))}\n`
            );
          }
          throw error;
        }
        const response = {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: result.stdout,
          stderr: result.stderr,
        };
        const artifact = await saveCliResponse("benchmark-dispatch", response);
        process.stdout.write(
          `Dispatch CLI response saved at ${artifact}; stdout=${JSON.stringify(response.stdout.slice(0, 1000))}; stderr=${JSON.stringify(response.stderr.slice(0, 1000))}\n`
        );
        assertBenchmarkDispatchReceipt(response.stdout);
        return response;
      },
      waitForReport: async () => {
        const deadline = Date.now() + 900_000;
        const progressAt = Date.now() + 15_000;
        let progressCaptured = false;
        while (Date.now() < deadline) {
          if (await exists(reportPath)) return JSON.parse(await readFile(reportPath, "utf8"));
          if (!progressCaptured && Date.now() >= progressAt) {
            progressCaptured = true;
            try {
              await captureLiveProgress();
            } catch (error) {
              process.stdout.write(
                `Live benchmark status capture failed safely: ${error instanceof Error ? error.message : "unknown error"}\n`
              );
            }
          }
          await delay(1000);
        }
        return undefined;
      },
      captureConsole: async () =>
        (await cli("dev:console", ["level=info", "limit=2000"], "console-capture")).stdout,
      saveConsole: async (freshReport, consoleText) => {
        const consolePath = path.join(outputRoot, `trama-simple-${freshReport.runId}.console.log`);
        await writeFile(consolePath, consoleText, { flag: "wx" });
        process.stdout.write(
          `Report ${freshReport.runId}: ${freshReport.status}; production console capture saved.\n`
        );
      },
      savePerformance: async (freshReport) => {
        const performancePath = path.join(
          outputRoot,
          `trama-simple-${freshReport.runId}.performance.jsonl`
        );
        const records = freshReport.performanceCapture?.records;
        const content = Array.isArray(records)
          ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
          : "";
        await writeFile(performancePath, content, { flag: "wx" });
        process.stdout.write(`Production performance records saved: ${performancePath}.\n`);
        return performancePath;
      },
    });
    return report;
  } finally {
    await provider.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
