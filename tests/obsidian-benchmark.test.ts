import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseBenchmarkManifest, readBenchmarkManifest } from "@/benchmark/Manifest";
import { benchmarkFixtureVector, benchmarkVector } from "@/benchmark/ObsidianBenchmark";
import { expectedOutputsV1ByProfile as browserOracles } from "@/benchmark/Oracle";
// Filesystem projections keep safety tests away from the real persistent vault.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    realpath: vi.fn(actual.realpath),
    writeFile: vi.fn(actual.writeFile),
  };
});
// The host harness is Node ESM and intentionally outside the plugin TypeScript bundle.
const {
  benchmarkCliArgs,
  benchmarkVaultPath,
  checkCorpus,
  installBenchmarkPlugin,
  validateReport,
  verifyCliTarget,
  REQUIRED_BENCHMARK_GATES,
} =
  // @ts-expect-error No declaration is emitted for the standalone host script.
  await import("../scripts/benchmark/obsidian.mjs");
import {
  createWorkload,
  deterministicEmbeddingVector,
  workloadQueryVectorDigest,
  workloadSourceDigest,
} from "../test-vaults/benchmark/generator";
import {
  deterministicProviderChallengeSha256,
  expectedOutputsV1ByProfile,
  queryVectorSha256V1,
  sourceDigestsV1,
} from "../test-vaults/benchmark/contract-v1";

const marker = {
  version: "trama-obsidian-vault-v1",
  runId: "d802aace-b48f-4ce1-a0c3-e6d9224c9001",
  vaultName: "Trama Benchmark Vault",
  expectedPath:
    "/Users/andreacasarin/Documents/Code/trama/.artifacts/test-vaults/benchmark/Trama Benchmark Vault",
  profile: "trama-small",
  noteCount: 24,
  targetChunks: 128,
  sourceDigest: sourceDigestsV1["trama-small"],
  providerChallengeSha256: deterministicProviderChallengeSha256,
  queryVectorSha256: queryVectorSha256V1,
  timeoutMs: 300000,
  mutations: [
    { kind: "add", path: "mutations/added.md", content: "added" },
    { kind: "modify", path: "notes/00006/note-6.md", content: "modified" },
    { kind: "delete", path: "notes/00007/note-7.md" },
    { kind: "rename", path: "notes/00008/note-8.md", to: "mutations/renamed.md" },
  ],
};

function projectedVault() {
  const vaultPath = benchmarkVaultPath("trama-small", marker.runId);
  const files = new Map<string, string>([
    [
      path.join(vaultPath, ".trama-benchmark-vault"),
      JSON.stringify({ ...marker, expectedPath: vaultPath }),
    ],
    [path.join(vaultPath, ".obsidian/community-plugins.json"), "[]"],
  ]);
  const symlinks = new Set<string>();
  const directories = () => {
    const result = new Set<string>();
    for (const file of files.keys()) {
      for (
        let parent = path.dirname(file);
        parent !== path.dirname(parent);
        parent = path.dirname(parent)
      )
        result.add(parent);
    }
    return result;
  };
  vi.mocked(realpath).mockImplementation(async (file) => String(file) as never);
  vi.mocked(lstat).mockImplementation(async (file) => {
    const name = String(file);
    if (!files.has(name) && !directories().has(name))
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return {
      isSymbolicLink: () => symlinks.has(name),
      isDirectory: () => directories().has(name),
    } as never;
  });
  vi.mocked(readFile).mockImplementation(async (file) => {
    const content = files.get(String(file));
    if (content === undefined) throw new Error("missing");
    return content as never;
  });
  vi.mocked(writeFile).mockImplementation(async (file, content) => {
    files.set(String(file), String(content));
  });
  vi.mocked(readdir).mockImplementation(async (directory) => {
    const prefix = `${directory}/`;
    return [
      ...new Set(
        [...files.keys()]
          .filter((file) => file.startsWith(prefix))
          .map((file) => file.slice(prefix.length).split("/")[0])
      ),
    ] as never;
  });
  return { vaultPath, files, symlinks };
}

describe("Obsidian benchmark safety and parity", () => {
  beforeEach(() => vi.resetAllMocks());
  it("accepts only the exact versioned generated-vault marker", async () => {
    expect(parseBenchmarkManifest(JSON.stringify(marker), marker.vaultName)).toEqual(marker);
    for (const altered of [
      { ...marker, version: "other" },
      { ...marker, vaultName: "main" },
      { ...marker, profile: "other" },
      { ...marker, expectedPath: `/repo/test-vaults/benchmark/${marker.vaultName}` },
      { ...marker, expectedPath: `/repo/.artifacts/trama-benchmark/${marker.vaultName}` },
      { ...marker, mutations: [{ kind: "delete", path: "../main.md" }] },
      { ...marker, timeoutMs: 0 },
    ])
      expect(parseBenchmarkManifest(JSON.stringify(altered), marker.vaultName)).toBeNull();
    expect(
      await readBenchmarkManifest({ read: async () => JSON.stringify(marker) }, marker.vaultName)
    ).toEqual(marker);
    expect(
      await readBenchmarkManifest(
        {
          read: async () => {
            throw new Error("missing");
          },
        },
        marker.vaultName
      )
    ).toBeNull();
  });

  it("matches the v1 provider vectors including fixed ties", async () => {
    for (const text of [
      "",
      "anchor alpha",
      "naïve café 東京",
      "provider fixture challenge",
      "line one\nline two",
    ]) {
      expect(Array.from(await benchmarkVector(text))).toEqual(
        Array.from(deterministicEmbeddingVector(text))
      );
    }
    expect(Array.from(await benchmarkVector("fixed-tie", true))).toEqual(
      Array.from(deterministicEmbeddingVector("fixed-tie", "tie"))
    );
  });

  it("matches source, query, note and mutation provider fixtures", async () => {
    expect(browserOracles).toEqual(expectedOutputsV1ByProfile);
    const workload = createWorkload("trama-small");
    expect(workloadSourceDigest(workload)).toBe(sourceDigestsV1["trama-small"]);
    expect(workloadQueryVectorDigest(workload)).toBe(queryVectorSha256V1);
    for (const note of [
      ...workload.notes,
      ...workload.mutations.flatMap((mutation) => (mutation.note ? [mutation.note] : [])),
    ]) {
      for (const chunk of note.chunks) {
        expect(Array.from(await benchmarkFixtureVector(chunk.embeddingInput))).toEqual(
          Array.from(chunk.vector)
        );
      }
    }
    for (const query of workload.queries)
      expect(Array.from(await benchmarkFixtureVector(query.text))).toEqual(
        Array.from(query.vector)
      );
  });

  it("refuses non-benchmark CLI targets and mismatched reports", () => {
    expect(benchmarkVaultPath("trama-small", marker.runId)).toMatch(
      /\.artifacts\/test-vaults\/benchmark\/Trama Benchmark Vault$/
    );
    expect(() => benchmarkVaultPath("../../main")).toThrow();
    expect(benchmarkVaultPath("trama-large", randomUUID())).toBe(
      benchmarkVaultPath("trama-small", marker.runId)
    );
    expect(benchmarkVaultPath("trama-small", marker.runId)).not.toContain(".artifacts/benchmarks/");
    expect(
      benchmarkCliArgs(marker.vaultName, "command", ["id=trama:run-obsidian-benchmark"])
    ).toEqual([`vault=${marker.vaultName}`, "command", "id=trama:run-obsidian-benchmark"]);
    expect(() => benchmarkCliArgs("main", "command")).toThrow();
    expect(() => benchmarkCliArgs(marker.vaultName, "vaults", ["verbose"])).toThrow();
    expect(benchmarkCliArgs(marker.vaultName, "plugin:enable", ["id=trama"])).toEqual([
      `vault=${marker.vaultName}`,
      "plugin:enable",
      "id=trama",
    ]);
    expect(benchmarkCliArgs(marker.vaultName, "plugins:restrict")).toEqual([
      `vault=${marker.vaultName}`,
      "plugins:restrict",
    ]);
    const report = {
      version: "trama-obsidian-report-v1",
      runId: marker.runId,
      profile: marker.profile,
      host: "obsidian-desktop",
      runtime: "worker-wasm-opfs",
      storage: "fresh-opfs-identity",
      transport: "browser-worker",
      publication: "in-memory",
      diagnosticsMode: "scoped-performance",
      workloadContractVersion: "trama-workload-contract-v1",
      oracleVersion: "expected-outputs-v1",
      memory: { rssBytes: "unsupported" },
      boundaries: ["publication filesystem adapter excluded"],
      sourceDigest: marker.sourceDigest,
      providerChallengeSha256: marker.providerChallengeSha256,
      queryVectorSha256: marker.queryVectorSha256,
      status: "completed",
      correctness: Object.fromEntries(REQUIRED_BENCHMARK_GATES.map((gate: string) => [gate, true])),
    };
    expect(validateReport(report, marker)).toEqual(report);
    expect(() => validateReport({ ...report, status: "timeout" }, marker)).toThrow();
    expect(() => validateReport({ ...report, correctness: { all: false } }, marker)).toThrow();
  });

  it("aborts when the targeted CLI selector resolves to another path", async () => {
    const { vaultPath } = projectedVault();
    const name = marker.vaultName;
    const calls: string[][] = [];
    await expect(
      verifyCliTarget(vaultPath, name, async (target: string, command: string, args: string[]) => {
        calls.push(benchmarkCliArgs(target, command, args));
        return { stdout: "/different/vault\n" };
      })
    ).rejects.toThrow("did not resolve");
    expect(calls).toEqual([[`vault=${name}`, "vault", "info=path"]]);
  });

  it("installs only inside an exact marked vault and rejects symlinked config", async () => {
    const { vaultPath, files, symlinks } = projectedVault();
    const name = marker.vaultName;
    const obsidian = path.join(vaultPath, ".obsidian");
    const installs: unknown[] = [];
    await installBenchmarkPlugin(vaultPath, name, async (args: unknown) => {
      installs.push(args);
    });
    expect(installs).toEqual([{ vaultPath, preserveExistingFiles: true }]);
    expect(await readFile(path.join(obsidian, "community-plugins.json"), "utf8")).toBe(
      '["trama"]\n'
    );
    await writeFile(path.join(obsidian, "community-plugins.json"), '["other"]\n');
    await expect(installBenchmarkPlugin(vaultPath, name, async () => {})).rejects.toThrow(
      "non-benchmark community plugin"
    );
    files.set(path.join(obsidian, "community-plugins.json"), "[]");
    symlinks.add(path.join(obsidian, "community-plugins.json"));
    await expect(installBenchmarkPlugin(vaultPath, name, async () => {})).rejects.toThrow(
      "symlinked benchmark install path"
    );
  });

  it("accepts only known fixture states and never resets edited or unexpected content", async () => {
    const { vaultPath, files, symlinks } = projectedVault();
    const workload = createWorkload("trama-small");
    for (const note of workload.notes) files.set(path.join(vaultPath, note.path), note.content);
    await expect(checkCorpus(vaultPath, workload, true)).resolves.toBeUndefined();
    const notePath = path.join(vaultPath, workload.notes[0].path);
    files.set(notePath, "my handwritten note");
    await expect(checkCorpus(vaultPath, workload)).rejects.toThrow("edited benchmark file");
    files.set(notePath, workload.notes[0].content);
    files.set(path.join(vaultPath, "personal.md"), "unexpected");
    await expect(checkCorpus(vaultPath, workload)).rejects.toThrow(
      "Unexpected benchmark vault content"
    );
    files.delete(path.join(vaultPath, "personal.md"));
    symlinks.add(notePath);
    await expect(checkCorpus(vaultPath, workload)).rejects.toThrow("symlink");
    symlinks.delete(notePath);
    files.delete(notePath);
    await expect(checkCorpus(vaultPath, workload, true)).rejects.toThrow("incomplete");
    expect(writeFile).not.toHaveBeenCalled();
  });
});
