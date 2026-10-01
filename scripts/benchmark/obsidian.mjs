import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { installPlugin } from "../install-plugin.mjs";
import { startFixtureProvider } from "./fixture-provider.mjs";

const runFile = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputRoot = path.join(root, ".artifacts/benchmarks");
const vaultRoot = path.join(root, ".artifacts/test-vaults/benchmark");
export const benchmarkVaultName = "Trama Benchmark Vault";
const profiles = new Set(["trama-small", "trama-10k", "trama-large"]);
const markerVersion = "trama-obsidian-vault-v1";
const reportVersion = "trama-obsidian-report-v2";
const profile = process.env.TRAMA_BENCHMARK_PROFILE ?? "trama-small";
const timeoutMs = Number(process.env.TRAMA_BENCHMARK_TIMEOUT_MS ?? "900000");

const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function benchmarkVaultPath(profileId, runId, base = vaultRoot) {
  if (!profiles.has(profileId)) throw new Error(`Invalid benchmark profile: ${profileId}`);
  if (!runIdPattern.test(runId)) throw new Error("Invalid benchmark run ID.");
  return path.join(base, benchmarkVaultName);
}

export function benchmarkCliArgs(vaultName, command, parameters = []) {
  if (vaultName !== benchmarkVaultName) throw new Error("Refusing a non-benchmark vault target.");
  const permitted =
    (command === "vault" && parameters.length === 1 && parameters[0] === "info=path") ||
    (command === "plugins:restrict" && parameters.length === 0) ||
    (command === "plugin:enable" && parameters.length === 1 && parameters[0] === "id=trama") ||
    (command === "plugin:reload" && parameters.length === 1 && parameters[0] === "id=trama") ||
    (command === "command" &&
      parameters.length === 1 &&
      parameters[0] === "id=trama:run-obsidian-benchmark");
  if (!permitted) throw new Error("Refusing an unscoped or unsupported CLI command.");
  return [`vault=${vaultName}`, command, ...parameters];
}

async function exists(file) {
  return access(file).then(
    () => true,
    () => false
  );
}

async function pathEntry(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function validateGeneratedVault(vaultPath, expectedName) {
  if (vaultPath !== path.join(vaultRoot, benchmarkVaultName) || expectedName !== benchmarkVaultName)
    throw new Error("Refusing a vault outside the benchmark output directory.");
  if ((await realpath(vaultRoot)) !== vaultRoot || (await realpath(vaultPath)) !== vaultPath)
    throw new Error("Refusing a symlinked benchmark vault path.");
  for (const candidate of [vaultRoot, vaultPath])
    if ((await lstat(candidate)).isSymbolicLink())
      throw new Error("Refusing a symlinked benchmark vault path.");
  async function validateTree(directory) {
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink() || (await realpath(file)) !== file)
        throw new Error("Refusing a symlinked benchmark install path inside the generated vault.");
      if (stat.isDirectory()) await validateTree(file);
    }
  }
  await validateTree(vaultPath);
  for (const name of [".obsidian", ".trama-benchmark-vault"]) {
    const candidate = path.join(vaultPath, name);
    if ((await lstat(candidate)).isSymbolicLink() || (await realpath(candidate)) !== candidate)
      throw new Error("Refusing a symlink inside the generated vault.");
  }
  const marker = JSON.parse(await readFile(path.join(vaultPath, ".trama-benchmark-vault"), "utf8"));
  if (
    marker.version !== markerVersion ||
    marker.vaultName !== expectedName ||
    marker.expectedPath !== vaultPath ||
    !runIdPattern.test(marker.runId) ||
    !profiles.has(marker.profile)
  )
    throw new Error("Refusing an unmarked or invalid benchmark vault.");
  return marker;
}

async function validateInstallPath(vaultPath, vaultName) {
  await validateGeneratedVault(vaultPath, vaultName);
  for (const relative of [
    ".obsidian/plugins",
    ".obsidian/plugins/trama",
    ".obsidian/community-plugins.json",
    ".obsidian/plugins/trama/data.json",
  ]) {
    const candidate = path.join(vaultPath, relative);
    const entry = await pathEntry(candidate);
    if (!entry) continue;
    if (entry.isSymbolicLink() || (await realpath(candidate)) !== candidate)
      throw new Error(`Refusing a symlinked benchmark install path: ${relative}`);
  }
}

export async function installBenchmarkPlugin(vaultPath, vaultName, install = installPlugin) {
  await validateInstallPath(vaultPath, vaultName);
  const pluginsFile = path.join(vaultPath, ".obsidian/community-plugins.json");
  const existing = (await pathEntry(pluginsFile))
    ? JSON.parse(await readFile(pluginsFile, "utf8"))
    : [];
  if (!Array.isArray(existing) || existing.some((id) => id !== "trama"))
    throw new Error("Refusing to change non-benchmark community plugin configuration.");
  await validateInstallPath(vaultPath, vaultName);
  await install({ vaultPath, preserveExistingFiles: true });
  await validateInstallPath(vaultPath, vaultName);
  await writeFile(pluginsFile, '["trama"]\n');
}

export async function checkCorpus(vaultPath, workload, initialOnly = false) {
  const allowed = new Map(workload.notes.map((note) => [note.path, new Set([note.content])]));
  for (const mutation of initialOnly ? [] : workload.mutations) {
    if (mutation.note) {
      const contents = allowed.get(mutation.path) ?? new Set();
      contents.add(mutation.note.content);
      allowed.set(mutation.path, contents);
    }
    if (mutation.to) allowed.set(mutation.to, allowed.get(mutation.path));
  }
  const seen = new Set();
  async function visit(directory, relative = "") {
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name);
      const entry = await lstat(file);
      if (entry.isSymbolicLink() || (await realpath(file)) !== file)
        throw new Error("Refusing a symlink in the benchmark corpus.");
      if (name === ".DS_Store") continue;
      const key = relative ? `${relative}/${name}` : name;
      if (entry.isDirectory()) await visit(file, key);
      else {
        if (!allowed.get(key)?.has(await readFile(file, "utf8")))
          throw new Error(`Unexpected or edited benchmark file: ${key}; refusing reset.`);
        seen.add(key);
      }
    }
  }
  for (const name of await readdir(vaultPath)) {
    if (
      [
        ".obsidian",
        ".trama",
        "Trama",
        ".trama-benchmark-vault",
        ".trama-benchmark-report.json",
        ".DS_Store",
      ].includes(name)
    )
      continue;
    if (!["00-special", "notes", "mutations"].includes(name))
      throw new Error("Unexpected benchmark vault content; refusing reset.");
    const file = path.join(vaultPath, name);
    if ((await lstat(file)).isSymbolicLink() || (await realpath(file)) !== file)
      throw new Error("Refusing a symlink in the benchmark corpus.");
    await visit(file, name);
  }
  if (initialOnly && seen.size !== workload.notes.length)
    throw new Error("Prepared benchmark corpus is incomplete; refusing reuse.");
}

async function archivePriorCorpus(vaultPath, marker) {
  const { workload } = await loadWorkload(marker.profile);
  await checkCorpus(vaultPath, workload);
  const archive = path.join(root, ".artifacts/test-vaults/archive", `benchmark-${marker.runId}`);
  const archiveRoot = path.dirname(archive);
  if ((await realpath(path.dirname(archiveRoot))) !== path.dirname(archiveRoot))
    throw new Error("Refusing a symlinked archive parent.");
  await mkdir(archiveRoot, { recursive: true });
  if ((await realpath(archiveRoot)) !== archiveRoot)
    throw new Error("Refusing a symlinked archive parent.");
  if (await exists(archive))
    throw new Error("Benchmark run archive already exists; refusing replacement.");
  await mkdir(archive, { recursive: true });
  if ((await realpath(archive)) !== archive) throw new Error("Refusing a symlinked archive.");
  await validateGeneratedVault(vaultPath, benchmarkVaultName);
  for (const name of [
    "00-special",
    "notes",
    "mutations",
    ".trama-benchmark-vault",
    ".trama-benchmark-report.json",
  ])
    if (await exists(path.join(vaultPath, name)))
      await rename(path.join(vaultPath, name), path.join(archive, name));
  process.stdout.write(`Archived prior benchmark corpus: ${archive}\n`);
}

async function loadWorkload(profileId) {
  const cache = path.join(outputRoot, ".cache");
  await mkdir(cache, { recursive: true });
  const outfile = path.join(cache, `generator-${randomUUID()}.mjs`);
  await build({
    entryPoints: [path.join(root, "test-vaults/benchmark/generator.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    tsconfig: path.join(root, "tsconfig.json"),
  });
  const generator = await import(pathToFileURL(outfile).href);
  const workload = generator.createWorkload(profileId);
  if (profileId === "trama-small") {
    for (const note of workload.notes) {
      const committed = await readFile(
        path.join(root, "test-vaults/benchmark/trama-small", note.path),
        "utf8"
      );
      if (committed !== note.content)
        throw new Error("Committed benchmark fixture differs from the fixed workload.");
    }
  }
  return { generator, workload };
}

export async function prepareVault() {
  if (!profiles.has(profile)) throw new Error(`Unknown profile: ${profile}`);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000)
    throw new Error("TRAMA_BENCHMARK_TIMEOUT_MS must be 1000..3600000.");
  await mkdir(outputRoot, { recursive: true });
  const runId = randomUUID();
  const vaultPath = benchmarkVaultPath(profile, runId);
  const vaultName = benchmarkVaultName;
  const { generator, workload } = await loadWorkload(profile);
  if (await exists(vaultPath)) {
    const current = await validateGeneratedVault(vaultPath, vaultName);
    const report = path.join(vaultPath, ".trama-benchmark-report.json");
    if (!(await exists(report))) {
      if (current.profile !== profile)
        throw new Error(
          "A different profile is pending; complete that run before switching profiles."
        );
      await checkCorpus(vaultPath, workload, true);
      return { vaultPath, vaultName, marker: current };
    }
    if ((await lstat(report)).isSymbolicLink() || (await realpath(report)) !== report)
      throw new Error("Refusing a symlinked benchmark report.");
    const priorReport = JSON.parse(await readFile(report, "utf8"));
    if (
      priorReport.runId !== current.runId ||
      priorReport.profile !== current.profile ||
      !["completed", "error", "timeout"].includes(priorReport.status)
    )
      throw new Error("Benchmark report identity mismatch; refusing reset.");
    await archivePriorCorpus(vaultPath, current);
  }
  await mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
  for (const note of workload.notes) {
    const destination = path.join(vaultPath, note.path);
    if (!destination.startsWith(`${vaultPath}${path.sep}`))
      throw new Error("Unsafe generated path.");
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, note.content);
  }
  const marker = {
    version: markerVersion,
    runId,
    vaultName,
    expectedPath: vaultPath,
    profile,
    noteCount: workload.profile.noteCount,
    targetChunks: workload.profile.targetChunks,
    sourceDigest: generator.workloadSourceDigest(workload),
    providerChallengeSha256: generator.deterministicProviderChallengeDigest(),
    queryVectorSha256: generator.workloadQueryVectorDigest(workload),
    mutations: workload.mutations
      .filter((mutation) => mutation.kind !== "unchanged")
      .map((mutation) => ({
        kind: mutation.kind,
        path: mutation.path,
        ...(mutation.to ? { to: mutation.to } : {}),
        ...(mutation.kind === "add" || mutation.kind === "modify"
          ? { content: mutation.note.content }
          : {}),
      })),
    timeoutMs,
  };
  await writeFile(
    path.join(vaultPath, ".trama-benchmark-vault"),
    `${JSON.stringify(marker, null, 2)}\n`
  );
  await validateGeneratedVault(vaultPath, vaultName);
  return { vaultPath, vaultName, marker };
}

export const REQUIRED_BENCHMARK_GATES = [
  "initialNoteCount",
  "initialOccurrenceCount",
  "semanticCachedNoProviderWork",
  "publicationCompleted",
  "publicationBytesPresent",
  "finalNoteCount",
  "finalOccurrenceCount",
  "semanticEligibleCount",
  "semanticHeadCount",
  "compatibleVectorCoverage",
  "semanticReady",
  "semanticConverged",
  "lexicalOracleMatches",
  "hybridOracleMatches",
  "relatedOracleMatches",
  "voceOracleMatches",
  "chatToolTurnCompleted",
];

export const REQUIRED_BENCHMARK_PHASES = [
  "lexical.batch",
  "semantic.overall",
  "retrieve.lexical",
  "retrieve.hybrid",
  "retrieve.queryEmbedding",
  "related.related",
  "publication.overall",
  "publication.inspectPublication",
];

export function validateReport(report, marker) {
  if (
    report?.version !== reportVersion ||
    report.runId !== marker.runId ||
    report.profile !== marker.profile
  )
    throw new Error("Benchmark report identity/version mismatch.");
  if (
    report.host !== "obsidian-desktop" ||
    report.runtime !== "standard-trama-worker-wasm-opfs" ||
    report.storage !== "vault-opfs-identity" ||
    report.transport !== "browser-worker" ||
    report.providerTransport !== "loopback-http-fixture" ||
    report.publication !== "vault-filesystem" ||
    report.diagnosticsMode !== "performance" ||
    report.workloadContractVersion !== "trama-workload-contract-v1" ||
    report.oracleVersion !== "expected-outputs-v1" ||
    report.memory?.rssBytes !== "unsupported" ||
    !report.boundaries?.includes("publication filesystem adapter included")
  )
    throw new Error("Benchmark report host/runtime boundary mismatch.");
  if (
    report.sourceDigest !== marker.sourceDigest ||
    report.providerChallengeSha256 !== marker.providerChallengeSha256 ||
    report.queryVectorSha256 !== marker.queryVectorSha256
  )
    throw new Error("Benchmark fixture identity mismatch.");
  if (report.status !== "completed")
    throw new Error(`Benchmark ${report.status}: ${report.error ?? "unknown error"}`);
  if (
    !report.correctness ||
    REQUIRED_BENCHMARK_GATES.some((gate) => report.correctness[gate] !== true) ||
    Object.values(report.correctness).some((value) => value !== true)
  )
    throw new Error("Benchmark correctness gate failed.");
  if (
    REQUIRED_BENCHMARK_PHASES.some((key) => {
      const phase = report.phases?.[key];
      return (
        !phase ||
        !Number.isSafeInteger(phase.count) ||
        phase.count < 1 ||
        !Number.isFinite(phase.durationMs) ||
        phase.durationMs < 0
      );
    })
  )
    throw new Error("Benchmark production phase timings missing or invalid.");
  return report;
}

async function cli(vaultName, command, parameters = []) {
  const args = benchmarkCliArgs(vaultName, command, parameters);
  try {
    return await runFile("obsidian", args, { timeout: 30_000 });
  } catch (error) {
    throw new Error(
      `Obsidian CLI ${command} failed for the generated vault (exit ${error.code ?? "unknown"}).`
    );
  }
}

export async function verifyCliTarget(vaultPath, vaultName, invoke = cli) {
  await validateGeneratedVault(vaultPath, vaultName);
  const result = await invoke(vaultName, "vault", ["info=path"]);
  if (result.stdout.trim() !== vaultPath)
    throw new Error(
      "Obsidian CLI vault selector did not resolve to the exact generated vault path; refusing all further commands."
    );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--prepare"))
    throw new Error("Usage: node scripts/benchmark/obsidian.mjs [--prepare]");
  const { vaultPath, vaultName, marker } = await prepareVault();
  process.stdout.write(`Generated ${vaultPath} (${marker.runId}).\n`);
  await validateGeneratedVault(vaultPath, vaultName);
  await runFile(process.execPath, ["scripts/generate-build-identity.mjs"], { cwd: root });
  await runFile(process.execPath, ["scripts/sqlite-wasm/build.mjs"], { cwd: root });
  await runFile(process.execPath, ["esbuild.config.mjs", "production"], { cwd: root });
  await installBenchmarkPlugin(vaultPath, vaultName);
  if (args[0] === "--prepare") {
    process.stdout.write(
      `Benchmark vault prepared: ${vaultPath}\nOpen that exact folder in Obsidian, enable Trama and the CLI, then run npm run benchmark with the same profile. No Obsidian command was sent.\n`
    );
    return;
  }
  const { generator } = await loadWorkload(profile);
  const provider = await startFixtureProvider(marker.runId, generator.deterministicEmbeddingVector);
  try {
    await validateInstallPath(vaultPath, vaultName);
    const settingsFile = path.join(vaultPath, ".obsidian/plugins/trama/data.json");
    const existing = (await exists(settingsFile))
      ? JSON.parse(await readFile(settingsFile, "utf8"))
      : {};
    await writeFile(
      settingsFile,
      `${JSON.stringify(
        {
          ...existing,
          schemaVersion: 6,
          diagnosticsMode: "performance",
          automaticMaintenance: false,
          publicationDirectory: "Trama/index",
          filo: { excludedPaths: [] },
          embedding: {
            ...existing.embedding,
            endpoint: provider.endpoint,
            modelId: provider.modelId,
            dimensions: 768,
            batchSize: 32,
          },
          chat: {
            ...existing.chat,
            endpoint: provider.endpoint,
            modelId: provider.modelId,
          },
        },
        null,
        2
      )}\n`
    );
    try {
      await verifyCliTarget(vaultPath, vaultName);
    } catch {
      throw new Error(
        `Trama was installed in the generated vault, but Obsidian CLI cannot prove its target. Open/register exactly ${vaultPath}, enable Command line interface in Obsidian Settings > General, and rerun. No plugin command was sent.`
      );
    }
    await verifyCliTarget(vaultPath, vaultName);
    const restricted = (await cli(vaultName, "plugins:restrict")).stdout.trim();
    if (!/\boff\b/i.test(restricted) || /\bon\b/i.test(restricted))
      throw new Error(
        "The generated vault has restricted mode enabled or its state could not be read. Turn on community plugins in that exact vault and rerun."
      );
    await verifyCliTarget(vaultPath, vaultName);
    await cli(vaultName, "plugin:enable", ["id=trama"]);
    await verifyCliTarget(vaultPath, vaultName);
    await cli(vaultName, "plugin:reload", ["id=trama"]);
    await verifyCliTarget(vaultPath, vaultName);
    await cli(vaultName, "command", ["id=trama:run-obsidian-benchmark"]);
    const reportPath = path.join(vaultPath, ".trama-benchmark-report.json");
    const deadline = Date.now() + timeoutMs + 30_000;
    while (Date.now() < deadline) {
      if (await exists(reportPath)) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        const archivePath = path.join(outputRoot, `obsidian-${profile}-${marker.runId}.json`);
        await mkdir(path.dirname(archivePath), { recursive: true });
        await writeFile(archivePath, `${JSON.stringify(report, null, 2)}\n`);
        validateReport(report, marker);
        process.stdout.write(`Benchmark completed: ${archivePath}\n`);
        return;
      }
      await delay(1000);
    }
    throw new Error(
      `Benchmark timed out waiting for ${reportPath}. Confirm the dedicated vault is registered and Trama is enabled there.`
    );
  } finally {
    await provider.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
