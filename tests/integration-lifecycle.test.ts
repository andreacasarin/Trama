import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { Platform } from "obsidian";
import { TramaPlugin } from "@/plugin/TramaPlugin";
import { LenteSearch } from "@/index/LenteSearch";
import { DEFAULT_SETTINGS } from "@/settings/Settings";
import { TramaSettingsTab } from "@/ui/settings/SettingsTab";
import { createTestSqliteClient } from "./sqlite-test-client";
import { createWorkload, deterministicEmbeddingVector } from "../test-vaults/benchmark/generator";
// @ts-expect-error Standalone Node fixture server has no emitted declaration.
import { startFixtureProvider } from "../scripts/benchmark/fixture-provider.mjs";
import {
  sourceDigestsV1,
  deterministicProviderChallengeSha256,
  queryVectorSha256V1,
  expectedOutputsV1ByProfile,
} from "../test-vaults/benchmark/contract-v1";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

interface Listener {
  readonly event: string;
  readonly callback: (...args: any[]) => void;
  active: boolean;
  unsubscribe(): void;
}

function projectedApp() {
  const listeners: Listener[] = [];
  const files = [
    { path: "Note.md", name: "Note.md" },
    { path: "Other.md", name: "Other.md" },
  ];
  const adapterFiles = new Map<string, string>();
  const adapterBinary = new Map<string, ArrayBuffer>();
  const vault = {
    configDir: ".obsidian",
    getName: () => "test-vault",
    getMarkdownFiles: () => files,
    getFileByPath: (path: string) => files.find((file) => file.path === path),
    read: async (file: { path: string }) => `contents of ${file.path}`,
    on: (event: string, callback: (...args: any[]) => void) => {
      const ref = {
        event,
        callback,
        active: true,
        unsubscribe() {
          this.active = false;
        },
      };
      listeners.push(ref);
      return ref;
    },
    adapter: {
      exists: async (path: string) => adapterFiles.has(path) || adapterBinary.has(path),
      read: async (path: string) => adapterFiles.get(path) ?? "",
      mkdir: async () => undefined,
      getResourcePath: function (path: string) {
        return `app://local/${path}`;
      },
      write: async (path: string, value: string) => {
        adapterFiles.set(path, value);
      },
      readBinary: async (path: string) => {
        const value = adapterBinary.get(path);
        if (!value) throw new Error("missing binary");
        return value;
      },
      writeBinary: async (path: string, value: ArrayBuffer | Uint8Array) => {
        const bytes = value instanceof Uint8Array ? value.slice().buffer : value.slice(0);
        adapterBinary.set(path, bytes);
      },
      list: async (path: string) => ({
        files: [...adapterFiles.keys(), ...adapterBinary.keys()]
          .filter((file) => file.startsWith(path))
          .map((file) => file.slice(path.length).replace(/^\//, "")),
        folders: [],
      }),
      remove: async (path: string) => {
        adapterFiles.delete(path);
      },
      activate: async (path: string, value: string) => {
        adapterFiles.set(path, value);
      },
      rename: async (from: string, to: string) => {
        if (adapterFiles.has(from)) {
          adapterFiles.set(to, adapterFiles.get(from)!);
          adapterFiles.delete(from);
        }
        if (adapterBinary.has(from)) {
          adapterBinary.set(to, adapterBinary.get(from)!);
          adapterBinary.delete(from);
        }
      },
    },
  };
  const workspace = {
    getActiveFile: () => files[0],
    getLeavesOfType: () => [],
    getLeaf: () => ({ setViewState: vi.fn() }),
  };
  return {
    vault,
    workspace,
    metadataCache: { getFirstLinkpathDest: () => null, getFileCache: () => ({ links: [] }) },
    listeners,
  };
}

const projectedPlugins: TramaPlugin[] = [];

function projectedPlugin(app: ReturnType<typeof projectedApp>, data = DEFAULT_SETTINGS) {
  const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
  plugin.app = app;
  plugin.manifest = { dir: ".obsidian/plugins/trama" };
  plugin.loadData = vi.fn(async () => data);
  plugin.saveData = vi.fn(async () => undefined);
  plugin.sqliteRuntime.createClient = (storage: object) => createTestSqliteClient(storage);
  plugin.addCommand = vi.fn();
  plugin.addSettingTab = vi.fn();
  plugin.registerView = vi.fn();
  plugin.registerEvent = vi.fn();
  projectedPlugins.push(plugin);
  return plugin as TramaPlugin & { app: typeof app };
}

describe("TramaPlugin lifecycle integration", () => {
  beforeEach(() => {
    Platform.isDesktopApp = true;
    vi.restoreAllMocks();
  });
  afterEach(async () => {
    for (const plugin of projectedPlugins.splice(0)) {
      const maintenance = (plugin as any).maintenance;
      const load = (plugin as any).indexLoad;
      const index = (plugin as any).index;
      plugin.onunload();
      await Promise.all([load?.catch(() => false), maintenance?.dispose()]);
      index?.disposeImmediately();
    }
    vi.restoreAllMocks();
  });

  it("loads normal Trama in the benchmark vault and runs the fixed lifecycle through it", async () => {
    const app = projectedApp();
    const workload = createWorkload("trama-small");
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
      mutations: workload.mutations
        .filter((mutation) => mutation.kind !== "unchanged")
        .map((mutation) => ({
          kind: mutation.kind,
          path: mutation.path,
          ...(mutation.to ? { to: mutation.to } : {}),
          ...(mutation.kind === "add" || mutation.kind === "modify"
            ? { content: mutation.note!.content }
            : {}),
        })),
    };
    const notes = new Map(workload.notes.map((note) => [note.path, note.content]));
    app.vault.getMarkdownFiles = () =>
      [...notes.keys()].map((path) => ({ path, name: path.split("/").pop()!, stat: { mtime: 0 } }));
    app.vault.getFileByPath = (path) =>
      app.vault.getMarkdownFiles().find((file) => file.path === path);
    app.vault.read = async (file) => notes.get(file.path)!;
    const emit = (event: string, ...args: any[]) => {
      for (const listener of app.listeners)
        if (listener.active && listener.event === event) listener.callback(...args);
    };
    Object.assign(app.vault, {
      createFolder: async (path: string) => {
        emit("create", { path, children: [] });
      },
      create: async (path: string, content: string) => {
        notes.set(path, content);
        emit("create", { path });
      },
      modify: async (file: { path: string }, content: string) => {
        notes.set(file.path, content);
        emit("modify", file);
      },
      delete: async (file: { path: string }) => {
        notes.delete(file.path);
        emit("delete", file);
      },
      rename: async (file: { path: string }, to: string) => {
        const from = file.path;
        notes.set(to, notes.get(from)!);
        notes.delete(from);
        emit("rename", { path: to }, from);
      },
    });
    (app.vault as any).getName = () => marker.vaultName;
    (app.vault.adapter as any).getBasePath = () => marker.expectedPath;
    const originalRead = app.vault.adapter.read;
    app.vault.adapter.read = async (path) =>
      path === ".trama-benchmark-vault" ? JSON.stringify(marker) : originalRead(path);
    const provider = await startFixtureProvider(marker.runId, deterministicEmbeddingVector);
    // Split a UTF-8 character between HTTP chunks: transport framing must not alter fixtures.
    const body = Buffer.from(JSON.stringify({ model: provider.modelId, input: ["東京"] }));
    const split = body.indexOf(Buffer.from("東京")) + 1;
    const unicodeResponse = new Promise<string>((resolve, reject) => {
      const req = request(`${provider.endpoint}/embeddings`, { method: "POST" }, (res) => {
        let response = "";
        res.setEncoding("utf8");
        res.on("data", (part) => {
          response += part;
        });
        res.on("end", () => resolve(response));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.write(body.subarray(0, split));
      setTimeout(() => req.end(body.subarray(split)), 20);
    });
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      diagnosticsMode: "performance",
      embedding: {
        ...DEFAULT_SETTINGS.embedding,
        endpoint: provider.endpoint,
        modelId: provider.modelId,
      },
      chat: {
        ...DEFAULT_SETTINGS.chat,
        endpoint: provider.endpoint,
        modelId: provider.modelId,
      },
    });
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      expect(JSON.parse(await unicodeResponse).data[0].embedding).toEqual(
        Array.from(deterministicEmbeddingVector("東京"))
      );
      await plugin.onload();
      await (plugin as any).indexLoad;
      const index = (plugin as any).index;
      expect(index).toBeDefined();
      expect((plugin as any).maintenance).toBeDefined();
      expect((plugin.addSettingTab as ReturnType<typeof vi.fn>).mock.calls).toEqual([
        [expect.any(TramaSettingsTab)],
      ]);
      expect(plugin.registerView).toHaveBeenCalledTimes(3);
      expect(plugin.registerEvent).toHaveBeenCalled();
      expect(
        (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.map(([command]) => command.id)
      ).toEqual(
        expect.arrayContaining(["open-lente", "open-voce", "open-filo", "run-obsidian-benchmark"])
      );
      const rebuild = vi.spyOn(plugin, "rebuildIndex");
      const fetchProbe = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ runId: "another-run", calls: 0, texts: 0 }), {
          status: 200,
        })
      );
      try {
        const refused = await (plugin as any).runGeneratedVaultBenchmark(app, marker);
        expect(refused.status).toBe("error");
        expect(refused.error).toContain("provider identity mismatch");
        expect(rebuild).not.toHaveBeenCalled();
      } finally {
        fetchProbe.mockRestore();
      }
      const failedUpdate = vi
        .spyOn(plugin, "updateIndex")
        .mockRejectedValueOnce(new Error("fixture update failure"));
      try {
        const failed = await (plugin as any).runGeneratedVaultBenchmark(app, marker);
        expect(failed.status).toBe("error");
        expect(failed.error).toBe("fixture update failure");
        expect(failed.provider.texts).toBeGreaterThan(0);
        expect(plugin.getSettings().lente).toEqual(DEFAULT_SETTINGS.lente);
      } finally {
        failedUpdate.mockRestore();
      }
      const searches = vi.spyOn(LenteSearch.prototype, "search");
      const report = await (plugin as any).runGeneratedVaultBenchmark(app, marker);
      expect(searches).toHaveBeenCalledTimes(2);
      for (const [, options] of searches.mock.calls)
        expect(options?.signal).toBeInstanceOf(AbortSignal);
      const query = 'alpha OR beta "quoted" -tag NEAR/3 (unsafe)';
      const hybrid = await (plugin as any).modelRuntime.lenteSearch.search(query);
      expect(
        hybrid.canonicalResults.map((hit: any) => ({
          path: hit.path,
          occurrenceOrdinal: hit.ordinal,
        }))
      ).toEqual(expectedOutputsV1ByProfile["trama-small"].probes.hybrid);
      expect(report.status, report.error).toBe("completed");
      expect(report.version).toBe("trama-obsidian-report-v2");
      expect(Object.values(report.correctness).every((value) => value === true)).toBe(true);
      expect(report.publication).toBe("vault-filesystem");
      expect(report.phases["lexical.batch"].count).toBeGreaterThan(0);
      expect(report.phases["semantic.overall"].count).toBeGreaterThan(0);
      expect(report.provider.texts).toBeGreaterThan(0);
      expect((plugin as any).index).toBe(index);
      expect((plugin as any).modelRuntime.session).toBeDefined();
      expect(
        log.mock.calls.filter(([line]) => line === "[Trama] benchmark_completed")
      ).toHaveLength(1);
      const calls = rebuild.mock.calls.length;
      app.vault.adapter.read = async (path) =>
        path === ".trama-benchmark-vault" ? "{}" : originalRead(path);
      await expect((plugin as any).runGeneratedVaultBenchmark(app, marker)).rejects.toThrow(
        "marker changed"
      );
      expect(rebuild).toHaveBeenCalledTimes(calls);
    } finally {
      await provider.close();
    }
  }, 60_000);

  it("keeps the committed runtime untouched when settings persistence rejects", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    const oldSession = (plugin as any).modelRuntime.session;
    const oldIndex = (plugin as any).index;
    (plugin as any).saveData.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      plugin.saveSettings({
        ...DEFAULT_SETTINGS,
        chat: { ...DEFAULT_SETTINGS.chat, modelId: "new-chat" },
      })
    ).rejects.toThrow("disk full");

    expect(plugin.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect((plugin as any).modelRuntime.session).toBe(oldSession);
    expect((plugin as any).index).toBe(oldIndex);
    expect(oldSession.getState().error).toBeUndefined();
  });

  it("gates detailed diagnostics at emission time without replacing composition", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    const debugSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await plugin.onload();
    const session = (plugin as any).modelRuntime.session;
    const model = (plugin as any).chatModel;
    const index = (plugin as any).index;
    const diagnostics = (plugin as any).diagnostics;

    diagnostics.emit({
      area: "chat",
      event: "model_error",
      error: new Error("hidden"),
      durationMs: 1,
    });
    await plugin.saveSettings({ ...DEFAULT_SETTINGS, diagnosticsMode: "detailed" });
    diagnostics.emit({
      area: "chat",
      event: "model_error",
      error: new Error("visible"),
      durationMs: 12,
    });
    await plugin.saveSettings({ ...DEFAULT_SETTINGS, diagnosticsMode: "off" });
    diagnostics.emit({
      area: "chat",
      event: "model_error",
      error: new Error("hidden again"),
      durationMs: 2,
    });

    expect(plugin.saveData).toHaveBeenCalledTimes(2);
    expect((plugin as any).modelRuntime.session).toBe(session);
    expect((plugin as any).chatModel).toBe(model);
    expect((plugin as any).index).toBe(index);
    expect(
      debugSpy.mock.calls.filter(([, record]) => (record as { area?: string }).area === "chat")
    ).toEqual([
      [
        "[Trama] chat:model_error 12 ms",
        expect.objectContaining({
          area: "chat",
          event: "model_error",
          error: expect.objectContaining({ message: "visible" }),
          durationMs: 12,
          tier: "detailed",
          facets: ["chat"],
        }),
      ],
    ]);
  });

  it("keeps embeddings out of detailed diagnostics", async () => {
    const app = projectedApp();
    const settings = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed", dimensions: 2 },
    };
    const plugin = projectedPlugin(app, settings);
    const debugSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    await plugin.onload();
    await plugin.saveSettings({ ...settings, diagnosticsMode: "detailed" });

    await (plugin as any).embeddingModel.embed(["private note"], new AbortController().signal);

    expect(
      debugSpy.mock.calls.some(([, record]) => JSON.stringify(record).includes("private note"))
    ).toBe(false);
  });

  it("composes Voce without current_note and keeps a sorted visible Markdown catalog for its UI", async () => {
    const app = projectedApp();
    let fileOpen: ((file: { path: string }) => void) | undefined;
    (app.workspace as any).on = (event: string, callback: (file: { path: string }) => void) => {
      if (event === "file-open") fileOpen = callback;
      return { event, active: true };
    };
    app.vault.getMarkdownFiles = () => [
      { path: "zeta.md", name: "zeta.md" },
      { path: ".hidden.md", name: ".hidden.md" },
      { path: ".obsidian/Settings.md", name: "Settings.md" },
      { path: ".trama/cache.md", name: "cache.md" },
      { path: "Alpha.md", name: "Alpha.md" },
      { path: "Zed.md", name: "Zed.md" },
      { path: "amber.md", name: "amber.md" },
      { path: "Äther.md", name: "Äther.md" },
      { path: "image.png", name: "image.png" },
    ];
    app.workspace.getActiveFile = () => ({ path: "Alpha.md", name: "Alpha.md" });
    const plugin = projectedPlugin(app);

    await plugin.onload();

    expect(
      (plugin as any).modelRuntime.session.registry.definitions.map(
        (tool: { name: string }) => tool.name
      )
    ).toEqual(["read_note", "discover_links", "follow_link", "vault_search"]);
    const searchDefinition = (plugin as any).modelRuntime.session.registry.definitions.find(
      (tool: { name: string }) => tool.name === "vault_search"
    );
    expect(searchDefinition).toMatchObject({
      name: "vault_search",
      description: expect.stringContaining("exact term, phrase, or natural-language concept"),
      inputSchema: {
        required: ["query"],
        additionalProperties: false,
        properties: { query: { type: "string" } },
      },
    });
    expect((plugin as any).visibleMarkdownCatalog()).toEqual([
      "Alpha.md",
      "Zed.md",
      "amber.md",
      "zeta.md",
      "Äther.md",
    ]);
    expect((plugin as any).contextNoteSuggestions()).toEqual(["Alpha.md"]);
    fileOpen?.({ path: "zeta.md" });
    expect((plugin as any).contextNoteSuggestions()).toEqual(["zeta.md"]);
  });

  it("keeps automatic maintenance opt-in and startup/settings changes network-silent", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await plugin.onload();
    await (plugin as any).index.load();
    expect((plugin as any).maintenance.snapshot.pending).toBe(false);
    await plugin.saveSettings({ ...DEFAULT_SETTINGS, automaticMaintenance: true });
    expect((plugin as any).maintenance.snapshot.pending).toBe(false);
    const maintenance = (plugin as any).maintenance;
    const setAutomaticEnabled = vi.spyOn(maintenance, "setAutomaticEnabled");
    maintenance.stop();
    await plugin.saveSettings({
      ...plugin.getSettings(),
      chat: { ...plugin.getSettings().chat, modelId: "chat-next" },
    });
    expect(setAutomaticEnabled).not.toHaveBeenCalled();
    expect(maintenance.snapshot.suspended).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("queues startup reconciliation when persisted automatic maintenance is enabled", async () => {
    const app = projectedApp();
    const IndexManager = (await import("@/index/IndexManager")).IndexManager;
    const MaintenanceScheduler = (await import("@/index/MaintenanceScheduler"))
      .MaintenanceScheduler;
    const requestFullRecovery = vi.spyOn(IndexManager.prototype, "requestFullRecovery");
    const invalidate = vi.spyOn(MaintenanceScheduler.prototype, "invalidate");
    const checkPublication = vi
      .spyOn(MaintenanceScheduler.prototype, "checkPublication")
      .mockResolvedValue({
        adopted: false,
        ignored: "same-id",
      });
    const plugin = projectedPlugin(app, { ...DEFAULT_SETTINGS, automaticMaintenance: true });

    await plugin.onload();
    await expect((plugin as any).indexLoad).resolves.toBe(true);

    expect(checkPublication).toHaveBeenCalledOnce();
    expect(requestFullRecovery).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledOnce();
    expect((plugin as any).maintenance.snapshot.pending).toBe(true);
  });

  it("does not reconcile a synchronized snapshot immediately after startup adoption", async () => {
    const app = projectedApp();
    const IndexManager = (await import("@/index/IndexManager")).IndexManager;
    const MaintenanceScheduler = (await import("@/index/MaintenanceScheduler"))
      .MaintenanceScheduler;
    const requestFullRecovery = vi.spyOn(IndexManager.prototype, "requestFullRecovery");
    const invalidate = vi.spyOn(MaintenanceScheduler.prototype, "invalidate");
    vi.spyOn(MaintenanceScheduler.prototype, "checkPublication").mockResolvedValue({
      adopted: true,
      publicationId: "remote",
    });
    const plugin = projectedPlugin(app, { ...DEFAULT_SETTINGS, automaticMaintenance: true });

    await plugin.onload();
    await (plugin as any).indexLoad;

    expect(requestFullRecovery).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect((plugin as any).maintenance.snapshot.pending).toBe(false);
  });

  it("routes eligible vault events and exact publication-file changes through maintenance", async () => {
    vi.spyOn(
      (await import("@/index/IndexManager")).IndexManager.prototype,
      "load"
    ).mockResolvedValue(true);
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).index.load();
    const maintenance = (plugin as any).maintenance;
    const invalidate = vi.spyOn(maintenance, "invalidate");
    const checkPublication = vi
      .spyOn(maintenance, "checkPublication")
      .mockResolvedValue({ adopted: false, ignored: "missing" });
    const emit = (event: string, ...args: any[]) => {
      for (const ref of app.listeners.filter((item) => item.active && item.event === event))
        ref.callback(...args);
    };
    emit("modify", { path: "Note.md" });
    emit("modify", { path: "image.png" });
    expect(invalidate).toHaveBeenCalledTimes(1);
    const publicationPath = (plugin as any).publicationManager.store.path;
    emit("modify", { path: publicationPath });
    expect(checkPublication).toHaveBeenCalledTimes(1);
  });

  it("forwards explicit commands and Stop to the shared maintenance controller", async () => {
    vi.spyOn(
      (await import("@/index/IndexManager")).IndexManager.prototype,
      "load"
    ).mockResolvedValue(true);
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).index.load();
    const maintenance = (plugin as any).maintenance;
    const update = vi.spyOn(maintenance, "update").mockResolvedValue(undefined);
    const rebuild = vi.spyOn(maintenance, "rebuild").mockResolvedValue(undefined);
    const stop = vi.spyOn(maintenance, "stop");
    (plugin as any).indexStatus.setReady();
    const commands = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.map(
      ([c]) => c as { id: string; callback: () => unknown }
    );
    const byId = (id: string) => commands.find((item) => item.id === id)!;
    await byId("update-index").callback();
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    (plugin as any).indexStatus.setReady();
    await byId("rebuild-index").callback();
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledOnce());
    // The maintenance methods are mocked, so project the ready state their
    // successful production completions would have reported.
    (plugin as any).indexStatus.setReady();
    byId("stop-index-maintenance").callback();
    expect(update).toHaveBeenCalledOnce();
    expect(rebuild).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(commands.map((item) => item.id)).not.toContain("prepare-semantic-index");
  });

  it("waits for deferred maintenance work before disposing index resources during unload", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-v1" },
    });
    await plugin.onload();
    const maintenance = (plugin as any).maintenance;
    const disposeMaintenance = vi.spyOn(maintenance, "dispose");
    const index = (plugin as any).index;
    const dispose = vi.spyOn(index, "disposeImmediately");
    const semantic = deferred<any>();
    let started!: () => void;
    const semanticStarted = new Promise<void>((resolve) => (started = resolve));
    vi.spyOn(index, "reconcileQueuedChanges").mockResolvedValue({
      changed: false,
      converged: true,
    });
    vi.spyOn(index, "prepareSemantic").mockImplementation(() => {
      started();
      return semantic.promise;
    });
    const update = maintenance.update();
    await semanticStarted;
    plugin.onunload();
    expect(disposeMaintenance).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    expect((plugin as any).maintenance).toBeUndefined();
    expect((plugin as any).index).toBeUndefined();
    semantic.resolve({
      operation: "prepare",
      changed: false,
      converged: true,
      stored: 0,
      skipped: 0,
      state: {},
    });
    await update;
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });

  it("waits for startup load as well as maintenance before disposing on unload", async () => {
    const app = projectedApp();
    const load = deferred<boolean>();
    vi.spyOn((await import("@/index/IndexManager")).IndexManager.prototype, "load").mockReturnValue(
      load.promise
    );
    const plugin = projectedPlugin(app);
    await plugin.onload();
    const index = (plugin as any).index;
    const maintenance = (plugin as any).maintenance;
    const dispose = vi.spyOn(index, "disposeImmediately");
    const check = vi.spyOn(maintenance, "checkPublication");
    const status = (plugin as any).indexStatus;
    const revision = status.getStatus().revision;

    plugin.onunload();
    expect((plugin as any).index).toBeUndefined();
    expect((plugin as any).maintenance).toBeUndefined();
    expect(dispose).not.toHaveBeenCalled();
    load.resolve(true);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(check).not.toHaveBeenCalled();
    expect(status.getStatus().revision).toBe(revision);
  });

  it("waits for old startup load before recomposition and rejects its late callbacks", async () => {
    const app = projectedApp();
    const load = deferred<boolean>();
    const IndexManager = (await import("@/index/IndexManager")).IndexManager;
    const loadSpy = vi
      .spyOn(IndexManager.prototype, "load")
      .mockReturnValueOnce(load.promise)
      .mockResolvedValue(true);
    const MaintenanceScheduler = (await import("@/index/MaintenanceScheduler"))
      .MaintenanceScheduler;
    vi.spyOn(MaintenanceScheduler.prototype, "checkPublication").mockResolvedValue({
      adopted: false,
      ignored: "missing",
    });
    const plugin = projectedPlugin(app);
    await plugin.onload();
    const oldIndex = (plugin as any).index;
    const oldMaintenance = (plugin as any).maintenance;
    (plugin as any).handlePublicationWarning(
      { phase: "stage", message: "old warning", retryable: true },
      "publication"
    );
    const disposeMaintenance = vi.spyOn(oldMaintenance, "dispose");
    const dispose = vi.spyOn(oldIndex, "dispose").mockResolvedValue(undefined);
    const check = vi.spyOn(oldMaintenance, "checkPublication");
    const save = plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-next" },
    });
    await vi.waitFor(() => expect(disposeMaintenance).toHaveBeenCalledOnce());
    expect(dispose).not.toHaveBeenCalled();
    expect((plugin as any).index).toBeUndefined();
    load.resolve(true);
    await save;
    expect(dispose).toHaveBeenCalledOnce();
    expect((plugin as any).index).not.toBe(oldIndex);
    expect(plugin.getIndexStatus()?.publicationWarning).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
    expect(loadSpy).toHaveBeenCalledTimes(2);
    await (plugin as any).indexLoad;
    await vi.waitFor(() => expect((plugin as any).maintenance.snapshot.lane).toBe("idle"));
  });
});
