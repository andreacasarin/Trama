import { access, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "local-vault-assistant";
const REQUIRED_FILES = ["main.js", "manifest.json"];

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vaultArgument = process.argv[2] ?? process.env.OBSIDIAN_VAULT_PATH;

if (!vaultArgument) {
  throw new Error('Provide the Obsidian vault path: npm run install:plugin -- "/path/to/vault"');
}

const vaultPath = path.resolve(vaultArgument);
const obsidianDirectory = path.join(vaultPath, ".obsidian");
const pluginDirectory = path.join(obsidianDirectory, "plugins", PLUGIN_ID);

await access(obsidianDirectory).catch(() => {
  throw new Error(`Not an Obsidian vault: ${vaultPath} (missing .obsidian directory)`);
});

for (const fileName of REQUIRED_FILES) {
  await access(path.join(projectRoot, fileName)).catch(() => {
    throw new Error(`Missing build artifact: ${fileName}`);
  });
}

await mkdir(pluginDirectory, { recursive: true });

for (const fileName of REQUIRED_FILES) {
  await copyFile(path.join(projectRoot, fileName), path.join(pluginDirectory, fileName));
}

process.stdout.write(`Installed ${PLUGIN_ID} in ${pluginDirectory}\n`);
