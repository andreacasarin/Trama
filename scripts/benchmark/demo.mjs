import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { installPlugin } from "../install-plugin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputRoot = path.join(root, ".artifacts/test-vaults/demo");
const contentRoot = path.join(root, "test-vaults/demo");
export const demoVaultName = "Trama Test Vault";
export const demoVaultPath = path.join(outputRoot, demoVaultName);
const markerName = ".trama-demo-vault";
const marker = {
  version: "trama-demo-vault-v1",
  vaultName: demoVaultName,
  expectedPath: demoVaultPath,
};

async function entry(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertContainedTree(file) {
  const stat = await entry(file);
  if (!stat) return;
  if (stat.isSymbolicLink() || (await realpath(file)) !== file)
    throw new Error("Refusing a symlink in the demo vault.");
  if (stat.isDirectory())
    for (const name of await readdir(file)) await assertContainedTree(path.join(file, name));
}

export async function validateDemoVault(vaultPath = demoVaultPath) {
  if (vaultPath !== demoVaultPath || (await realpath(outputRoot)) !== outputRoot)
    throw new Error("Refusing a vault outside the dedicated demo path.");
  await assertContainedTree(vaultPath);
  const actual = JSON.parse(await readFile(path.join(vaultPath, markerName), "utf8"));
  if (
    actual.version !== marker.version ||
    actual.vaultName !== demoVaultName ||
    actual.expectedPath !== demoVaultPath
  )
    throw new Error("Refusing an unmarked or invalid demo vault.");
  return actual;
}

export function demoCliArgs(command, parameters = []) {
  const allowed =
    (command === "vault" && parameters.length === 1 && parameters[0] === "info=path") ||
    (command === "plugin:reload" && parameters.length === 1 && parameters[0] === "id=trama") ||
    (command === "command" &&
      parameters.length === 1 &&
      ["id=trama:open-lente", "id=trama:open-voce", "id=trama:open-filo"].includes(parameters[0]));
  if (!allowed) throw new Error("Refusing an unsupported demo CLI command.");
  return [`vault=${demoVaultName}`, command, ...parameters];
}

export async function verifyDemoCliTarget(invoke = promisify(execFile)) {
  await validateDemoVault();
  const result = await invoke("obsidian", demoCliArgs("vault", ["info=path"]), { timeout: 30000 });
  if (result.stdout.trim() !== demoVaultPath)
    throw new Error("Obsidian did not confirm the exact marked demo vault; no command was sent.");
}

/** Only the exact marked demo path is writable; never replaces edited notes. */
export async function prepareDemoVault() {
  await mkdir(outputRoot, { recursive: true });
  if ((await realpath(outputRoot)) !== outputRoot)
    throw new Error("Refusing a symlinked demo parent.");
  if (await entry(demoVaultPath)) await validateDemoVault();
  else {
    await mkdir(demoVaultPath);
    await writeFile(path.join(demoVaultPath, markerName), `${JSON.stringify(marker, null, 2)}\n`, {
      flag: "wx",
    });
  }
  const files = [];
  for (const folder of ["journal", "zettelkasten"])
    for (const name of await readdir(path.join(contentRoot, folder))) {
      const destination = path.join(demoVaultPath, folder, name);
      const content = await readFile(path.join(contentRoot, folder, name), "utf8");
      if ((await entry(destination)) && (await readFile(destination, "utf8")) !== content)
        throw new Error(`Refusing to overwrite an edited demo note: ${folder}/${name}`);
      files.push({ destination, content });
    }
  const pluginsFile = path.join(demoVaultPath, ".obsidian/community-plugins.json");
  if (await entry(pluginsFile)) {
    const plugins = JSON.parse(await readFile(pluginsFile, "utf8"));
    if (!Array.isArray(plugins) || plugins.some((id) => id !== "trama"))
      throw new Error("Refusing to change other community plugins.");
  }
  await validateDemoVault();
  for (const folder of ["journal", "zettelkasten"])
    await mkdir(path.join(demoVaultPath, folder), { recursive: true });
  for (const { destination, content } of files)
    if (!(await entry(destination))) await writeFile(destination, content, { flag: "wx" });
  await mkdir(path.join(demoVaultPath, ".obsidian"), { recursive: true });
  await installPlugin({ vaultPath: demoVaultPath, preserveExistingFiles: true });
  await validateDemoVault();
  await writeFile(pluginsFile, '["trama"]\n');
  return { vaultPath: demoVaultPath, vaultName: demoVaultName, noteCount: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  prepareDemoVault().then(
    (result) =>
      process.stdout.write(
        `Prepared ${result.noteCount} demo notes in ${result.vaultPath}. Open this folder in Obsidian and enable Trama.\n`
      ),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  );
}
