import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = createHash("sha256");
async function include(name) {
  const entries = await readdir(path.join(root, name), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const relative = `${name}/${entry.name}`;
    if (entry.isDirectory()) await include(relative);
    else await includeFile(relative);
  }
}
async function includeFile(name) {
  const bytes = await readFile(path.join(root, name));
  hash.update(`${name}\0${bytes.length}\0`).update(bytes);
}
for (const name of ["src", "scripts", "vendor"]) await include(name);
for (const name of [
  "LICENSE",
  "package.json",
  "package-lock.json",
  "manifest.json",
  "styles.css",
  "esbuild.config.mjs",
  "tsconfig.json",
])
  await includeFile(name);
await mkdir(path.join(root, ".cache"), { recursive: true });
await writeFile(
  path.join(root, ".cache/runtime-build.json"),
  `${JSON.stringify({ buildId: hash.digest("hex") }, null, 2)}\n`
);
