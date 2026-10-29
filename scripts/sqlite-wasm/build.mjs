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

export const DOCKER_BUILD_TIMEOUT_MS = 20 * 60 * 1000;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = fileURLToPath(import.meta.url);
const outputs = ["sqlite3.mjs", "sqlite3.wasm"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (path) => sha256(readFileSync(path));

function dockerPlatform() {
  if (process.arch === "arm64") return "linux/arm64";
  if (process.arch === "x64") return "linux/amd64";
  throw new Error(`Unsupported host architecture for the pinned SQLite build: ${process.arch}`);
}

export function getBuildContext({ rootDir = root, platform = dockerPlatform() } = {}) {
  const lockPath = join(rootDir, "vendor/sqlite-wasm/supply-chain.json");
  const builderPath = join(rootDir, "scripts/sqlite-wasm/build.mjs");
  const dockerfilePath = join(rootDir, "scripts/sqlite-wasm/Dockerfile");
  const extraInitPath = join(rootDir, "scripts/sqlite-wasm/sqlite3_wasm_extra_init.c");
  const lockBytes = readFileSync(lockPath);
  const lock = JSON.parse(lockBytes);
  const imageDigest = lock.emscripten?.images?.[platform];
  if (!imageDigest) throw new Error(`No pinned Emscripten image digest for ${platform}`);
  const dockerImage = `${lock.emscripten.image}@${imageDigest}`;
  const fingerprint = sha256(
    JSON.stringify({
      lock: sha256(lockBytes),
      dockerfile: digest(dockerfilePath),
      extraInit: digest(extraInitPath),
      builder: digest(builderPath),
      platform,
      dockerImage,
    })
  );
  const cacheRoot = join(rootDir, ".cache/sqlite-wasm");
  return {
    rootDir,
    lock,
    fingerprint,
    cacheRoot,
    stampPath: join(cacheRoot, "fingerprint.json"),
    dockerfilePath,
    dockerContext: join(rootDir, "scripts/sqlite-wasm"),
    dockerPlatform: platform,
    dockerImage,
  };
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

function validStamp(context) {
  if (!existsSync(context.stampPath)) return false;
  try {
    const stamp = JSON.parse(readFileSync(context.stampPath, "utf8"));
    return (
      stamp.fingerprint === context.fingerprint &&
      outputs.every((name) => {
        const path = join(context.rootDir, name);
        return existsSync(path) && stamp.outputs?.[name] === digest(path);
      })
    );
  } catch {
    return false;
  }
}

function publish(context, directory) {
  for (const name of outputs) {
    const staged = join(context.rootDir, `.${name}.${process.pid}-${randomUUID()}`);
    try {
      copyFileSync(join(directory, name), staged);
      renameSync(staged, join(context.rootDir, name));
    } finally {
      rmSync(staged, { force: true });
    }
  }
  mkdirSync(context.cacheRoot, { recursive: true });
  const stamp = {
    fingerprint: context.fingerprint,
    outputs: Object.fromEntries(outputs.map((name) => [name, digest(join(context.rootDir, name))])),
  };
  const stagedStamp = `${context.stampPath}.${process.pid}-${randomUUID()}`;
  writeFileSync(stagedStamp, `${JSON.stringify(stamp, null, 2)}\n`);
  renameSync(stagedStamp, context.stampPath);
}

export function ensureProductionAssets({ rootDir = root, forceClean = false } = {}) {
  const context = getBuildContext({ rootDir });
  if (forceClean) rmSync(context.stampPath, { force: true });
  if (validStamp(context)) {
    console.log(`SQLite WASM fingerprint hit: ${context.fingerprint}`);
    return context;
  }

  mkdirSync(context.cacheRoot, { recursive: true });
  const temporary = mkdtempSync(join(context.cacheRoot, ".build-"));
  try {
    console.log(`SQLite WASM Docker build: ${context.dockerImage} on ${context.dockerPlatform}`);
    execFileSync("docker", dockerArgs(context, temporary, forceClean), {
      stdio: "inherit",
      timeout: DOCKER_BUILD_TIMEOUT_MS,
      killSignal: "SIGTERM",
    });
    execFileSync(
      process.execPath,
      [join(rootDir, "scripts/sqlite-wasm/verify.mjs"), "--directory", temporary],
      { cwd: rootDir, stdio: "inherit" }
    );
    publish(context, temporary);
  } catch (error) {
    if (error?.code === "ETIMEDOUT")
      throw new Error("SQLite WASM Docker build timed out after 20 minutes", { cause: error });
    throw error;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  console.log(`SQLite WASM fingerprint stored: ${context.fingerprint}`);
  return context;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(scriptPath))
  ensureProductionAssets({ forceClean: process.argv.includes("--clean") });
