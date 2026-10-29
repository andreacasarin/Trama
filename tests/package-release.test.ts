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
  "LICENSE",
  "THIRD-PARTY-NOTICES.txt",
];

const temporaryDirectory = mkdtempSync(join(tmpdir(), "trama-release-"));
const archive = join(temporaryDirectory, "trama.zip");
const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

describe("release package", () => {
  it("contains exactly the production plugin files", () => {
    execFileSync(
      process.execPath,
      ["scripts/package-release.mjs", "--version", version, "--archive", archive],
      { cwd: root }
    );

    const members = unzipSync(readFileSync(archive));
    const files = Object.keys(members).sort();
    expect(new TextDecoder().decode(members.LICENSE)).toContain(
      "Copyright (c) 2026 Andrea Casarin"
    );
    const notices = new TextDecoder().decode(members["THIRD-PARTY-NOTICES.txt"]);
    expect(notices).not.toContain("Elastic License");
    expect(notices).not.toContain("sqlite-vector-LICENSE");
    expect(notices).toContain("emscripten-LICENSE.txt");
    expect(notices).toContain("musl-COPYRIGHT.txt");
    expect(notices).toContain("Copyright © 2005-2020 Rich Felker, et al.");
    expect(notices).toContain(
      readFileSync(join(root, "vendor/sqlite-wasm/musl-COPYRIGHT.txt"), "utf8")
    );
    expect(notices).toContain("@langchain/core@");
    expect(notices).toContain("Copyright (c) 2020 Jeremy Danyow");
    expect(files).toEqual([...PRODUCTION_FILES].sort());

    // A fresh build from the same source must verify an already-uploaded asset.
    const identity = readFileSync(join(root, ".cache/runtime-build.json"), "utf8");
    execFileSync(process.execPath, ["scripts/generate-build-identity.mjs"], { cwd: root });
    expect(readFileSync(join(root, ".cache/runtime-build.json"), "utf8")).toBe(identity);
    execFileSync(process.execPath, ["esbuild.config.mjs", "production"], {
      cwd: root,
      stdio: "pipe",
    });

    execFileSync(
      process.execPath,
      ["scripts/package-release.mjs", "--verify", "--version", version, "--archive", archive],
      { cwd: root }
    );
  }, 60_000);
});
