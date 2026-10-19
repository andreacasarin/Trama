import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installPlugin } from "../install-plugin.mjs";
import { createPerformanceCorpus, CORPUS_COUNT, CORPUS_SHA256 } from "./performance-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputRoot = path.join(root, ".artifacts/test-vaults/benchmark");
export const benchmarkVaultName = "Trama Benchmark Vault";
export const benchmarkVaultPath = path.join(outputRoot, benchmarkVaultName);
const markerName = ".trama-benchmark-vault";
const marker = {
  version: "trama-benchmark-vault-v1",
  vaultName: benchmarkVaultName,
  expectedPath: benchmarkVaultPath,
  corpusSha256: CORPUS_SHA256,
};

async function entry(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertContainedTree(file, vaultRoot, markdownPaths) {
  const stat = await entry(file);
  if (!stat) return;
  if (stat.isSymbolicLink() || (await realpath(file)) !== file)
    throw new Error("Refusing a symlink in the benchmark vault.");
  if (stat.isDirectory())
    for (const name of await readdir(file))
      await assertContainedTree(path.join(file, name), vaultRoot, markdownPaths);
  else if (stat.isFile() && path.extname(file).toLowerCase() === ".md")
    markdownPaths.push(path.relative(vaultRoot, file).split(path.sep).join("/"));
}

async function validateMarkedBenchmarkVault(vaultPath, requireCompleteCorpus) {
  if (vaultPath !== benchmarkVaultPath || (await realpath(outputRoot)) !== outputRoot)
    throw new Error("Refusing a vault outside the dedicated benchmark path.");
  const markdownPaths = [];
  await assertContainedTree(vaultPath, vaultPath, markdownPaths);
  const actual = JSON.parse(await readFile(path.join(vaultPath, markerName), "utf8"));
  if (
    actual.version !== marker.version ||
    actual.vaultName !== benchmarkVaultName ||
    actual.expectedPath !== benchmarkVaultPath ||
    actual.corpusSha256 !== CORPUS_SHA256
  )
    throw new Error("Refusing an unmarked or invalid benchmark vault.");
  const expected = new Set(
    Array.from({ length: CORPUS_COUNT }, (_, index) => `notes/${String(index).padStart(4, "0")}.md`)
  );
  if (
    markdownPaths.some((markdownPath) => !expected.has(markdownPath)) ||
    (requireCompleteCorpus && markdownPaths.length !== expected.size)
  )
    throw new Error("Refusing unexpected or missing Markdown files in the benchmark vault.");
}

export async function validateBenchmarkVault(vaultPath = benchmarkVaultPath) {
  await validateMarkedBenchmarkVault(vaultPath, true);
}

export async function prepareBenchmarkVault() {
  await mkdir(outputRoot, { recursive: true });
  if ((await realpath(outputRoot)) !== outputRoot)
    throw new Error("Refusing a symlinked benchmark parent.");
  if (await entry(benchmarkVaultPath))
    await validateMarkedBenchmarkVault(benchmarkVaultPath, false);
  else {
    await mkdir(benchmarkVaultPath);
    await writeFile(
      path.join(benchmarkVaultPath, markerName),
      `${JSON.stringify(marker, null, 2)}\n`,
      {
        flag: "wx",
      }
    );
  }

  const { notes } = createPerformanceCorpus();
  const noteRoot = path.join(benchmarkVaultPath, "notes");
  await mkdir(noteRoot, { recursive: true });
  for (const note of notes) {
    const destination = path.join(benchmarkVaultPath, note.path);
    const current = await entry(destination);
    if (current) {
      if (!current.isFile() || (await readFile(destination, "utf8")) !== note.content)
        throw new Error(`Refusing to overwrite an edited benchmark note: ${note.path}`);
    } else {
      await writeFile(destination, note.content, { flag: "wx" });
    }
  }
  await mkdir(path.join(benchmarkVaultPath, ".obsidian"), { recursive: true });
  const pluginsFile = path.join(benchmarkVaultPath, ".obsidian/community-plugins.json");
  const plugins = (await entry(pluginsFile)) ? JSON.parse(await readFile(pluginsFile, "utf8")) : [];
  if (!Array.isArray(plugins) || plugins.some((id) => id !== "trama"))
    throw new Error("Refusing to change other community plugins.");
  await installPlugin({ vaultPath: benchmarkVaultPath, preserveExistingFiles: true });
  await writeFile(pluginsFile, '["trama"]\n');
  await validateBenchmarkVault();
  return { vaultPath: benchmarkVaultPath, vaultName: benchmarkVaultName, noteCount: notes.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  prepareBenchmarkVault().then(
    (result) =>
      process.stdout.write(
        `Prepared ${result.noteCount} benchmark notes in ${result.vaultPath}. Open this folder in Obsidian and enable Trama.\n`
      ),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  );
}
