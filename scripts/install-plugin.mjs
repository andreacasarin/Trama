import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
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

export async function installPlugin({ vaultPath, projectRoot: root = projectRoot } = {}) {
  if (!vaultPath)
    throw new Error('Provide the Obsidian vault path: npm run install:plugin -- "/path/to/vault"');
  const obsidianDirectory = path.join(path.resolve(vaultPath), ".obsidian");
  const pluginDirectory = path.join(obsidianDirectory, "plugins", PLUGIN_ID);
  await access(obsidianDirectory).catch(() => {
    throw new Error(`Not an Obsidian vault: ${vaultPath} (missing .obsidian directory)`);
  });
  const { buildId } = JSON.parse(
    await readFile(path.join(root, ".cache/runtime-build.json"), "utf8")
  );
  if (!buildId) throw new Error("Generated runtime build identity is missing.");
  await verifyBuildIdentity(root, buildId);
  const hashes = {};
  for (const name of PLUGIN_FILES) hashes[name] = await sha256(path.join(root, name));
  await mkdir(pluginDirectory, { recursive: true });
  for (const name of PLUGIN_FILES)
    await installFile(path.join(root, name), path.join(pluginDirectory, name));
  const manifest = { buildId, hashes };
  await verifyArtifacts(pluginDirectory, manifest);
  await writeFile(
    path.join(pluginDirectory, runtimeManifestName),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
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
  const demoExists = await testVaultExists(demoVaultPath);
  if (demoExists) await validateDemoVault();
  if (!demoExists) await prepareDemoVault(); // Already installs Trama.
  await validateDemoVault();
  await rejectSymlinks(demoVaultPath);
  if (demoExists) await install({ vaultPath: demoVaultPath });
  return [path.join(demoVaultPath, ".obsidian/plugins", PLUGIN_ID)];
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
    process.stdout.write("\nDemo test vault (add this folder to Obsidian):\n");
    process.stdout.write(`Demo: ${path.resolve(installed[0], "../../..")}\n`);
    process.stdout.write("Enable Community plugins and Trama in the demo vault.\n\n");
  }
  for (const directory of installed)
    process.stdout.write(`Installed ${PLUGIN_ID} in ${directory}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
