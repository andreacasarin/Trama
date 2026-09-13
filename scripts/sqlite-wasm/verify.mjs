import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getBuildContext, resolveMaterializedAssets, validateArtifactCache } from "./build.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const context = getBuildContext({ rootDir: root });
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const fail = (message) => {
  throw new Error(message);
};

const cached = validateArtifactCache(context);
if (!cached.ok) fail(`SQLite WASM cache is not valid: ${cached.reason}`);
const manifest = cached.manifest;
const materialized = resolveMaterializedAssets(context);
for (const name of ["sqlite3.mjs", "sqlite3.wasm"]) {
  if (materialized.manifest.outputs?.[name]?.sha256 !== manifest.outputs[name].sha256)
    fail(`Materialized generation does not match cache artifact: ${name}`);
  if (!existsSync(materialized[name === "sqlite3.mjs" ? "modulePath" : "wasmPath"]))
    fail(`Missing materialized SQLite asset: ${name}`);
  if (
    sha256(materialized[name === "sqlite3.mjs" ? "modulePath" : "wasmPath"]) !==
    manifest.outputs[name].sha256
  )
    fail(`Materialized output checksum mismatch: ${name}`);
}

const moduleText = readFileSync(materialized.modulePath, "utf8");
const wasmBytes = readFileSync(materialized.wasmPath);
const wasmExports = WebAssembly.Module.exports(new WebAssembly.Module(wasmBytes)).map(
  ({ name }) => name
);
const initModule = (await import(`${pathToFileURL(materialized.modulePath).href}?verify`)).default;
const sqlite = await initModule({ wasmBinary: wasmBytes });
const db = new sqlite.oo1.DB(":memory:", "c");
const compiledCapabilities = {
  fts5: db.selectValue("SELECT sqlite_compileoption_used('ENABLE_FTS5')") === 1,
  loadExtensionOmitted:
    db.selectValue("SELECT sqlite_compileoption_used('OMIT_LOAD_EXTENSION')") === 1,
  sqliteVec: db.selectValue("SELECT vec_version()") === context.lock.sqliteVec.version,
  sqliteVecModule:
    db.selectValue("SELECT count(*) FROM pragma_module_list WHERE name='vec0'") === 1,
  fts5Module: db.selectValue("SELECT count(*) FROM pragma_module_list WHERE name='fts5'") === 1,
};
db.close();
const checks = {
  sourceChecksumsLocked:
    manifest.source.sqliteArchiveSha256 === context.lock.sqlite.archiveSha256 &&
    manifest.source.sqliteAmalgamationArchiveSha256 ===
      context.lock.sqlite.amalgamationArchiveSha256 &&
    manifest.source.sqliteVecArchiveSha256 === context.lock.sqliteVec.archiveSha256,
  toolchainPinned: manifest.toolchain === context.dockerImage,
  sqliteVersionPinned: moduleText.includes("3.45.3"),
  sourceIdPinned: moduleText.includes(context.lock.sqlite.sourceId),
  fts5Requested: context.lock.build.flags.includes("-DSQLITE_ENABLE_FTS5"),
  staticRegistrationSource: context.lock.build.flags.includes("-DSQLITE_VEC_STATIC"),
  runtimeExtensionLoadingDisabled:
    context.lock.build.flags.includes("-DSQLITE_OMIT_LOAD_EXTENSION") &&
    !wasmExports.includes("sqlite3_load_extension") &&
    !wasmExports.includes("sqlite3_enable_load_extension"),
  expectedBuildExports: context.lock.build.exports.every((name) => wasmExports.includes(name)),
  compiledCapabilities: Object.values(compiledCapabilities).every(Boolean),
  singleThreaded:
    context.lock.build.threaded === false && !moduleText.includes("PTHREAD_POOL_SIZE"),
  wasmValid: WebAssembly.validate(wasmBytes),
  noRemoteModuleImport: !/\b(?:import|fetch)\s*\(\s*["']https?:/.test(moduleText),
  asyncOpfsInitializerDisabled:
    manifest.postProcessing?.asyncOpfsInitializerDisabled === true &&
    !moduleText.includes('installOpfsVfs.defaultProxyUri =\n  "sqlite3-opfs-async-proxy.js"') &&
    !moduleText.includes("initializersAsync.push(async (sqlite3)=>"),
  persistenceUsesSahPool: manifest.postProcessing?.persistenceVfs === "opfs-sah-pool",
};
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "ok" : "FAIL"} ${name}`);
if (Object.values(checks).some((ok) => !ok)) process.exitCode = 1;
