import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const SQLITE_FILES = ["sqlite3.mjs", "sqlite3.wasm"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (path) => sha256(readFileSync(path));

export function getInputFingerprint(rootDir = root) {
  return sha256(
    JSON.stringify(
      [
        "vendor/sqlite-wasm/supply-chain.json",
        "scripts/sqlite-wasm/Dockerfile",
        "scripts/sqlite-wasm/sqlite3_wasm_extra_init.c",
        "scripts/sqlite-wasm/build.mjs",
      ].map((name) => [name, digest(join(rootDir, name))])
    )
  );
}

export function verifyVendoredAssets(rootDir = root) {
  const directory = join(rootDir, "vendor/sqlite-wasm");
  const manifest = JSON.parse(readFileSync(join(directory, "artifacts.json"), "utf8"));
  if (manifest.schema !== 1 || manifest.inputs !== getInputFingerprint(rootDir))
    throw new Error(
      "SQLite build inputs changed. Run npm run rebuild:sqlite and commit the updated vendor artifacts."
    );
  for (const name of SQLITE_FILES)
    if (digest(join(directory, name)) !== manifest.outputs?.[name])
      throw new Error(`SQLite vendor checksum mismatch: ${name}`);
  return manifest;
}

export function verifyRebuiltAssets(rootDir = root) {
  const manifest = verifyVendoredAssets(rootDir);
  for (const name of SQLITE_FILES)
    if (digest(join(rootDir, name)) !== manifest.outputs[name])
      throw new Error(`Rebuilt SQLite differs from the committed artifact: ${name}`);
}

export function updateVendoredAssets(rootDir = root) {
  const directory = join(rootDir, "vendor/sqlite-wasm");
  const manifest = {
    schema: 1,
    inputs: getInputFingerprint(rootDir),
    outputs: Object.fromEntries(SQLITE_FILES.map((name) => [name, digest(join(rootDir, name))])),
  };
  for (const name of SQLITE_FILES) copyFileSync(join(rootDir, name), join(directory, name));
  writeFileSync(join(directory, "artifacts.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  verifyVendoredAssets(rootDir);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check-rebuilt")) verifyRebuiltAssets();
  else verifyVendoredAssets();
  console.log("SQLite artifact integrity verified");
}
