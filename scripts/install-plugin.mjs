import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
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
    if (hadLive) await cp(pluginDirectory, stagingDirectory, { recursive: true });
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const vaultArgument = process.argv[2] ?? process.env.OBSIDIAN_VAULT_PATH;
  const installed = await installPlugin({ vaultPath: vaultArgument });
  process.stdout.write(`Installed ${PLUGIN_ID} in ${installed}\n`);
}
