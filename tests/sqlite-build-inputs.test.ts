import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The build integrity checker is a plain ESM script.
import * as sqliteArtifacts from "../scripts/sqlite-wasm/artifacts.mjs";

const { updateVendoredAssets, verifyRebuiltAssets, verifyVendoredAssets } = sqliteArtifacts;

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "trama-sqlite-inputs-"));
  temporary.push(root);
  for (const name of [
    "vendor/sqlite-wasm/supply-chain.json",
    "scripts/sqlite-wasm/Dockerfile",
    "scripts/sqlite-wasm/sqlite3_wasm_extra_init.c",
    "scripts/sqlite-wasm/build.mjs",
  ]) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    copyFileSync(resolve(import.meta.dirname, "..", name), join(root, name));
  }
  writeFileSync(join(root, "sqlite3.mjs"), "fixture glue");
  writeFileSync(join(root, "sqlite3.wasm"), new Uint8Array([0, 97, 115, 109]));
  updateVendoredAssets(root);
  return root;
}

describe("committed SQLite build inputs", () => {
  it("verifies without generated root files or a build cache", () => {
    const root = fixture();
    rmSync(join(root, "sqlite3.mjs"));
    rmSync(join(root, "sqlite3.wasm"));
    expect(verifyVendoredAssets(root).schema).toBe(1);
  });
  it.each(["sqlite3.mjs", "sqlite3.wasm"])("rejects modified %s before bundling", (name) => {
    const root = fixture();
    writeFileSync(join(root, "vendor/sqlite-wasm", name), "corrupt");
    expect(() => verifyVendoredAssets(root)).toThrow(`SQLite vendor checksum mismatch: ${name}`);
  });
  it("rejects stale artifacts after a native source change", () => {
    const root = fixture();
    const source = join(root, "scripts/sqlite-wasm/sqlite3_wasm_extra_init.c");
    writeFileSync(source, readFileSync(source, "utf8") + "\n/* changed native source */\n");
    expect(() => verifyVendoredAssets(root)).toThrow("SQLite build inputs changed");
  });
  it("requires an independent native rebuild to reproduce the committed bytes", () => {
    const root = fixture();
    expect(() => verifyRebuiltAssets(root)).not.toThrow();
    writeFileSync(join(root, "sqlite3.wasm"), "different rebuild");
    expect(() => verifyRebuiltAssets(root)).toThrow(
      "Rebuilt SQLite differs from the committed artifact: sqlite3.wasm"
    );
  });
});
