import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
// @ts-expect-error Standalone Node host script has no emitted declaration.
import { demoCliArgs, demoVaultName, validateDemoVault } from "../scripts/benchmark/demo.mjs";

describe("demo vault", () => {
  it("contains 10 daily notes and 30 short, fully linked topic notes", async () => {
    const root = path.resolve("test-vaults/demo");
    const notes = new Map<string, string>();
    for (const [folder, count] of [
      ["journal", 10],
      ["zettelkasten", 30],
    ] as const) {
      const names = await readdir(path.join(root, folder));
      expect(names).toHaveLength(count);
      for (const name of names) {
        expect(name).toMatch(/\.md$/);
        if (folder === "journal") expect(name).toMatch(/^2026-09-\d{2}\.md$/);
        const content = await readFile(path.join(root, folder, name), "utf8");
        expect(content).toMatch(/^---\n/);
        expect(content).toMatch(/\n# /);
        const words = content.split(/\s+/).length;
        expect(words).toBeGreaterThan(80);
        expect(words).toBeLessThan(300);
        notes.set(`${folder}/${name.slice(0, -3)}`, content);
      }
    }
    for (const content of notes.values())
      for (const match of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
        const target = match[1];
        expect(notes.has(target) || notes.has(`zettelkasten/${target}`), target).toBe(true);
      }
  });

  it("always scopes demo CLI commands and refuses benchmark or unrelated commands", () => {
    expect(demoVaultName).toBe("Trama Test Vault");
    expect(demoCliArgs("vault", ["info=path"])).toEqual([
      "vault=Trama Test Vault",
      "vault",
      "info=path",
    ]);
    for (const id of ["open-lente", "open-voce", "open-filo"])
      expect(demoCliArgs("command", [`id=trama:${id}`])[0]).toBe("vault=Trama Test Vault");
    expect(() => demoCliArgs("vaults")).toThrow();
    expect(() => demoCliArgs("command", ["id=trama:run-obsidian-benchmark"])).toThrow();
    expect(() => demoCliArgs("plugin:reload", ["id=other"])).toThrow();
  });

  it("rejects any path other than the fixed generated demo path before reading it", async () => {
    await expect(validateDemoVault("/tmp/personal-vault")).rejects.toThrow("dedicated demo path");
  });
});
