import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CACHE_SCHEMA = 5;
export const BUILDER_VERSION = "canonical-sqlite-vector-v1";
export const DOCKER_BUILD_TIMEOUT_MS = 20 * 60 * 1000;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = fileURLToPath(import.meta.url);
const clean = process.argv.includes("--clean");
const outputs = ["sqlite3.mjs", "sqlite3.wasm"];

const digestBytes = (bytes, algorithm = "sha256") =>
  createHash(algorithm).update(bytes).digest("hex");
const digest = (path, algorithm = "sha256") => digestBytes(readFileSync(path), algorithm);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function dockerPlatform() {
  if (process.arch === "arm64") return "linux/arm64";
  if (process.arch === "x64") return "linux/amd64";
  throw new Error(`Unsupported host architecture for the pinned SQLite build: ${process.arch}`);
}

export function getBuildContext({ rootDir = root, platform = dockerPlatform() } = {}) {
  const supplyChainPath = join(rootDir, "vendor/sqlite-wasm/supply-chain.json");
  const licensesPath = join(rootDir, "vendor/sqlite-wasm/LICENSES.md");
  const dockerfilePath = join(rootDir, "scripts/sqlite-wasm/Dockerfile");
  const extraInitPath = join(rootDir, "scripts/sqlite-wasm/sqlite3_wasm_extra_init.c");
  const lockBytes = readFileSync(supplyChainPath);
  const lock = JSON.parse(lockBytes);
  const imageDigest = lock.emscripten?.images?.[platform];
  if (!imageDigest) throw new Error(`No pinned Emscripten image digest for ${platform}`);
  const dockerImage = `${lock.emscripten.image}@${imageDigest}`;
  const fingerprintInputs = {
    cacheSchema: CACHE_SCHEMA,
    builderVersion: BUILDER_VERSION,
    supplyChainSha256: digestBytes(lockBytes),
    licensesSha256: digest(licensesPath),
    dockerfileSha256: digest(dockerfilePath),
    extraInitSha256: digest(extraInitPath),
    platform,
    dockerImage,
    build: lock.build,
  };
  const fingerprint = digestBytes(JSON.stringify(fingerprintInputs));
  const cacheRoot = join(rootDir, ".cache/sqlite-wasm");
  return {
    rootDir,
    lock,
    fingerprint,
    fingerprintInputs,
    cacheRoot,
    artifactDir: join(cacheRoot, "artifacts", fingerprint),
    dockerfilePath,
    dockerContext: join(rootDir, "scripts/sqlite-wasm"),
    dockerPlatform: platform,
    dockerImage,
  };
}

function outputEntries(directory) {
  return Object.fromEntries(
    outputs.map((name) => [
      name,
      {
        sha256: digest(join(directory, name)),
        bytes: readFileSync(join(directory, name)).byteLength,
      },
    ])
  );
}

export function validateArtifactCache(context, directory = context.artifactDir) {
  const manifestPath = join(directory, "manifest.json");
  if (!existsSync(manifestPath)) return { ok: false, reason: "missing manifest" };
  try {
    const manifest = readJson(manifestPath);
    if (manifest.schema !== CACHE_SCHEMA) return { ok: false, reason: "manifest schema mismatch" };
    if (manifest.fingerprint !== context.fingerprint)
      return { ok: false, reason: "fingerprint mismatch" };
    if (JSON.stringify(manifest.fingerprintInputs) !== JSON.stringify(context.fingerprintInputs))
      return { ok: false, reason: "fingerprint inputs mismatch" };
    if (manifest.toolchain !== context.dockerImage)
      return { ok: false, reason: "toolchain mismatch" };
    if (
      manifest.postProcessing?.canonicalModule !== true ||
      manifest.postProcessing?.persistenceVfs !== "opfs-sah-pool"
    )
      return { ok: false, reason: "post-processing metadata mismatch" };
    if (
      manifest.source?.sqliteArchiveSha256 !== context.lock.sqlite.archiveSha256 ||
      manifest.source?.sqliteAmalgamationArchiveSha256 !==
        context.lock.sqlite.amalgamationArchiveSha256 ||
      manifest.source?.sqliteVectorArchiveSha256 !== context.lock.sqliteVector.archiveSha256
    )
      return { ok: false, reason: "source checksum metadata mismatch" };
    if (
      Object.keys(manifest.outputs ?? {})
        .sort()
        .join(",") !== outputs.join(",")
    )
      return { ok: false, reason: "unexpected cache outputs" };
    for (const name of outputs) {
      const path = join(directory, name);
      const expected = manifest.outputs[name];
      if (
        !existsSync(path) ||
        expected.sha256 !== digest(path) ||
        expected.bytes !== readFileSync(path).byteLength
      )
        return { ok: false, reason: `${name} checksum mismatch` };
    }
    return { ok: true, manifest };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function dockerArgs(context, destination, noCache) {
  const { lock } = context;
  const args = [
    "build",
    "--file",
    context.dockerfilePath,
    "--platform",
    context.dockerPlatform,
    "--progress",
    "plain",
    "--output",
    `type=local,dest=${destination}`,
  ];
  if (noCache) args.push("--no-cache");
  const buildArgs = {
    EMSCRIPTEN_IMAGE: context.dockerImage,
    SQLITE_URL: lock.sqlite.url,
    SQLITE_SHA256: lock.sqlite.archiveSha256,
    SQLITE_AMALGAMATION_URL: lock.sqlite.amalgamationUrl,
    SQLITE_AMALGAMATION_SHA256: lock.sqlite.amalgamationArchiveSha256,
    SQLITE_VECTOR_URL: lock.sqliteVector.url,
    SQLITE_VECTOR_SHA256: lock.sqliteVector.archiveSha256,
    SQLITE_OPT: [...lock.build.flags, "-DSQLITE_C=../../sqlite3.c"]
      .map((flag) => (flag.startsWith("-DSQLITE_DEFAULT_UNIX_VFS=") ? `'${flag}'` : flag))
      .join(" "),
    EMCC_FLAGS: lock.build.emccFlags.join(" "),
    EMCC_OPT: lock.build.optimization.replace(/\s+-g3\s*$/, ""),
  };
  for (const [name, value] of Object.entries(buildArgs))
    args.push("--build-arg", `${name}=${value}`);
  args.push(context.dockerContext);
  return args;
}

function buildArtifact(context, noCache) {
  mkdirSync(dirname(context.artifactDir), { recursive: true });
  const temporary = mkdtempSync(join(dirname(context.artifactDir), ".build-"));
  let published = false;
  try {
    console.log(`SQLite WASM Docker build: ${context.dockerImage} on ${context.dockerPlatform}`);
    execFileSync("docker", dockerArgs(context, temporary, noCache), {
      stdio: "inherit",
      timeout: DOCKER_BUILD_TIMEOUT_MS,
      killSignal: "SIGTERM",
    });
    const manifest = {
      schema: CACHE_SCHEMA,
      fingerprint: context.fingerprint,
      fingerprintInputs: context.fingerprintInputs,
      toolchain: context.dockerImage,
      source: {
        sqliteArchiveSha256: context.lock.sqlite.archiveSha256,
        sqliteAmalgamationArchiveSha256: context.lock.sqlite.amalgamationArchiveSha256,
        sqliteVectorArchiveSha256: context.lock.sqliteVector.archiveSha256,
      },
      outputs: outputEntries(temporary),
      postProcessing: {
        canonicalModule: true,
        persistenceVfs: "opfs-sah-pool",
      },
    };
    writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const staged = validateArtifactCache(context, temporary);
    if (!staged.ok) throw new Error(`SQLite WASM build failed validation: ${staged.reason}`);
    rmSync(context.artifactDir, { recursive: true, force: true });
    renameSync(temporary, context.artifactDir);
    published = true;
    return manifest;
  } catch (error) {
    if (error?.code === "ETIMEDOUT")
      throw new Error("SQLite WASM Docker build timed out after 20 minutes", { cause: error });
    throw error;
  } finally {
    if (!published) rmSync(temporary, { recursive: true, force: true });
  }
}

function materialize(context) {
  const cached = validateArtifactCache(context);
  if (!cached.ok) throw new Error(`SQLite artifact cache is not valid: ${cached.reason}`);
  for (const name of outputs) {
    const source = join(context.artifactDir, name);
    const destination = join(context.rootDir, name);
    if (existsSync(destination) && digest(destination) === cached.manifest.outputs[name].sha256)
      continue;
    const temporary = join(context.rootDir, `.${name}.${process.pid}-${randomUUID()}`);
    try {
      copyFileSync(source, temporary);
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

export function resolveMaterializedAssets(context) {
  const cached = validateArtifactCache(context);
  if (!cached.ok) throw new Error(`SQLite artifact cache is not valid: ${cached.reason}`);
  const modulePath = join(context.rootDir, "sqlite3.mjs");
  const wasmPath = join(context.rootDir, "sqlite3.wasm");
  for (const [name, path] of [
    ["sqlite3.mjs", modulePath],
    ["sqlite3.wasm", wasmPath],
  ]) {
    if (!existsSync(path) || digest(path) !== cached.manifest.outputs[name].sha256)
      throw new Error(`Materialized SQLite output mismatch: ${name}`);
  }
  return { manifest: cached.manifest, modulePath, wasmPath };
}

export async function ensureProductionAssets({ rootDir = root, forceClean = clean } = {}) {
  const context = getBuildContext({ rootDir });
  if (forceClean) rmSync(context.cacheRoot, { recursive: true, force: true });
  let cached = validateArtifactCache(context);
  const cacheHit = cached.ok;
  if (!cached.ok) {
    console.log(`SQLite WASM cache miss (${cached.reason}); building ${context.fingerprint}`);
    rmSync(dirname(context.artifactDir), { recursive: true, force: true });
    buildArtifact(context, forceClean);
    cached = validateArtifactCache(context);
    if (!cached.ok) throw new Error(`SQLite WASM cache failed validation: ${cached.reason}`);
  } else {
    console.log(`SQLite WASM cache hit: ${context.fingerprint}`);
  }
  materialize(context);
  return { context, manifest: cached.manifest, cacheHit };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === resolve(scriptPath)) await ensureProductionAssets();
