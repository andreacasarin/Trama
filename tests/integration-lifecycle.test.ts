import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, request } from "node:http";
import { Platform } from "obsidian";
import { TramaPlugin } from "@/plugin/TramaPlugin";
import { BENCHMARK_CORPUS_SHA256 } from "@/benchmark/Manifest";
import { IndexManager } from "@/index/IndexManager";
import { TRAMA_RUNTIME_BUILD_ID } from "@/build/identity";
import { SQLITE_PROTOCOL_VERSION } from "@/index/sqlite/protocol";
import { DEFAULT_SETTINGS } from "@/settings/Settings";
import { createTestSqliteClient } from "./sqlite-test-client";
import { deterministicEmbeddingVector } from "../test-vaults/benchmark/generator";
// @ts-expect-error Standalone Node fixture server has no emitted declaration.
import { startFixtureProvider } from "../scripts/benchmark/fixture-provider.mjs";

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
      exists: async (path: string) => {
        const prefix = `${path}/`;
        return (
          adapterFiles.has(path) ||
          adapterBinary.has(path) ||
          [...adapterFiles.keys(), ...adapterBinary.keys()].some((file) => file.startsWith(prefix))
        );
      },
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

  it("closes the fixture provider while an HTTP keep-alive socket is held", async () => {
    const provider = await startFixtureProvider(
      "d802aace-b48f-4ce1-a0c3-e6d9224c9001",
      deterministicEmbeddingVector
    );
    const agent = new Agent({ keepAlive: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const req = request(
          `${provider.endpoint}/embeddings`,
          { method: "POST", agent, headers: { "Content-Type": "application/json" } },
          (res) => {
            res.resume();
            res.on("end", resolve);
            res.on("error", reject);
          }
        );
        req.on("error", reject);
        req.end(JSON.stringify({ model: provider.modelId, input: ["held socket"] }));
      });
      await expect(provider.close()).resolves.toBeUndefined();
    } finally {
      agent.destroy();
    }
  });

  it("uses one confirmed handler to clear local indexes and shared cache", async () => {
    const app = projectedApp();
    const marker = {
      version: "trama-simple-benchmark-v1",
      corpusSha256: BENCHMARK_CORPUS_SHA256,
      vaultName: "Trama Benchmark Vault",
      expectedPath:
        "/Users/andreacasarin/Documents/Code/trama/.artifacts/test-vaults/benchmark/Trama Benchmark Vault",
      noteCount: 3000,
    };
    (app.vault as any).getName = () => marker.vaultName;
    (app.vault.adapter as any).getBasePath = () => marker.expectedPath;
    const originalRead = app.vault.adapter.read;
    app.vault.adapter.read = async (path) =>
      path === ".trama-benchmark-vault" ? JSON.stringify(marker) : originalRead(path);
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
    const commands = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.map(
      ([command]) => command as { id: string; callback: () => void }
    );
    expect(commands.map(({ id }) => id)).toContain("run-obsidian-benchmark");
    expect(commands.map(({ id }) => id)).not.toContain("reset-all-indexes-benchmark");
    expect(commands.map(({ id }) => id)).toContain("clear-indexes-and-shared-cache");

    const index = (plugin as any).index;
    const resetLocal = vi.spyOn(index, "resetLocalDatabase");
    const clearPublication = vi.spyOn((plugin as any).publicationManager.store, "clear");
    const clearShards = vi.spyOn((plugin as any).publicationManager.store, "clearCacheShards");
    vi.spyOn((plugin as any).maintenance, "resetExclusive").mockImplementation((async (
      run: () => Promise<void>
    ) => run()) as any);
    vi.stubGlobal("confirm", () => false);
    await plugin.clearIndexesAndSharedCache();
    expect(resetLocal).not.toHaveBeenCalled();
    vi.stubGlobal("confirm", () => true);
    await plugin.clearIndexesAndSharedCache();
    expect(resetLocal).toHaveBeenCalledOnce();
    expect(clearPublication).toHaveBeenCalledOnce();
    expect(clearShards).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
    plugin.onunload();
  });

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
    await vi.waitFor(() => expect(checkPublication).toHaveBeenCalledTimes(1));
  });

  it("coalesces shard events and checks again for a shard changed during adoption", async () => {
    vi.spyOn(IndexManager.prototype, "load").mockResolvedValue(true);
    const app = projectedApp();
    const plugin = projectedPlugin(app) as any;
    await plugin.onload();
    await plugin.index.load();
    const maintenance = plugin.maintenance;
    const first = deferred<any>();
    const followup = deferred<any>();
    const checkPublication = vi
      .spyOn(maintenance, "checkPublication")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => followup.promise)
      .mockResolvedValue({ adopted: false, ignored: "missing" });
    const applyAdoptionResult = vi.spyOn(plugin, "applyAdoptionResult");
    const emit = (event: string, ...args: any[]) => {
      for (const ref of app.listeners.filter((item) => item.active && item.event === event))
        ref.callback(...args);
    };
    const cacheDirectory = plugin.publicationManager.store.cacheDirectory;
    for (let index = 0; index < 23; index++)
      emit("modify", {
        path: `${cacheDirectory}/cache-${index.toString(16).padStart(64, "0")}.sqlite3`,
      });

    await vi.waitFor(() => expect(checkPublication).toHaveBeenCalledTimes(1));
    expect(applyAdoptionResult).not.toHaveBeenCalled();
    emit("modify", {
      path: `${cacheDirectory}/cache-${"17".padStart(64, "0")}.sqlite3`,
    });
    expect(checkPublication).toHaveBeenCalledTimes(1);

    first.resolve({ adopted: false, ignored: "missing" });
    await vi.waitFor(() => expect(checkPublication).toHaveBeenCalledTimes(2));
    followup.resolve({ adopted: true, publicationId: "late-shard" });
    await vi.waitFor(() =>
      expect(applyAdoptionResult).toHaveBeenCalledWith(
        plugin.index,
        expect.objectContaining({ adopted: true, publicationId: "late-shard" })
      )
    );
    expect(checkPublication).toHaveBeenCalledTimes(2);

    await plugin.checkPublication();
    expect(checkPublication).toHaveBeenCalledTimes(3);
  });

  it("cancels a queued publication-event check when unloading", async () => {
    vi.spyOn(IndexManager.prototype, "load").mockResolvedValue(true);
    const app = projectedApp();
    const plugin = projectedPlugin(app) as any;
    await plugin.onload();
    await plugin.index.load();
    const checkPublication = vi
      .spyOn(plugin.maintenance, "checkPublication")
      .mockResolvedValue({ adopted: false, ignored: "missing" });

    plugin.notifyPublicationFileEvent(
      `${plugin.publicationManager.store.cacheDirectory}/cache-${"a".repeat(64)}.sqlite3`
    );
    plugin.onunload();
    await Promise.resolve();

    expect(checkPublication).not.toHaveBeenCalled();
  });

  it("drops a dirty publication-event follow-up when replacing the runtime", async () => {
    vi.spyOn(IndexManager.prototype, "load").mockResolvedValue(true);
    const app = projectedApp();
    const plugin = projectedPlugin(app) as any;
    await plugin.onload();
    await plugin.index.load();
    const oldMaintenance = plugin.maintenance;
    const first = deferred<any>();
    const dispose = vi.spyOn(oldMaintenance, "dispose");
    const checkPublication = vi
      .spyOn(oldMaintenance, "checkPublication")
      .mockImplementation(() => first.promise);

    const cacheDirectory = plugin.publicationManager.store.cacheDirectory;
    plugin.notifyPublicationFileEvent(`${cacheDirectory}/cache-${"a".repeat(64)}.sqlite3`);
    await vi.waitFor(() => expect(checkPublication).toHaveBeenCalledOnce());
    plugin.notifyPublicationFileEvent(`${cacheDirectory}/cache-${"b".repeat(64)}.sqlite3`);

    const replacement = plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "replacement-model" },
    });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    first.resolve({ adopted: false, ignored: "missing" });
    await replacement;
    await Promise.resolve();

    expect(plugin.maintenance).not.toBe(oldMaintenance);
    expect(checkPublication).toHaveBeenCalledOnce();
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
    const reset = vi.spyOn(plugin, "resetIndexes").mockResolvedValue(undefined);
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
    await byId("reset-all-indexes").callback();
    expect(reset).toHaveBeenCalledOnce();
    // The maintenance methods are mocked, so project the ready state their
    // successful production completions would have reported.
    (plugin as any).indexStatus.setReady();
    byId("stop-index-maintenance").callback();
    expect(update).toHaveBeenCalledOnce();
    expect(rebuild).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(commands.map((item) => item.id)).not.toContain("prepare-semantic-index");
  });

  it("resets local storage and publication through one confirmed scheduler fence", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
    const manager = (plugin as any).index;
    const scheduler = (plugin as any).maintenance;
    const publication = (plugin as any).publicationManager;
    const order: string[] = [];
    vi.spyOn(manager, "resetLocalDatabase").mockImplementation(async () => {
      order.push("local");
      return {} as any;
    });
    vi.spyOn(publication.store, "clear").mockImplementation(async () => {
      order.push("publication");
    });
    vi.spyOn(manager, "requestFullRecovery").mockImplementation(() => order.push("recovery"));
    vi.spyOn(scheduler, "resetExclusive").mockImplementation((async (run: () => Promise<void>) => {
      order.push("fence");
      await run();
    }) as any);
    const confirmReset = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmReset);
    try {
      await plugin.resetIndexes();
      expect(confirmReset).toHaveBeenCalledWith(
        "Reset all local and published indexes for this vault? Notes, settings, credentials, and identity will be preserved. Automatic maintenance will rebuild indexes if enabled."
      );
      expect(order).toEqual(["fence", "local", "publication", "recovery"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("disposes index resources immediately while maintenance work is deferred during unload", async () => {
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
    expect(dispose).toHaveBeenCalledOnce();
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
    await update.catch(() => undefined);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes index resources immediately while startup load is pending on unload", async () => {
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
    expect(dispose).toHaveBeenCalledOnce();
    load.resolve(true);
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    expect(check).not.toHaveBeenCalled();
    expect(status.getStatus().revision).toBe(revision);
  });

  it("does not recreate a worker when a pending load resumes after immediate disposal", async () => {
    const corpus = deferred<string>();
    const corpusStarted = deferred<void>();
    const workers: {
      postMessage(value: any): void;
      terminate(): void;
      addEventListener(type: string, listener: (event: any) => void): void;
      removeEventListener(type: string, listener: (event: any) => void): void;
    }[] = [];
    const workerFactory = vi.fn(() => {
      const listeners = new Map<string, (event: any) => void>();
      const worker = {
        postMessage(value: any) {
          if (value.type === "trama-runtime-handshake") {
            queueMicrotask(() =>
              listeners.get("message")?.({
                data: {
                  type: value.type,
                  id: value.id,
                  buildId: TRAMA_RUNTIME_BUILD_ID,
                  diagnosticsConfigured: true,
                },
              })
            );
          } else if (Number.isSafeInteger(value.id)) {
            queueMicrotask(() =>
              listeners.get("message")?.({
                data: {
                  v: SQLITE_PROTOCOL_VERSION,
                  id: value.id,
                  ok: false,
                  error: { code: "storage_unavailable", message: "disposed test", retryable: true },
                },
              })
            );
          }
        },
        terminate() {},
        addEventListener(type: string, listener: (event: any) => void) {
          listeners.set(type, listener);
        },
        removeEventListener(type: string, listener: (event: any) => void) {
          if (listeners.get(type) === listener) listeners.delete(type);
        },
      };
      workers.push(worker);
      return worker;
    });
    const index = new IndexManager(
      {
        listMarkdownPaths: async () => [],
        readMarkdown: async (path) => ({ path, content: "" }),
      },
      { dimensions: 1, embed: async () => [] },
      "http://127.0.0.1:1234/v1",
      "test-model",
      { workerFactory }
    );
    const runtime = (index as any).runtime;
    runtime.corpusFingerprintId = () => {
      corpusStarted.resolve();
      return corpus.promise;
    };

    const loading = index.load();
    const selectingProfile = index.selectEmbeddingProfile("test-profile");
    await corpusStarted.promise;
    index.disposeImmediately();
    corpus.resolve("corpus");

    await expect(loading).resolves.toBe(false);
    await expect(selectingProfile).rejects.toBeDefined();
    expect(workerFactory).toHaveBeenCalledOnce();
    expect(workers).toHaveLength(1);
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
    expect((plugin as any).indexLoadResult).toBeUndefined();
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
    expect((plugin as any).indexLoadResult).toBeUndefined();
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
    expect((plugin as any).indexLoadResult).toBe(true);
    await vi.waitFor(() => expect((plugin as any).maintenance.snapshot.lane).toBe("idle"));
  });
});
