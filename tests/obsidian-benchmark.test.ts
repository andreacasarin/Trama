import { afterEach, describe, expect, it, vi } from "vitest";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createSimpleBenchmarkCorpus } from "../test-vaults/benchmark/generator";
import {
  BENCHMARK_EXPECTED_PATH,
  BENCHMARK_CORPUS_SHA256,
  BENCHMARK_MARKER_VERSION,
  BENCHMARK_NOTE_COUNT,
  BENCHMARK_VAULT_NAME,
  parseBenchmarkManifest,
} from "@/benchmark/Manifest";
import { runObsidianBenchmark } from "@/benchmark/ObsidianBenchmark";
import { sha256Hex } from "@/index/Identity";
import { chunkMarkdownBlocks } from "@/index/chunking";
import {
  benchmarkCliArgs,
  benchmarkDispatchEval,
  benchmarkIdleFailures,
  benchmarkVaultName,
  benchmarkVaultPath,
  attachBenchmarkDebugger,
  assertBenchmarkDispatchReceipt,
  childErrorObservation,
  parseReadinessStdout,
  reloadBenchmarkWindow,
  runBenchmarkOnce,
  validateMarkedVaultRoot,
  verifyCliTarget,
  verifyBenchmarkIdle,
  waitForBenchmarkCommand,
  withFixtureEmbeddingSettings,
  // @ts-expect-error The Node host runner is JavaScript and intentionally has no runtime type surface.
} from "../scripts/benchmark/obsidian.mjs";

// CLI-boundary tests model a marked generated vault without reading a local vault.
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    lstat: vi.fn(original.lstat),
    realpath: vi.fn(original.realpath),
    readFile: vi.fn(original.readFile),
  };
});

afterEach(() => {
  vi.mocked(lstat).mockReset();
  vi.mocked(realpath).mockReset();
  vi.mocked(readFile).mockReset();
});

function mockMarkedCliVault(markerReads: number) {
  vi.mocked(realpath).mockImplementation(async (file) => String(file));
  vi.mocked(lstat).mockResolvedValue({
    isSymbolicLink: () => false,
  } as Awaited<ReturnType<typeof lstat>>);
  for (let i = 0; i < markerReads; i++)
    vi.mocked(readFile).mockResolvedValueOnce(
      JSON.stringify({
        version: BENCHMARK_MARKER_VERSION,
        vaultName: BENCHMARK_VAULT_NAME,
        expectedPath: benchmarkVaultPath,
        noteCount: BENCHMARK_NOTE_COUNT,
        corpusSha256: BENCHMARK_CORPUS_SHA256,
      })
    );
}

describe("simple Obsidian benchmark", () => {
  it("builds the same exact 3,000-note, 400-character corpus each time", () => {
    const first = createSimpleBenchmarkCorpus();
    const second = createSimpleBenchmarkCorpus();
    expect(first).toEqual(second);
    expect(first.notes).toHaveLength(3000);
    expect(first.notes.every((note) => note.content.length === 400)).toBe(true);
    expect(first.notes.every((note) => chunkMarkdownBlocks(note.content).length === 2)).toBe(true);
    expect(first.notes[0]?.path).toBe("notes/0000.md");
    expect(first.notes[0]?.content).toContain("D5 lexical sentinel unique phrase");
    expect(first.notes[1]?.content).toBe(first.notes[2]?.content);
    expect(first.sha256).toBe(BENCHMARK_CORPUS_SHA256);
  });

  it("accepts only the marked 3,000-note corpus at the exact vault path", () => {
    const marker = {
      version: BENCHMARK_MARKER_VERSION,
      corpusSha256: BENCHMARK_CORPUS_SHA256,
      vaultName: BENCHMARK_VAULT_NAME,
      expectedPath: BENCHMARK_EXPECTED_PATH,
      noteCount: BENCHMARK_NOTE_COUNT,
    };
    expect(parseBenchmarkManifest(JSON.stringify(marker), BENCHMARK_VAULT_NAME)).toEqual(marker);
    expect(
      parseBenchmarkManifest(
        JSON.stringify({ ...marker, expectedPath: "/personal/vault" }),
        BENCHMARK_VAULT_NAME
      )
    ).toBeNull();
    expect(
      parseBenchmarkManifest(JSON.stringify({ ...marker, noteCount: 24 }), BENCHMARK_VAULT_NAME)
    ).toBeNull();
  });

  it("refreshes only the fixture embedding endpoint and model while preserving other settings", () => {
    const settings = {
      schemaVersion: 6,
      diagnosticsMode: "performance",
      automaticMaintenance: false,
      embedding: {
        endpoint: "http://127.0.0.1:50665/v1",
        modelId: "trama-benchmark-fixture-old",
        dimensions: 768,
        batchSize: 32,
        custom: "preserved",
      },
      chat: { endpoint: "http://127.0.0.1:50665/v1", modelId: "chat-preserved" },
      unrelated: { value: true },
    };
    const updated = withFixtureEmbeddingSettings(settings);
    expect(updated).toEqual({
      ...settings,
      embedding: {
        ...settings.embedding,
        endpoint: "http://127.0.0.1:18765/v1",
        modelId: "trama-benchmark-fixture-v1",
      },
    });
    expect(withFixtureEmbeddingSettings(updated)).toEqual(updated);
    expect(() => withFixtureEmbeddingSettings({ ...settings, embedding: null })).toThrow(
      "Benchmark embedding settings must be an object"
    );
  });

  it("keeps the CLI selector first and the command allowlist narrow", () => {
    expect(benchmarkCliArgs(benchmarkVaultName, "vault", ["info=path"])).toEqual([
      "vault=Trama Benchmark Vault",
      "vault",
      "info=path",
    ]);
    expect(benchmarkCliArgs(benchmarkVaultName, "reload")).toEqual([
      "vault=Trama Benchmark Vault",
      "reload",
    ]);
    expect(benchmarkCliArgs(benchmarkVaultName, "eval", [`code=${benchmarkDispatchEval}`])).toEqual(
      ["vault=Trama Benchmark Vault", "eval", `code=${benchmarkDispatchEval}`]
    );
    expect(() => benchmarkCliArgs("Personal", "vault", ["info=path"])).toThrow();
    expect(() => benchmarkCliArgs(benchmarkVaultName, "eval", ["code=app.vault"])).toThrow();
    expect(
      benchmarkCliArgs(benchmarkVaultName, "dev:console", ["level=error", "limit=2000"])
    ).toEqual(["vault=Trama Benchmark Vault", "dev:console", "level=error", "limit=2000"]);
    expect(() =>
      benchmarkCliArgs(benchmarkVaultName, "command", ["id=trama:reset-all-indexes-benchmark"])
    ).toThrow();
  });

  it("retains original bounded CLI failure details before wrapping", () => {
    const original = Object.assign(new Error("obsidian failed for /Users/private/user"), {
      code: 1,
      signal: null,
      killed: false,
      stdout: "Error: command failed",
      stderr: "original stderr",
    });
    expect(childErrorObservation("debug-attach", original)).toEqual({
      stage: "debug-attach",
      error: {
        name: "Error",
        message: "obsidian failed for <path>",
        code: 1,
        exitCode: 1,
        signal: null,
        killed: false,
        timedOut: false,
      },
      stdout: "Error: command failed",
      stderr: "original stderr",
    });
  });

  it("parses only bare JSON or the observed Obsidian arrow-wrapped readiness output", () => {
    const state = { plugin: true, paths: ["notes/0000.md"] };
    expect(parseReadinessStdout(JSON.stringify(state))).toEqual(state);
    expect(parseReadinessStdout(`=> ${JSON.stringify(state)}`)).toEqual(state);
    expect(() => parseReadinessStdout(`=> ${JSON.stringify(JSON.stringify(state))}`)).toThrow();
    expect(() => parseReadinessStdout(`=> ${JSON.stringify(state)} trailing output`)).toThrow();
    expect(() => parseReadinessStdout(`CLI output: => ${JSON.stringify(state)}`)).toThrow();
  });

  it("requires both synchronous dispatch receipt fields", () => {
    expect(
      assertBenchmarkDispatchReceipt(JSON.stringify({ invoked: true, running: true }))
    ).toEqual({
      invoked: true,
      running: true,
    });
    expect(() =>
      assertBenchmarkDispatchReceipt(JSON.stringify({ invoked: true, running: false }))
    ).toThrow("Benchmark dispatch did not start.");
    expect(() =>
      assertBenchmarkDispatchReceipt(JSON.stringify({ invoked: false, running: true }))
    ).toThrow("Benchmark dispatch did not start.");
  });

  it("uses only the tiny idle projection and refuses active or unknown state", () => {
    const idle = {
      pluginPresent: true,
      loadResult: true,
      running: false,
      resetting: false,
      lane: "idle",
    };
    expect(benchmarkIdleFailures(idle)).toEqual([]);
    expect(benchmarkIdleFailures({ ...idle, running: true })).toContain("running-or-unknown");
    expect(benchmarkIdleFailures({ ...idle, resetting: undefined })).toContain(
      "resetting-or-unknown"
    );
    expect(benchmarkIdleFailures({ ...idle, lane: undefined })).toContain("lane");
  });

  it("requires exact benchmark path proof at the CLI boundary", async () => {
    mockMarkedCliVault(3);
    const stage = "benchmark-dispatch";
    await expect(
      validateMarkedVaultRoot(benchmarkVaultPath, BENCHMARK_VAULT_NAME)
    ).resolves.toMatchObject({
      version: BENCHMARK_MARKER_VERSION,
      vaultName: BENCHMARK_VAULT_NAME,
      expectedPath: benchmarkVaultPath,
      noteCount: BENCHMARK_NOTE_COUNT,
      corpusSha256: BENCHMARK_CORPUS_SHA256,
    });
    await expect(validateMarkedVaultRoot(benchmarkVaultPath, "Personal")).rejects.toThrow(
      "Refusing a vault outside the exact benchmark output path."
    );
    const goodInvoke = vi.fn(async (command: string, parameters: string[]) => {
      expect([command, parameters]).toEqual(["vault", ["info=path"]]);
      return { stdout: `${benchmarkVaultPath}\n` };
    });
    await expect(
      verifyCliTarget(benchmarkVaultPath, BENCHMARK_VAULT_NAME, stage, goodInvoke)
    ).resolves.toBeUndefined();

    const failedInvoke = vi.fn(async () => ({ stdout: "/private/other-vault\n" }));
    await expect(
      verifyCliTarget(benchmarkVaultPath, BENCHMARK_VAULT_NAME, stage, failedInvoke)
    ).rejects.toThrow(`failed at ${stage}: single-absolute`);
    expect(failedInvoke).toHaveBeenCalledWith("vault", ["info=path"]);
  });

  it("saves bounded path-proof stdout and stderr with the failure", async () => {
    mockMarkedCliVault(1);
    const stdout = "Error: Obsidian CLI is not ready.\n";
    const stderr = "retry after window load\n";
    let failure: unknown;
    try {
      await verifyCliTarget(
        benchmarkVaultPath,
        BENCHMARK_VAULT_NAME,
        "post-reload-idle",
        async () => ({ stdout, stderr })
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      pathProof: { stage: "post-reload-idle", classification: "known-error-prefix" },
    });
    const artifact = (failure as Error & { pathProof: { artifact: string } }).pathProof.artifact;
    await expect(readFile(artifact, "utf8").then(JSON.parse)).resolves.toMatchObject({
      stage: "path-proof-post-reload-idle",
      stdout,
      stderr,
    });
  });

  it("keeps initial readiness plain and leaves capture refresh for the dispatch boundary", async () => {
    const state = {
      pluginPresent: true,
      loadResult: true,
      running: false,
      resetting: false,
      lane: "idle",
    };
    const order: string[] = [];
    const verifyPath = vi.fn(async () => order.push("path"));
    const readReadiness = vi.fn(async (stage: string) => {
      expect(stage).toBe("initial-idle");
      order.push("eval");
      return state;
    });
    await verifyBenchmarkIdle(BENCHMARK_EXPECTED_PATH, BENCHMARK_VAULT_NAME, "initial-idle", {
      verifyPath,
      readReadiness,
    });
    expect(order).toEqual(["path", "eval"]);

    const refusedReadiness = vi.fn(async () => state);
    await verifyBenchmarkIdle(BENCHMARK_EXPECTED_PATH, BENCHMARK_VAULT_NAME, "initial-idle", {
      verifyPath,
      readReadiness: refusedReadiness,
    });
    expect(refusedReadiness).toHaveBeenCalledOnce();
  });

  it("retries transient path proofs after reload before evaluating readiness", async () => {
    const order: string[] = [];
    const transient = Object.assign(new Error("proof unavailable"), {
      pathProof: { stage: "post-reload-idle", classification: "known-error-prefix" },
    });
    let elapsed = 0;
    let proofs = 0;
    const state = {
      pluginPresent: true,
      loadResult: true,
      running: false,
      resetting: false,
      lane: "idle",
      timeOrigin: 101,
    };
    await expect(
      verifyBenchmarkIdle(BENCHMARK_EXPECTED_PATH, BENCHMARK_VAULT_NAME, "post-reload-idle", {
        afterTimeOrigin: 100,
        verifyPath: async () => {
          order.push("proof");
          if (proofs++ === 0) throw transient;
        },
        readReadiness: async () => {
          order.push("eval");
          if (order.filter((entry) => entry === "proof").length !== 2)
            throw new Error("eval ran before a successful proof");
          return state;
        },
        wait: async (duration: number) => {
          order.push("wait");
          elapsed += duration;
        },
        now: () => elapsed,
      })
    ).resolves.toEqual(state);
    expect(order).toEqual(["proof", "wait", "proof", "eval"]);
  });

  it("retries a transient readiness path proof inside the same reload deadline", async () => {
    const transient = Object.assign(new Error("proof unavailable"), {
      pathProof: { stage: "post-reload-idle", classification: "empty" },
    });
    let elapsed = 0;
    let reads = 0;
    const state = {
      pluginPresent: true,
      loadResult: true,
      running: false,
      resetting: false,
      lane: "idle",
      timeOrigin: 101,
    };
    await expect(
      verifyBenchmarkIdle(BENCHMARK_EXPECTED_PATH, BENCHMARK_VAULT_NAME, "post-reload-idle", {
        afterTimeOrigin: 100,
        verifyPath: async () => undefined,
        readReadiness: async () => {
          if (reads++ === 0) throw transient;
          return state;
        },
        wait: async (duration: number) => {
          elapsed += duration;
        },
        now: () => elapsed,
      })
    ).resolves.toEqual(state);
    expect(reads).toBe(2);
    expect(elapsed).toBe(1000);
  });

  it("waits for a new renderer and plugin load, then accepts its known active lane", async () => {
    const oldIdle = {
      pluginPresent: true,
      loadResult: true,
      running: false,
      resetting: false,
      lane: "idle",
      timeOrigin: 100,
    };
    const pluginStarting = {
      ...oldIdle,
      pluginPresent: false,
      loadResult: undefined,
      timeOrigin: 101,
    };
    const newLoading = { ...oldIdle, loadResult: null, lane: "adoption", timeOrigin: 102 };
    const loadedAdoption = { ...oldIdle, lane: "adoption", timeOrigin: 103 };
    const states = [oldIdle, pluginStarting, newLoading, loadedAdoption];
    let elapsed = 0;
    const readReadiness = vi.fn(async () => states.shift());
    const wait = vi.fn(async (duration: number) => {
      elapsed += duration;
    });
    await expect(
      verifyBenchmarkIdle(BENCHMARK_EXPECTED_PATH, BENCHMARK_VAULT_NAME, "post-reload-idle", {
        afterTimeOrigin: 100,
        verifyPath: async () => undefined,
        readReadiness,
        wait,
        now: () => elapsed,
      })
    ).resolves.toEqual(loadedAdoption);
    expect(readReadiness).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(3);
    expect(elapsed).toBe(3000);
  });

  it("keeps wrong, multiline, and CLI-error proofs strict and shares the reload deadline", async () => {
    const idle = {
      pluginPresent: true,
      loadResult: true,
      running: false,
      resetting: false,
      lane: "idle",
      timeOrigin: 101,
    };
    for (const classification of ["single-absolute", "multiline", "cli-error"]) {
      const error = Object.assign(new Error("invalid proof"), {
        pathProof: { stage: "post-reload-idle", classification },
      });
      const readReadiness = vi.fn(async () => idle);
      const wait = vi.fn(async () => undefined);
      await expect(
        verifyBenchmarkIdle(BENCHMARK_EXPECTED_PATH, BENCHMARK_VAULT_NAME, "post-reload-idle", {
          afterTimeOrigin: 100,
          verifyPath: async () => {
            throw error;
          },
          readReadiness,
          wait,
        })
      ).rejects.toBe(error);
      expect(readReadiness).not.toHaveBeenCalled();
      expect(wait).not.toHaveBeenCalled();
    }

    let elapsed = 0;
    let attempts = 0;
    const transient = Object.assign(new Error("temporary proof error"), {
      pathProof: { stage: "post-reload-idle", classification: "known-error-prefix" },
    });
    await expect(
      verifyBenchmarkIdle(BENCHMARK_EXPECTED_PATH, BENCHMARK_VAULT_NAME, "post-reload-idle", {
        afterTimeOrigin: 100,
        verifyPath: async () => {
          attempts += 1;
          throw transient;
        },
        readReadiness: async () => idle,
        wait: async (duration: number) => {
          elapsed += duration;
        },
        now: () => elapsed,
      })
    ).rejects.toThrow("CLI path proof did not succeed before the readiness deadline");
    expect(elapsed).toBe(90_000);
    expect(attempts).toBe(90);

    const strictInitialPath = vi.fn(async () => {
      throw Object.assign(new Error("temporary proof error"), {
        pathProof: { stage: "initial-idle", classification: "known-error-prefix" },
      });
    });
    const initialReadiness = vi.fn(async () => idle);
    await expect(
      verifyBenchmarkIdle(BENCHMARK_EXPECTED_PATH, BENCHMARK_VAULT_NAME, "initial-idle", {
        verifyPath: strictInitialPath,
        readReadiness: initialReadiness,
      })
    ).rejects.toThrow("temporary proof error");
    expect(strictInitialPath).toHaveBeenCalledOnce();
    expect(initialReadiness).not.toHaveBeenCalled();
  });

  it("refreshes capture once at dispatch and retries only the observed missing-command response", async () => {
    const responses = [
      { stdout: "Debugger detached. Console capture stopped.\n", stderr: "" },
      {
        stdout: 'Error: Command "dev:debug" not found. It may require a plugin to be enabled.\n',
        stderr: "",
      },
      { stdout: "Debugger attached. Console capture started.\n", stderr: "" },
    ];
    const calls: string[] = [];
    const wait = vi.fn(async () => undefined);
    let tick = 0;
    await attachBenchmarkDebugger({
      invoke: async (_command: string, parameters: string[]) => {
        calls.push(parameters[0]);
        return responses.shift();
      },
      wait,
      now: () => tick++ * 1000,
    });
    expect(calls).toEqual(["off", "on", "on"]);
    expect(wait).toHaveBeenCalledOnce();

    const order: string[] = [];
    const report = {
      version: "trama-simple-benchmark-report-v1",
      corpusSha256: BENCHMARK_CORPUS_SHA256,
      noteCount: 3000,
      runId: "11111111-1111-4111-8111-111111111111",
      status: "completed",
      correctness: Object.fromEntries(
        [
          "corpusNoteCount",
          "corpusPaths",
          "coldIndex",
          "cacheCleared",
          "indexedAllNotes",
          "semanticReady",
          "lexicalSentinel",
          "hybridSentinel",
          "relatedSentinel",
          "cacheShardsPublished",
          "cacheShardHashesValid",
          "cacheShardCheckStable",
        ].map((field) => [field, true])
      ),
    };
    await runBenchmarkOnce({
      assertFreshReport: async () => order.push("fresh-report-check"),
      beforeDispatch: async () => order.push("capture-refresh"),
      dispatch: async () => {
        order.push("dispatch");
        return { exitCode: 0, stdout: "Executed: trama:run-obsidian-benchmark", stderr: "" };
      },
      waitForReport: async () => report,
      captureConsole: async () =>
        `[Trama] benchmark_started ${report.runId}\n[Trama] benchmark_finished ${report.runId}`,
      saveConsole: async () => undefined,
    });
    expect(order).toEqual(["fresh-report-check", "capture-refresh", "dispatch"]);
  });

  it("waits only for known maintenance lanes, with a fixed idle deadline", async () => {
    const idle = {
      pluginPresent: true,
      loadResult: true,
      running: false,
      resetting: false,
      lane: "idle",
    };
    const states = [
      { ...idle, loadResult: null, lane: "adoption" },
      { ...idle, lane: "adoption" },
      idle,
    ];
    const wait = vi.fn(async () => undefined);
    const readReadiness = vi.fn(async () => states.shift());
    await expect(
      verifyBenchmarkIdle(BENCHMARK_EXPECTED_PATH, BENCHMARK_VAULT_NAME, "initial-idle", {
        verifyPath: async () => undefined,
        readReadiness,
        wait,
      })
    ).resolves.toEqual(idle);
    expect(readReadiness).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);

    const badStates = [
      { ...idle, lane: "unknown" },
      { ...idle, lane: "adoption", running: true },
      { ...idle, lane: "adoption", resetting: undefined },
      { ...idle, loadResult: false, lane: "adoption" },
      { ...idle, loadResult: "unknown", lane: "adoption" },
    ];
    for (const state of badStates) {
      const read = vi.fn(async () => state);
      await expect(
        verifyBenchmarkIdle(BENCHMARK_EXPECTED_PATH, BENCHMARK_VAULT_NAME, "initial-idle", {
          verifyPath: async () => undefined,
          readReadiness: read,
          wait,
        })
      ).rejects.toThrow(
        state.lane === "unknown"
          ? "unknown maintenance lane"
          : state.loadResult === "unknown"
            ? "load-unknown"
            : "not loaded and idle"
      );
      expect(read).toHaveBeenCalledTimes(1);
    }

    let elapsed = 0;
    const unchangedEpoch = { ...idle, timeOrigin: 100 };
    const oldRendererRead = vi.fn(async () => unchangedEpoch);
    await expect(
      verifyBenchmarkIdle(BENCHMARK_EXPECTED_PATH, BENCHMARK_VAULT_NAME, "post-reload-idle", {
        afterTimeOrigin: 100,
        verifyPath: async () => undefined,
        readReadiness: oldRendererRead,
        wait: async (duration: number) => {
          elapsed += duration;
        },
        now: () => elapsed,
      })
    ).rejects.toThrow("renderer did not reload before the readiness deadline");
    expect(oldRendererRead).toHaveBeenCalledTimes(90);
    expect(elapsed).toBe(90_000);

    await expect(
      verifyBenchmarkIdle(BENCHMARK_EXPECTED_PATH, BENCHMARK_VAULT_NAME, "post-reload-idle", {
        afterTimeOrigin: 100,
        verifyPath: async () => undefined,
        readReadiness: async () => ({ ...idle, timeOrigin: "invalid" }),
      })
    ).rejects.toThrow("renderer epoch after reload is invalid");

    await expect(
      verifyBenchmarkIdle(BENCHMARK_EXPECTED_PATH, BENCHMARK_VAULT_NAME, "post-reload-idle", {
        afterTimeOrigin: 100,
        verifyPath: async () => undefined,
        readReadiness: async () => ({ ...idle, timeOrigin: 101, loadResult: false }),
      })
    ).rejects.toThrow("load-failed");

    await expect(
      verifyBenchmarkIdle(BENCHMARK_EXPECTED_PATH, BENCHMARK_VAULT_NAME, "post-reload-idle", {
        afterTimeOrigin: 100,
        verifyPath: async () => undefined,
        readReadiness: async () => ({ ...idle, timeOrigin: 101, loadResult: "unknown" }),
      })
    ).rejects.toThrow("load state after reload is invalid");

    await expect(
      verifyBenchmarkIdle(BENCHMARK_EXPECTED_PATH, BENCHMARK_VAULT_NAME, "post-reload-idle", {
        afterTimeOrigin: 100,
        verifyPath: async () => undefined,
        readReadiness: async () => ({ ...idle, timeOrigin: 101, lane: "unknown" }),
      })
    ).rejects.toThrow("unknown maintenance lane");

    elapsed = 0;
    const readPersistentLane = vi.fn(async () => ({ ...idle, loadResult: null, lane: "adoption" }));
    await expect(
      verifyBenchmarkIdle(BENCHMARK_EXPECTED_PATH, BENCHMARK_VAULT_NAME, "initial-idle", {
        verifyPath: async () => undefined,
        readReadiness: readPersistentLane,
        wait: async (duration: number) => {
          elapsed += duration;
        },
        now: () => elapsed,
      })
    ).rejects.toThrow("last lane: adoption");
    expect(elapsed).toBe(90_000);
  });

  it("waits for command registration without changing capture state", async () => {
    const order: string[] = [];
    const outputs = [
      { stdout: "trama:other-command\n", stderr: "" },
      { stdout: "trama:run-obsidian-benchmark\n", stderr: "" },
    ];
    await waitForBenchmarkCommand({
      listCommands: async () => {
        order.push("commands");
        return outputs.shift() ?? "";
      },
      wait: async () => undefined,
      now: (() => {
        let tick = 0;
        return () => tick++;
      })(),
    });
    expect(order).toEqual(["commands", "commands"]);

    await expect(
      waitForBenchmarkCommand({
        listCommands: async () => ({ stdout: "trama:other-command\n", stderr: "" }),
        wait: async () => undefined,
        now: (() => {
          let tick = 0;
          return () => tick++ * 1000;
        })(),
        timeoutMs: 1500,
      })
    ).rejects.toThrow("did not register before the readiness deadline");
  });

  it("checks post-reload readiness before the single dispatch", async () => {
    const order: string[] = [];
    await reloadBenchmarkWindow(BENCHMARK_EXPECTED_PATH, {
      verifyIdle: async (_vaultPath: string, _vaultName: string, stage: string) => {
        order.push(stage);
        return { timeOrigin: stage === "post-restore-idle" ? 100 : 101 };
      },
      reload: async () => order.push("reload"),
      waitForCommand: async () => {
        order.push("command-registered");
      },
    });
    await runBenchmarkOnce({
      assertFreshReport: async () => order.push("report-absent"),
      beforeDispatch: async () => order.push("debug"),
      dispatch: async () => {
        order.push("dispatch");
        return { exitCode: 0, stdout: "Executed: trama:run-obsidian-benchmark", stderr: "" };
      },
      waitForReport: async () => undefined,
      captureConsole: async () => "",
      saveConsole: async () => undefined,
    }).catch(() => undefined);
    expect(order).toEqual([
      "post-restore-idle",
      "reload",
      "command-registered",
      "post-reload-idle",
      "report-absent",
      "debug",
      "dispatch",
    ]);
  });

  it("dispatches once only after stale-report refusal and requires fresh complete evidence", async () => {
    const order: string[] = [];
    const runId = "11111111-1111-4111-8111-111111111111";
    const report = {
      version: "trama-simple-benchmark-report-v1",
      corpusSha256: BENCHMARK_CORPUS_SHA256,
      noteCount: 3000,
      runId,
      status: "completed",
      correctness: Object.fromEntries(
        [
          "corpusNoteCount",
          "corpusPaths",
          "coldIndex",
          "cacheCleared",
          "indexedAllNotes",
          "semanticReady",
          "lexicalSentinel",
          "hybridSentinel",
          "relatedSentinel",
          "cacheShardsPublished",
          "cacheShardHashesValid",
          "cacheShardCheckStable",
        ].map((field) => [field, true])
      ),
    };
    const operations = {
      assertFreshReport: async () => order.push("freshness"),
      dispatch: async () => {
        order.push("dispatch");
        return { exitCode: 0, stdout: "Command accepted.", stderr: "" };
      },
      waitForReport: async () => {
        order.push("report");
        return report;
      },
      captureConsole: async () => {
        order.push("console");
        return `[Trama] benchmark_started ${runId}\n[Trama] benchmark_finished ${runId}`;
      },
      saveConsole: async () => order.push("save"),
    };
    await expect(runBenchmarkOnce(operations)).resolves.toBe(report);
    expect(order).toEqual(["freshness", "dispatch", "report", "console", "save"]);
    expect(order.filter((operation) => operation === "dispatch")).toHaveLength(1);
    await expect(
      runBenchmarkOnce({
        ...operations,
        assertFreshReport: async () => {
          throw new Error("Benchmark report exists before dispatch.");
        },
      })
    ).rejects.toThrow("exists before dispatch");
    await expect(
      runBenchmarkOnce({
        ...operations,
        waitForReport: async () => ({
          ...report,
          correctness: { ...report.correctness, coldIndex: false },
        }),
      })
    ).rejects.toThrow("correctness checks did not all pass");
    for (const stdout of [
      "Error: command failed",
      "Uncaught Error: unavailable",
      "Command id not found",
    ]) {
      const waitForReport = vi.fn(async () => report);
      await expect(
        runBenchmarkOnce({
          ...operations,
          dispatch: async () => ({ exitCode: 0, stdout, stderr: "" }),
          waitForReport,
        })
      ).rejects.toThrow("explicit dispatch error");
      expect(waitForReport).not.toHaveBeenCalled();
    }
  });

  it("rejects incomplete or overflowing production performance captures", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const report = {
      version: "trama-simple-benchmark-report-v1",
      corpusSha256: BENCHMARK_CORPUS_SHA256,
      noteCount: 3000,
      runId,
      status: "completed",
      startedAt: "2026-10-06T10:00:00.000Z",
      finishedAt: "2026-10-06T10:01:00.000Z",
      relatedLookup: {
        results: [{ path: "notes/0002.md", score: 1 }],
        semanticPartial: false,
        maintenanceBefore: false,
        maintenanceAfter: false,
      },
      correctness: Object.fromEntries(
        [
          "corpusNoteCount",
          "corpusPaths",
          "coldIndex",
          "cacheCleared",
          "indexedAllNotes",
          "semanticReady",
          "lexicalSentinel",
          "hybridSentinel",
          "relatedSentinel",
          "cacheShardsPublished",
          "cacheShardHashesValid",
          "cacheShardCheckStable",
        ].map((field) => [field, true])
      ),
      performanceCapture: { complete: false, records: [] },
    };
    const operations = {
      assertFreshReport: async () => undefined,
      dispatch: async () => ({ exitCode: 0, stdout: "Command accepted.", stderr: "" }),
      waitForReport: async () => report,
      captureConsole: async () => `[Trama] benchmark_finished ${runId}`,
      saveConsole: async () => undefined,
      savePerformance: async () => ".artifacts/benchmarks/diagnostics/performance.jsonl",
    };
    await expect(runBenchmarkOnce(operations)).rejects.toThrow(
      "missing, incomplete, or over its bound"
    );

    await expect(
      runBenchmarkOnce({
        ...operations,
        waitForReport: async () => ({
          ...report,
          performanceCapture: {
            complete: true,
            records: Array.from({ length: 10_001 }, () => ({ tier: "performance" })),
          },
        }),
      })
    ).rejects.toThrow("missing, incomplete, or over its bound");
  });

  it("clears local/shared indexes before the production rebuild and checks fixed sentinels", async () => {
    const corpusSha256 = BENCHMARK_CORPUS_SHA256;
    const manifest = {
      version: BENCHMARK_MARKER_VERSION,
      corpusSha256,
      vaultName: BENCHMARK_VAULT_NAME,
      expectedPath: BENCHMARK_EXPECTED_PATH,
      noteCount: BENCHMARK_NOTE_COUNT,
    } as const;
    const paths = Array.from({ length: 3000 }, (_, index) => ({
      path: `notes/${String(index).padStart(4, "0")}.md`,
    }));
    const order: string[] = [];
    const state = {
      noteCount: 3000,
      semanticReady: true,
      lexicalGeneration: 3,
      semanticGeneration: 2,
      embeddingFingerprint: "profile",
    };
    const adapter = {
      getBasePath: () => BENCHMARK_EXPECTED_PATH,
      read: async () => JSON.stringify(manifest),
      write: vi.fn(async () => undefined),
    };
    const shardBytes = new TextEncoder().encode("verified cache shard").buffer;
    const shardDigest = await sha256Hex(shardBytes);
    const shardFile = {
      path: `Trama/index/cache-v1/cache-${shardDigest}.sqlite3`,
      digest: shardDigest,
    };
    let shardReads = 0;
    const report = await runObsidianBenchmark(
      { vault: { adapter, getName: () => BENCHMARK_VAULT_NAME, getMarkdownFiles: () => paths } },
      manifest,
      {
        index: {
          getState: async () => (order.includes("rebuild") ? state : undefined),
          isInMaintenance: () => false,
        } as any,
        publication: {
          store: {
            listCacheShards: async () => (++shardReads === 1 ? [] : [shardFile]),
            readCacheShard: async () => shardBytes,
          },
        } as any,
        related: {
          find: async () => ({ results: [{ path: "notes/0002.md", score: 1 }] }),
        } as any,
        clearIndexesAndSharedCache: async () => {
          order.push("clear");
        },
        rebuild: async () => {
          order.push("rebuild");
        },
        publish: async () => {
          order.push("publish");
        },
        checkPublication: async () => {
          order.push("check");
        },
        hasPublicationCheckWarning: () => false,
        getLenteSearch: () => ({
          search: async () => ({
            results: [{ path: "notes/0000.md" }],
            canonicalResults: [{ path: "notes/0000.md" }],
          }),
        }),
      } as any
    );
    expect(order).toEqual(["clear", "rebuild", "publish", "check"]);
    expect(report.status).toBe("completed");
    expect(report.relatedLookup).toMatchObject({
      results: [{ path: "notes/0002.md", score: 1 }],
      semanticPartial: false,
      maintenanceBefore: false,
      maintenanceAfter: false,
    });
    expect(report.startedAt).toEqual(expect.any(String));
    expect(report.finishedAt).toEqual(expect.any(String));
    expect(report.correctness).toMatchObject({
      corpusNoteCount: true,
      corpusPaths: true,
      coldIndex: true,
      cacheCleared: true,
      indexedAllNotes: true,
      semanticReady: true,
      lexicalSentinel: true,
      hybridSentinel: true,
      relatedSentinel: true,
      cacheShardsPublished: true,
      cacheShardHashesValid: true,
      cacheShardCheckStable: true,
    });
  });

  it("refuses a non-exact vault path before clearing or writing", async () => {
    const marker = {
      version: BENCHMARK_MARKER_VERSION,
      corpusSha256: BENCHMARK_CORPUS_SHA256,
      vaultName: BENCHMARK_VAULT_NAME,
      expectedPath: BENCHMARK_EXPECTED_PATH,
      noteCount: BENCHMARK_NOTE_COUNT,
    } as const;
    const clear = vi.fn(async () => undefined);
    const write = vi.fn(async () => undefined);
    const report = await runObsidianBenchmark(
      {
        vault: {
          adapter: {
            getBasePath: () => "/another/vault",
            read: async () => JSON.stringify(marker),
            write,
          },
          getName: () => BENCHMARK_VAULT_NAME,
          getMarkdownFiles: () => [],
        },
      },
      marker,
      { clearIndexesAndSharedCache: clear } as any
    );
    expect(report.status).toBe("error");
    expect(clear).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
