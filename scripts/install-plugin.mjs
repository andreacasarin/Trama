import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PLUGIN_FILES } from "./plugin-files.mjs";

const PLUGIN_ID = "trama";
const runtimeManifestName = "runtime-manifest.json";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runFile = promisify(execFile);

async function installFile(source, destination) {
  try {
    await copyFile(source, destination);
  } catch (error) {
    if (process.platform !== "darwin" || error?.code !== "EPERM") throw error;
    await runFile("/bin/cp", ["-f", source, destination]);
  }
}

async function sha256(pathname) {
  return createHash("sha256")
    .update(await readFile(pathname))
    .digest("hex");
}

async function verifyArtifacts(directory, manifest) {
  for (const [fileName, expected] of Object.entries(manifest.hashes)) {
    if ((await sha256(path.join(directory, fileName))) !== expected)
      throw new Error(`Runtime artifact verification failed: ${fileName}`);
  }
}

async function verifyBuildIdentity(directory, buildId) {
  for (const fileName of ["main.js", "sqlite-worker.mjs"]) {
    const contents = await readFile(path.join(directory, fileName), "utf8");
    if (!contents.includes(buildId))
      throw new Error(`Runtime build identity mismatch: ${fileName}`);
  }
}

export async function installPlugin({
  vaultPath,
  projectRoot: root = projectRoot,
  afterActivation,
  preserveExistingFiles = true,
} = {}) {
  if (!vaultPath)
    throw new Error('Provide the Obsidian vault path: npm run install:plugin -- "/path/to/vault"');
  const resolvedVault = path.resolve(vaultPath);
  const obsidianDirectory = path.join(resolvedVault, ".obsidian");
  const pluginDirectory = path.join(obsidianDirectory, "plugins", PLUGIN_ID);
  await access(obsidianDirectory).catch(() => {
    throw new Error(`Not an Obsidian vault: ${resolvedVault} (missing .obsidian directory)`);
  });
  for (const fileName of PLUGIN_FILES)
    await access(path.join(root, fileName)).catch(() => {
      throw new Error(`Missing build artifact: ${fileName}`);
    });

  await mkdir(path.dirname(pluginDirectory), { recursive: true });
  const stagingDirectory = await mkdtemp(path.join(path.dirname(pluginDirectory), ".trama-stage-"));
  const backupDirectory = `${pluginDirectory}.backup-${randomUUID()}`;
  let movedLive = false;
  let activated = false;
  let hadLive = false;
  try {
    hadLive = await access(pluginDirectory).then(
      () => true,
      () => false
    );
    if (hadLive && preserveExistingFiles)
      await cp(pluginDirectory, stagingDirectory, { recursive: true });
    const hashes = {};
    for (const fileName of PLUGIN_FILES) {
      const source = path.join(root, fileName);
      await installFile(source, path.join(stagingDirectory, fileName));
      const sourceHash = await sha256(source);
      if ((await sha256(path.join(stagingDirectory, fileName))) !== sourceHash)
        throw new Error(`Staged artifact verification failed: ${fileName}`);
      hashes[fileName] = sourceHash;
    }
    const runtimeMetadata = JSON.parse(
      await readFile(path.join(root, ".cache/runtime-build.json"), "utf8")
    );
    const buildId = runtimeMetadata.buildId;
    if (!buildId) throw new Error("Generated runtime build identity is missing.");
    const manifest = { buildId, hashes };
    await writeFile(
      path.join(stagingDirectory, runtimeManifestName),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    await verifyArtifacts(stagingDirectory, manifest);
    await verifyBuildIdentity(stagingDirectory, buildId);

    if (hadLive) {
      await rename(pluginDirectory, backupDirectory);
      movedLive = true;
    }
    await rename(stagingDirectory, pluginDirectory);
    activated = true;
    if (afterActivation) await afterActivation(pluginDirectory);
    await verifyArtifacts(pluginDirectory, manifest);
    await verifyBuildIdentity(pluginDirectory, buildId);
    await rm(backupDirectory, { recursive: true, force: true });
  } catch (error) {
    if (activated) await rm(pluginDirectory, { recursive: true, force: true });
    if (movedLive) await rename(backupDirectory, pluginDirectory);
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
    if (!movedLive || activated) await rm(backupDirectory, { recursive: true, force: true });
  }
  return pluginDirectory;
}

async function rejectSymlinks(file) {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || (await realpath(file)) !== file)
    throw new Error("Refusing a symlink in a test vault.");
  if (stat.isDirectory())
    for (const name of await readdir(file)) await rejectSymlinks(path.join(file, name));
}

async function testVaultExists(vaultPath) {
  const relative = path.relative(projectRoot, vaultPath);
  let candidate = projectRoot;
  for (const segment of ["", ...relative.split(path.sep)]) {
    candidate = path.join(candidate, segment);
    let stat;
    try {
      stat = await lstat(candidate);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (stat.isSymbolicLink() || (await realpath(candidate)) !== candidate)
      throw new Error("Refusing a symlinked test vault path.");
    if (!stat.isDirectory()) throw new Error("Expected a test vault directory.");
  }
  return true;
}

export async function installTestVaults(install = installPlugin) {
  const { demoVaultPath, validateDemoVault, prepareDemoVault } =
    await import("./benchmark/demo.mjs");
  const { benchmarkVaultName, validateGeneratedVault, prepareVault, installBenchmarkPlugin } =
    await import("./benchmark/obsidian.mjs");
  const benchmarkPath = path.join(
    projectRoot,
    ".artifacts/test-vaults/benchmark",
    benchmarkVaultName
  );
  // Check existing vaults and missing-path ancestors before preparing or updating either.
  const demoExists = await testVaultExists(demoVaultPath);
  const benchmarkExists = await testVaultExists(benchmarkPath);
  if (demoExists) await validateDemoVault();
  if (benchmarkExists) {
    await validateGeneratedVault(benchmarkPath, benchmarkVaultName);
    await rejectSymlinks(benchmarkPath);
  }
  if (!demoExists) await prepareDemoVault(); // Already installs Trama.
  if (!benchmarkExists) await prepareVault();
  await validateDemoVault();
  await validateGeneratedVault(benchmarkPath, benchmarkVaultName);
  await rejectSymlinks(benchmarkPath);
  if (demoExists) await install({ vaultPath: demoVaultPath, preserveExistingFiles: true });
  await installBenchmarkPlugin(benchmarkPath, benchmarkVaultName, install);
  return [demoVaultPath, benchmarkPath].map((vaultPath) =>
    path.join(vaultPath, ".obsidian/plugins", PLUGIN_ID)
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0]?.startsWith("--") && args[0] !== "--test-vaults"))
    throw new Error('Usage: npm run install:plugin -- --test-vaults (or "/path/to/vault")');
  const installed =
    args[0] === "--test-vaults"
      ? await installTestVaults()
      : [await installPlugin({ vaultPath: args[0] ?? process.env.OBSIDIAN_VAULT_PATH })];
  if (args[0] === "--test-vaults") {
    process.stdout.write("\nGenerated test vaults (add both folders to Obsidian):\n");
    process.stdout.write(`Demo: ${path.resolve(installed[0], "../../..")}\n`);
    process.stdout.write(`Benchmark: ${path.resolve(installed[1], "../../..")}\n`);
    process.stdout.write(
      "Enable Community plugins and Trama in both vaults. In the benchmark vault, open Settings > General, enable Command line interface, and follow its registration prompt for benchmarks.\n\n"
    );
  }
  for (const directory of installed)
    process.stdout.write(`Installed ${PLUGIN_ID} in ${directory}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
