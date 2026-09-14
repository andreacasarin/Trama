import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";

const PRODUCTION_FILES = [
  "main.js",
  "sqlite-worker.mjs",
  "sqlite3.mjs",
  "sqlite3.wasm",
  "manifest.json",
  "styles.css",
];

const temporaryDirectory = mkdtempSync(join(tmpdir(), "trama-release-"));
const archive = join(temporaryDirectory, "trama.zip");
const root = resolve(import.meta.dirname, "..");

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

describe("release package", () => {
  it("contains exactly the production plugin files", () => {
    execFileSync(
      process.execPath,
      ["scripts/package-release.mjs", "--version", "0.1.0", "--archive", archive],
      { cwd: root }
    );

    const files = Object.keys(unzipSync(readFileSync(archive))).sort();
    expect(files).toEqual([...PRODUCTION_FILES].sort());

    execFileSync(
      process.execPath,
      ["scripts/package-release.mjs", "--verify", "--version", "0.1.0", "--archive", archive],
      { cwd: root }
    );
  });
});
