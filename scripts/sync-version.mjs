import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = packageJson.version;
const minimum = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).minAppVersion;
if (packageJson.devDependencies["obsidian-minimum"] !== `npm:obsidian@${minimum}`)
  throw new Error(`obsidian-minimum must pin the manifest minimum app version (${minimum})`);
const check = process.argv.includes("--check");

for (const name of ["manifest.json", "package-lock.json"]) {
  const path = join(root, name);
  const contents = JSON.parse(readFileSync(path, "utf8"));
  const versions = name === "package-lock.json" ? [contents, contents.packages[""]] : [contents];
  if (versions.every((entry) => entry.version === version)) continue;
  if (check) throw new Error(`${name} version must match package.json (${version})`);
  for (const entry of versions) entry.version = version;
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`);
}
