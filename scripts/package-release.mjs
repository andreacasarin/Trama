/* global Buffer, console */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";
import { PLUGIN_FILES } from "./plugin-files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--verify") {
      args.set("verify", true);
      continue;
    }
    if (!argument.startsWith("--") || index + 1 >= argv.length)
      fail(`Expected an option and value, got ${argument}`);
    args.set(argument.slice(2), argv[++index]);
  }
  return args;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Unable to read ${label}: ${error.message}`);
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function validateVersion(version) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      version
    )
  )
    fail(`Invalid semantic version: ${version}`);
}

function validateRepositoryVersion(version) {
  const packageJson = readJson(join(root, "package.json"), "package.json");
  const manifest = readJson(join(root, "manifest.json"), "manifest.json");
  if (packageJson.version !== version)
    fail(`package.json version ${packageJson.version} does not match ${version}`);
  if (manifest.version !== version)
    fail(`manifest.json version ${manifest.version} does not match ${version}`);
}

function sourceEntries(version) {
  validateVersion(version);
  validateRepositoryVersion(version);
  return PLUGIN_FILES.map((name) => {
    const path = join(root, name);
    if (!existsSync(path) || !statSync(path).isFile()) fail(`Missing release member: ${name}`);
    return [name, readFileSync(path)];
  });
}

function archiveEntries(path) {
  let archive;
  try {
    archive = unzipSync(readFileSync(path));
  } catch (error) {
    fail(`Unable to read release ZIP: ${error.message}`);
  }
  return new Map(Object.entries(archive).map(([name, data]) => [name, Buffer.from(data)]));
}

function validateArchive(path, version) {
  const expected = sourceEntries(version);
  const actual = archiveEntries(path);
  const expectedNames = new Set(PLUGIN_FILES);
  if (actual.size !== expectedNames.size)
    fail(`Release ZIP must contain exactly ${PLUGIN_FILES.length} members`);
  for (const [name, data] of actual) {
    if (!expectedNames.has(name)) fail(`Unexpected release ZIP member: ${name}`);
    const expectedData = expected.find(([entryName]) => entryName === name)?.[1];
    if (!expectedData || sha256(data) !== sha256(expectedData))
      fail(`Release ZIP member content mismatch: ${name}`);
  }
  return Object.fromEntries(expected.map(([name, data]) => [name, sha256(data)]));
}

const args = parseArgs(process.argv.slice(2));
const version = args.get("version");
const archive = args.get("archive");
if (typeof version !== "string" || typeof archive !== "string")
  fail("Usage: node scripts/package-release.mjs [--verify] --version VERSION --archive PATH");

const archivePath = resolve(root, archive);
if (!args.get("verify")) {
  const contents = Object.fromEntries(sourceEntries(version));
  mkdirSync(dirname(archivePath), { recursive: true });
  writeFileSync(
    archivePath,
    zipSync(contents, { level: 9, mtime: new Date("1980-01-01T00:00:00.000Z") })
  );
} else if (!existsSync(archivePath)) {
  fail(`Missing release archive: ${archivePath}`);
}

const hashes = validateArchive(archivePath, version);
console.log(
  JSON.stringify({ archive: archivePath, version, members: PLUGIN_FILES, hashes }, null, 2)
);
