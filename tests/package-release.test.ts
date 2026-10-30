import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error The release builder is a plain ESM script.
import { packageRelease } from "../scripts/package-release.mjs";

const PRODUCTION_FILES = [
  "main.js",
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
    // Obsidian installs only the standard files; notices must travel in main.js too.
    const main = new TextDecoder().decode(members["main.js"]);
    const embeddedLicenses = main
      .split("\n")
      .filter((line) => line.startsWith("// "))
      .map((line) => line.slice(3))
      .join("\n");
    expect(embeddedLicenses).toContain(new TextDecoder().decode(members.LICENSE));
    expect(embeddedLicenses).toContain(notices);

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
  it.each(["unexpected file", "corrupt main.js"])("rejects a release archive with %s", (kind) => {
    const destination = join(temporaryDirectory, `${kind}.zip`);
    packageRelease({ version, archive: destination });
    const files = unzipSync(readFileSync(destination));
    if (kind === "unexpected file")
      files["../outside.txt"] = new TextEncoder().encode("unexpected");
    else files["main.js"] = new TextEncoder().encode("corrupted");
    writeFileSync(destination, zipSync(files));
    expect(() => packageRelease({ version, archive: destination, verify: true })).toThrow(
      kind === "unexpected file" ? "must contain exactly" : "content mismatch"
    );
  });
});
