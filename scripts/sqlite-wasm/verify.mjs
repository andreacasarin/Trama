import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getBuildContext } from "./build.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const directoryIndex = process.argv.indexOf("--directory");
const directory = directoryIndex >= 0 ? resolve(process.argv[directoryIndex + 1] ?? "") : root;
const context = getBuildContext({ rootDir: root });
const modulePath = join(directory, "sqlite3.mjs");
const wasmPath = join(directory, "sqlite3.wasm");
for (const path of [modulePath, wasmPath]) {
  if (!existsSync(path)) throw new Error(`Missing SQLite WASM asset: ${path}`);
}

const moduleText = readFileSync(modulePath, "utf8");
const wasmBytes = readFileSync(wasmPath);
const wasmExports = WebAssembly.Module.exports(new WebAssembly.Module(wasmBytes)).map(
  ({ name }) => name
);
globalThis.sqlite3ApiConfig = { disable: { vfs: { kvvfs: true, opfs: true, "opfs-wl": true } } };
const initModule = (await import(`${pathToFileURL(modulePath).href}?verify=${Date.now()}`)).default;
const sqlite = await initModule({
  instantiateWasm(imports, onSuccess) {
    WebAssembly.instantiate(wasmBytes, imports).then(({ instance, module }) =>
      onSuccess(instance, module)
    );
    return {};
  },
});
const db = new sqlite.oo1.DB(":memory:", "c");
const blob = (values) => new Uint8Array(new Float32Array(values).buffer);
const dot = (a, b) => db.selectValue("SELECT trama_vector_dot(?,?)", [blob(a), blob(b)]);
const runtimeChecks = {
  nativeDot: dot([1, 0], [0.5, 0.5]) === 0.5,
  smallDot: dot([1e-30, 0], [1e-30, 0]) > 0,
  largeDot: Number.isFinite(dot([1e20, 0], [1e20, 0])),
  nativeCentroid: db.selectValue("SELECT length(trama_vector_centroid(?))", [blob([1, 0])]) === 8,
  fts5: db.selectValue("SELECT sqlite_compileoption_used('ENABLE_FTS5')") === 1,
  loadExtensionOmitted:
    db.selectValue("SELECT sqlite_compileoption_used('OMIT_LOAD_EXTENSION')") === 1,
  noVectorDependency:
    db.selectValue("SELECT count(*) FROM pragma_module_list WHERE name='vector_full_scan'") === 0,
  fts5Module: db.selectValue("SELECT count(*) FROM pragma_module_list WHERE name='fts5'") === 1,
};
db.close();

const checks = {
  toolchainPinned: context.dockerImage.includes("@sha256:"),
  sqliteVersionPinned: moduleText.includes(context.lock.sqlite.version),
  sourceIdPinned: moduleText.includes(context.lock.sqlite.sourceId),
  fts5Requested: context.lock.build.flags.includes("-DSQLITE_ENABLE_FTS5"),
  staticRegistrationSource: context.lock.build.extraInit.includes("trama_sqlite_init"),
  runtimeExtensionLoadingDisabled:
    context.lock.build.flags.includes("-DSQLITE_OMIT_LOAD_EXTENSION") &&
    !wasmExports.includes("sqlite3_load_extension") &&
    !wasmExports.includes("sqlite3_enable_load_extension"),
  expectedBuildExports: context.lock.build.exports.every((name) => wasmExports.includes(name)),
  compiledCapabilities: Object.values(runtimeChecks).every(Boolean),
  singleThreaded:
    context.lock.build.threaded === false && !moduleText.includes("PTHREAD_POOL_SIZE"),
  wasmValid: WebAssembly.validate(wasmBytes),
  noRemoteModuleImport: !/\b(?:import|fetch)\s*\(\s*["']https?:/.test(moduleText),
  canonicalModule: moduleText.includes("sqlite3ApiBootstrap"),
  persistenceUsesSahPool: moduleText.includes("installOpfsSAHPoolVfs"),
};
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "ok" : "FAIL"} ${name}`);
if (Object.values(checks).some((ok) => !ok)) process.exitCode = 1;
