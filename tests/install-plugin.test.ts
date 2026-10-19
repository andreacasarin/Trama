import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
// @ts-expect-error The installer is an executable ESM script without a project declaration file.
import { installPlugin } from "../scripts/install-plugin.mjs";

const runtimeFiles = [
  "main.js",
  "sqlite-worker.mjs",
  "sqlite3.mjs",
  "sqlite3.wasm",
  "manifest.json",
  "styles.css",
];

async function digest(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

describe("plugin installer", () => {
  it("creates the demo vault from a clean checkout and preserves it on subsequent CLI installs", async () => {
    const project = await mkdtemp(path.join(await realpath(os.tmpdir()), "trama-install-"));
    try {
      for (const name of ["scripts", "src", "test-vaults", "tsconfig.json", ...runtimeFiles])
        await cp(path.join(process.cwd(), name), path.join(project, name), { recursive: true });
      await mkdir(path.join(project, ".cache"));
      await cp(
        path.resolve(".cache/runtime-build.json"),
        path.join(project, ".cache/runtime-build.json")
      );
      await symlink(path.resolve("node_modules"), path.join(project, "node_modules"), "dir");
      const run = () =>
        promisify(execFile)(
          process.execPath,
          [path.join(project, "scripts/install-plugin.mjs"), "--test-vaults"],
          {
            cwd: project,
            env: {
              ...process.env,
              OBSIDIAN_VAULT_PATH: "/never-access-personal-vault",
            },
          }
        );
      const { stdout } = await run();
      const demo = path.join(project, ".artifacts/test-vaults/demo/Trama Test Vault");
      expect(stdout).toContain(`Demo: ${demo}`);
      expect(stdout).toContain("Enable Community plugins and Trama in the demo vault.");
      expect(stdout).not.toContain("Benchmark:");
      expect(stdout).toContain(path.join(demo, ".obsidian/plugins/trama"));
      await expect(
        readFile(path.join(demo, ".obsidian/community-plugins.json"), "utf8")
      ).resolves.toBe('["trama"]\n');
      await writeFile(path.join(demo, ".obsidian/plugins/trama/data.json"), '{"preserved":true}');
      expect(await readdir(path.join(demo, "journal"))).toHaveLength(10);
      expect(await readdir(path.join(demo, "zettelkasten"))).toHaveLength(30);
      const demoNote = path.join(demo, "journal", (await readdir(path.join(demo, "journal")))[0]);
      await writeFile(demoNote, "edited demo note");
      await run();
      await expect(readFile(demoNote, "utf8")).resolves.toBe("edited demo note");
      await expect(
        readFile(path.join(demo, ".obsidian/plugins/trama/data.json"), "utf8")
      ).resolves.toBe('{"preserved":true}');
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects extra vault arguments and unknown flags without installing", async () => {
    for (const args of [["--test-vaults", "/tmp/personal-vault"], ["--unknown"]])
      await expect(
        promisify(execFile)(process.execPath, ["scripts/install-plugin.mjs", ...args])
      ).rejects.toThrow("Usage:");
  });
  it("embeds the generated non-development build ID in both runtime artifacts", async () => {
    const build = JSON.parse(
      await readFile(path.join(process.cwd(), ".cache/runtime-build.json"), "utf8")
    );
    expect(build.buildId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(build.buildId).not.toBe("development");
    for (const fileName of ["main.js", "sqlite-worker.mjs"])
      expect(await readFile(path.join(process.cwd(), fileName), "utf8")).toContain(build.buildId);
  });

  it("installs fresh, preserves upgrade data, and rolls back post-activation corruption", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "trama-vault-"));
    try {
      await mkdir(path.join(vault, ".obsidian", "plugins"), { recursive: true });
      const installed = await installPlugin({ vaultPath: vault, projectRoot: process.cwd() });
      const manifest = JSON.parse(
        await readFile(path.join(installed, "runtime-manifest.json"), "utf8")
      );
      const build = JSON.parse(
        await readFile(path.join(process.cwd(), ".cache/runtime-build.json"), "utf8")
      );
      expect(manifest.buildId).toBe(build.buildId);
      for (const fileName of runtimeFiles)
        expect(manifest.hashes[fileName]).toBe(await digest(path.join(installed, fileName)));

      await writeFile(path.join(installed, "data.json"), '{"preserved":true}\n');
      await writeFile(path.join(installed, "unknown.dat"), "keep me\n");
      const upgraded = await installPlugin({ vaultPath: vault, projectRoot: process.cwd() });
      await expect(readFile(path.join(upgraded, "data.json"), "utf8")).resolves.toBe(
        '{"preserved":true}\n'
      );
      await expect(readFile(path.join(upgraded, "unknown.dat"), "utf8")).resolves.toBe("keep me\n");

      const before = new Map(
        await Promise.all(
          ["data.json", "unknown.dat", ...runtimeFiles, "runtime-manifest.json"].map(
            async (fileName) => [fileName, await readFile(path.join(upgraded, fileName))] as const
          )
        )
      );
      await expect(
        installPlugin({
          vaultPath: vault,
          projectRoot: process.cwd(),
          afterActivation: async (directory: string) =>
            writeFile(path.join(directory, "main.js"), "corrupted post-activation artifact\n"),
        })
      ).rejects.toThrow("Runtime artifact verification failed: main.js");
      for (const [fileName, bytes] of before)
        await expect(readFile(path.join(upgraded, fileName))).resolves.toEqual(bytes);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects stale runtime artifact pairs before activation", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "trama-vault-"));
    const project = await mkdtemp(path.join(os.tmpdir(), "trama-project-"));
    try {
      await mkdir(path.join(vault, ".obsidian", "plugins", "trama"), { recursive: true });
      await mkdir(path.join(project, ".cache"), { recursive: true });
      const build = JSON.parse(
        await readFile(path.join(process.cwd(), ".cache/runtime-build.json"), "utf8")
      );
      await writeFile(path.join(project, ".cache/runtime-build.json"), JSON.stringify(build));
      const staleId = "00000000-0000-4000-8000-000000000000";
      for (const fileName of runtimeFiles) {
        let contents = await readFile(path.join(process.cwd(), fileName));
        if (fileName === "main.js" || fileName === "sqlite-worker.mjs")
          contents = Buffer.from(contents.toString().split(build.buildId).join(staleId));
        await writeFile(path.join(project, fileName), contents);
      }
      const live = path.join(vault, ".obsidian", "plugins", "trama");
      await writeFile(path.join(live, "main.js"), "sentinel runtime\n");
      await writeFile(path.join(live, "data.json"), '{"sentinel":true}\n');
      await writeFile(path.join(live, "unknown.dat"), "preserve\n");
      const before = new Map(
        await Promise.all(
          ["main.js", "data.json", "unknown.dat"].map(
            async (fileName) => [fileName, await readFile(path.join(live, fileName))] as const
          )
        )
      );

      await expect(installPlugin({ vaultPath: vault, projectRoot: project })).rejects.toThrow(
        "Runtime build identity mismatch"
      );
      for (const [fileName, bytes] of before)
        await expect(readFile(path.join(live, fileName))).resolves.toEqual(bytes);
      expect(
        (await readdir(path.join(vault, ".obsidian", "plugins"))).filter(
          (name) => name.startsWith(".trama-stage-") || name.startsWith("trama.backup-")
        )
      ).toEqual([]);
    } finally {
      await rm(vault, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  }, 60_000);
});
