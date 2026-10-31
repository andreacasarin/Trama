import { beforeEach, describe, expect, it, vi } from "vitest";
import { Notice, Platform } from "obsidian";
import { TramaPlugin } from "@/plugin/TramaPlugin";
import { NoteSqliteRuntime } from "@/plugin/NoteSqliteRuntime";
import { IndexStatusController } from "@/ui/index/IndexStatus";
import { VaultEmbeddingCache } from "@/plugin/VaultEmbeddingCache";
import { LenteView } from "@/ui/lente/LenteView";
import { VaultRetrieval } from "@/index/VaultRetrieval";
import { SqliteEmbeddingCache, embeddingCacheIdentity } from "@/index/SqliteEmbeddingCache";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { loadTestSqlite } from "./note-sqlite-test-client";

describe("V1 plugin composition", () => {
  beforeEach(() => {
    Platform.isDesktopApp = false;
    (Notice as any).instances = [];
  });

  it("starts without provider requests, registers manual index controls, and closes the worker", async () => {
    const files = new Map<string, string>();
    const directories = new Set<string>();
    const workers: any[] = [];
    const lifecycle: string[] = [];
    const openVoce = { setSession: vi.fn() };
    const openFilo = { setRelated: vi.fn() };
    const openLente = { setSearch: vi.fn() };
    const WorkerStub = vi.fn(function () {
      const listeners = new Set<(event: any) => void>();
      const worker = {
        postMessage: vi.fn((request: any) => {
          if (request.method === "close") lifecycle.push(`close-${workers.length}`);
          if (
            request.method === "init" ||
            request.method === "close" ||
            request.method === "noteStoreHasNotes" ||
            request.method === "noteStoreClear"
          )
            for (const listener of listeners)
              listener({
                data: {
                  id: request.id,
                  ok: true,
                  result: request.method === "noteStoreHasNotes" ? false : undefined,
                },
              });
        }),
        addEventListener: vi.fn(
          (_type: string, listener: (event: any) => void) =>
            _type === "message" && listeners.add(listener)
        ),
        removeEventListener: vi.fn((_type: string, listener: (event: any) => void) =>
          listeners.delete(listener)
        ),
        terminate: vi.fn(() => lifecycle.push(`terminate-${workers.length}`)),
      };
      // Observe the original native hooks before the runtime wraps termination.
      workers.push({ ...worker });
      lifecycle.push(`create-${workers.length}`);
      return worker;
    });
    const originalWorker = globalThis.Worker;
    globalThis.Worker = WorkerStub as unknown as typeof Worker;
    const app = {
      vault: {
        configDir: ".obsidian",
        getMarkdownFiles: () => [],
        getAllFolders: () => [],
        getFileByPath: () => null,
        read: async () => "",
        adapter: {
          getResourcePath: (path: string) => `app://vault/${path}`,
          exists: async (path: string) => files.has(path),
          read: async (path: string) => files.get(path) ?? "",
          mkdir: async (path: string) => directories.add(path),
          write: async (path: string, contents: string) => files.set(path, contents),
        },
      },
      workspace: {
        getActiveFile: () => null,
        getLeavesOfType: (type: string) =>
          ({
            "trama-voce": [{ view: openVoce }],
            "trama-filo": [{ view: openFilo }],
            "trama-lente": [{ view: openLente }],
          })[type] ?? [],
        on: () => ({}),
        offref: vi.fn(),
        revealLeaf: vi.fn(),
        getLeaf: vi.fn(),
        trigger: vi.fn(),
      },
      metadataCache: { getFirstLinkpathDest: () => null, getFileCache: () => null },
    };
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.app = app;
    plugin.manifest = { id: "trama", dir: ".obsidian/plugins/trama", version: "test" };
    plugin.loadData = vi.fn(async () => undefined);
    plugin.saveData = vi.fn(async () => undefined);
    const commands = vi.spyOn(plugin, "addCommand");
    const hoverSource = vi.spyOn(plugin, "registerHoverLinkSource");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await plugin.onload();
      expect(hoverSource).toHaveBeenCalledOnce();
      expect(hoverSource).toHaveBeenCalledWith("trama-results", {
        display: "Trama results",
        defaultMod: false,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(WorkerStub).toHaveBeenCalledWith(expect.stringMatching(/^blob:/), {
        type: "module",
      });
      expect(commands.mock.calls.map(([command]) => (command as any).id)).toEqual(
        expect.arrayContaining([
          "trama-update-index",
          "trama-rebuild-index",
          "trama-stop-indexing",
          "trama-clear-index",
        ])
      );
      const openCommand = commands.mock.calls
        .map(([command]) => command as any)
        .find((command) => command.id === "open-voce");
      openCommand.callback();
      expect(app.workspace.revealLeaf).toHaveBeenCalledWith(
        expect.objectContaining({ view: openVoce })
      );
      expect(app.workspace.getLeaf).not.toHaveBeenCalled();
      await plugin.saveSettings(plugin.getSettings());
      expect(lifecycle).toEqual(["create-1"]);
      expect(workers).toHaveLength(1);
      await plugin.configureServices(app);
      expect(openVoce.setSession).toHaveBeenCalledWith(plugin.session);
      expect(openFilo.setRelated).toHaveBeenCalledWith(plugin.retrieval);
      expect(openLente.setSearch).toHaveBeenCalledWith(plugin.retrieval.runnable);
      const oldClient = plugin.client;
      plugin.loadData = vi.fn(async () => ({
        ...plugin.getSettings(),
        storageFolder: "Sync/Trama",
      }));
      plugin.settingsTab = { refreshExternalSettings: vi.fn() };
      await plugin.onExternalSettingsChange();
      expect(plugin.getSettings().storageFolder).toBe("Sync/Trama");
      expect(plugin.client).not.toBe(oldClient);
      expect(files.has("Sync/Trama/identity.json")).toBe(true);
      expect(WorkerStub).toHaveBeenCalledTimes(3);

      const beforeIndexSwitch = plugin.client;
      const indexing = plugin.manualIndex;
      const cancelIndex = vi.spyOn(indexing, "cancel");
      let finishPublication!: () => void;
      const publication = new Promise<void>((resolve) => (finishPublication = resolve));
      const update = vi.spyOn(indexing, "update").mockReturnValue(publication as any);
      const activeUpdate = plugin.updateIndex();
      expect(update).toHaveBeenCalledOnce();
      const indexSwitch = plugin.saveSettings((current: any) => ({
        ...current,
        storageFolder: "Sync/Trama/next",
      }));
      await vi.waitFor(() => expect(cancelIndex).toHaveBeenCalledOnce());
      expect(lifecycle).not.toContain("close-3");
      finishPublication();
      await indexSwitch;
      await activeUpdate;
      expect(plugin.client).not.toBe(beforeIndexSwitch);
      expect(files.has("Sync/Trama/next/identity.json")).toBe(true);
      expect(lifecycle.indexOf("close-3")).toBeGreaterThan(lifecycle.indexOf("create-3"));
      expect(lifecycle.indexOf("close-3")).toBeLessThan(lifecycle.indexOf("create-4"));

      const beforeClearSwitch = plugin.client;
      let cleanupSignal!: AbortSignal;
      const cleanup = vi
        .spyOn(VaultEmbeddingCache, "clearManagedFiles")
        .mockImplementation((_adapter, signal) => {
          cleanupSignal = signal;
          return new Promise((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true }
            )
          );
        });
      const activeClear = plugin.clearIndex();
      await vi.waitFor(() => expect(cleanupSignal).toBeInstanceOf(AbortSignal));
      const clearSwitch = plugin.saveSettings((current: any) => ({
        ...current,
        storageFolder: "Sync/Trama/final",
      }));
      await vi.waitFor(() => expect(cleanupSignal.aborted).toBe(true));
      await clearSwitch;
      await activeClear;
      cleanup.mockRestore();
      expect(plugin.client).not.toBe(beforeClearSwitch);
      expect(files.has("Sync/Trama/final/identity.json")).toBe(true);
      expect(lifecycle.indexOf("close-4")).toBeGreaterThan(lifecycle.indexOf("create-4"));
      expect(lifecycle.indexOf("close-4")).toBeLessThan(lifecycle.indexOf("create-5"));
      plugin.onunload();
      await vi.waitFor(() =>
        expect(workers[0].postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ method: "close" })
        )
      );
      await vi.waitFor(() => expect(workers[0].terminate).toHaveBeenCalledOnce());
    } finally {
      fetchSpy.mockRestore();
      globalThis.Worker = originalWorker;
      plugin.onunload();
    }
  });

  it("persists folder exclusions without reconfiguring runtime and applies subtree boundaries", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    const saved: any[] = [];
    plugin.saveData = vi.fn(async (value: unknown) => saved.push(value));
    plugin.configureServices = vi.fn(async () => undefined);
    const first = plugin.saveSettings((current: any) => ({
      ...current,
      excludedFolders: ["Projects", "Projects/Archive"],
    }));
    await first;
    expect(saved[0].excludedFolders).toEqual(["Projects", "Projects/Archive"]);
    expect(plugin.configureServices).not.toHaveBeenCalled();
    expect(plugin.isIndexableMarkdown("Projects/one.md")).toBe(false);
    expect(plugin.isIndexableMarkdown("Projects/Archive/old.md")).toBe(false);
    expect(plugin.isIndexableMarkdown("Projects Archive/one.md")).toBe(true);
    expect(plugin.isVisibleMarkdown("Projects/one.md")).toBe(true);
  });

  it("applies a canonical storage folder and rejects invalid folders before persistence", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    const saved: any[] = [];
    plugin.app = { vault: { configDir: ".obsidian" } };
    plugin.saveData = vi.fn(async (value: unknown) => saved.push(value));
    plugin.configureServices = vi.fn(async () => undefined);
    await plugin.saveSettings((current: any) => ({
      ...current,
      storageFolder: " Sync /./Trama//",
    }));
    expect(plugin.getSettings().storageFolder).toBe("Sync/Trama");
    expect(saved[0].storageFolder).toBe("Sync/Trama");
    expect(plugin.configureServices).toHaveBeenCalledOnce();
    await expect(
      plugin.saveSettings((current: any) => ({ ...current, storageFolder: "../outside" }))
    ).rejects.toThrow();
    await expect(
      plugin.saveSettings((current: any) => ({ ...current, storageFolder: ".obsidian/plugins" }))
    ).rejects.toThrow();
    expect(saved).toHaveLength(1);
    expect(plugin.getSettings().storageFolder).toBe("Sync/Trama");
    expect(plugin.isIndexableMarkdown("Sync/Trama/note.md")).toBe(false);
    expect(plugin.isIndexableMarkdown("Sync/Tramatic/note.md")).toBe(true);
  });

  it("reloads all externally synchronized settings and reapplies runtime model dimensions", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    const external = {
      chat: {
        ...plugin.getSettings().chat,
        modelId: "synced-chat",
        reasoningEffort: "minimal",
      },
      embedding: { ...plugin.getSettings().embedding, modelId: "synced-embed", dimensions: 1024 },
      excludedFolders: ["Projects"],
    };
    const refresh = vi.fn();
    plugin.loadData = vi.fn(async () => external);
    plugin.saveData = vi.fn();
    plugin.app = {};
    plugin.configureServices = vi.fn(async () => undefined);
    plugin.settingsTab = { refreshExternalSettings: refresh };
    await plugin.onExternalSettingsChange();
    expect(plugin.getSettings()).toMatchObject({
      chat: { modelId: "synced-chat", reasoningEffort: "minimal" },
      embedding: { modelId: "synced-embed", dimensions: 1024 },
      excludedFolders: ["Projects"],
    });
    expect(plugin.configureServices).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it("preserves current settings and runtime when external settings cannot be read", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    const current = {
      ...plugin.getSettings(),
      consoleDebug: true,
      embedding: { ...plugin.getSettings().embedding, modelId: "working-model" },
    };
    const debugError = vi.spyOn(console, "error").mockImplementation(() => {});
    plugin.settingsStore.load(current);
    plugin.loadData = vi.fn(async () => {
      throw new Error("settings read failed");
    });
    plugin.configureServices = vi.fn();
    plugin.settingsTab = { refreshExternalSettings: vi.fn() };
    await expect(plugin.onExternalSettingsChange()).rejects.toThrow("settings read failed");
    expect(plugin.getSettings()).toEqual(current);
    expect(plugin.configureServices).not.toHaveBeenCalled();
    expect(plugin.settingsTab.refreshExternalSettings).not.toHaveBeenCalled();
    expect(debugError).toHaveBeenCalledOnce();
    expect(debugError.mock.calls[0][1]).toMatchObject({ message: "settings read failed" });
    debugError.mockRestore();
  });

  it("applies an externally synchronized debug toggle without rebuilding services", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    const debugInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    plugin.loadData = vi.fn(async () => ({ ...plugin.getSettings(), consoleDebug: true }));
    plugin.configureServices = vi.fn();
    await plugin.onExternalSettingsChange();
    plugin.consoleDebug.info("sync enabled");
    expect(debugInfo).toHaveBeenCalledOnce();
    expect(debugInfo.mock.calls[0][0]).toContain("sync enabled");
    expect(plugin.configureServices).not.toHaveBeenCalled();
    debugInfo.mockRestore();
  });

  it("advises after an external embedding profile change without clearing or rebuilding", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    const current = {
      ...plugin.getSettings(),
      embedding: { ...plugin.getSettings().embedding, modelId: "embed-old" },
    };
    const external = {
      ...current,
      embedding: { ...current.embedding, modelId: "embed-new" },
    };
    plugin.settingsStore.commit(current);
    plugin.indexedNotes = true;
    plugin.loadData = vi.fn(async () => external);
    plugin.app = {};
    plugin.configureServices = vi.fn(async () => undefined);
    plugin.settingsTab = { refreshExternalSettings: vi.fn() };
    plugin.clearIndex = vi.fn();
    plugin.rebuildIndex = vi.fn();

    await plugin.onExternalSettingsChange();

    expect(plugin.getSettings()).toEqual(external);
    expect(plugin.settingsTab.refreshExternalSettings).toHaveBeenCalledOnce();
    expect((Notice as any).instances.at(-1).message).toContain(
      "Clear the index and embedding cache"
    );
    expect(plugin.clearIndex).not.toHaveBeenCalled();
    expect(plugin.rebuildIndex).not.toHaveBeenCalled();
  });

  it("does not advise for chat-only external changes", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    const current = {
      ...plugin.getSettings(),
      embedding: { ...plugin.getSettings().embedding, modelId: "embed-current" },
    };
    plugin.settingsStore.commit(current);
    plugin.indexedNotes = true;
    plugin.loadData = vi.fn(async () => ({
      ...current,
      chat: { ...current.chat, modelId: "chat-new" },
    }));
    plugin.app = {};
    plugin.configureServices = vi.fn(async () => undefined);
    plugin.settingsTab = { refreshExternalSettings: vi.fn() };

    await plugin.onExternalSettingsChange();

    expect((Notice as any).instances).toHaveLength(0);
  });

  it("logs one bounded indexing completion with the existing result counts", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.settingsStore.commit({ ...plugin.getSettings(), consoleDebug: true });
    plugin.client = {
      call: vi.fn(async () => true),
      close: vi.fn(async () => undefined),
    };
    plugin.status = new IndexStatusController();
    plugin.manualIndex = {
      update: vi.fn(async () => ({
        visited: 4,
        deleted: 1,
        numAdded: 2,
        numUpdated: 1,
        numSkipped: 1,
        sharing: "complete",
      })),
      cancel: vi.fn(),
    };
    plugin.retrieval = { invalidateRelated: vi.fn() };
    const debugInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    await plugin.updateIndex();
    expect(plugin.manualIndex.update).toHaveBeenCalledWith(true);
    expect(debugInfo).toHaveBeenCalledTimes(2);
    expect(debugInfo.mock.calls[0][0]).toContain("Updating note index started");
    expect(debugInfo.mock.calls[1][0]).toContain("Updating note index completed");
    expect(debugInfo.mock.calls[1][1]).toMatchObject({
      automatic: false,
      rebuild: false,
      visited: 4,
      deleted: 1,
      numAdded: 2,
      numUpdated: 1,
      numSkipped: 1,
      elapsedMs: expect.any(Number),
    });
    debugInfo.mockRestore();
    plugin.onunload();
  });

  it("starts automatic indexing after layout and coalesces vault events behind the debounce", async () => {
    vi.useFakeTimers();
    const previousWindow = (globalThis as any).window;
    let intervalCallback!: () => void;
    vi.stubGlobal("window", {
      setInterval: (callback: () => void, delay: number) => {
        expect(delay).toBe(300_000);
        intervalCallback = callback;
        return 1;
      },
    });
    const handlers = new Map<string, (file: any, oldPath?: string) => void>();
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.indexedNotes = true;
    plugin.settingsStore.commit({
      ...plugin.getSettings(),
      embedding: { ...plugin.getSettings().embedding, modelId: "local-embed" },
    });
    plugin.client = { close: vi.fn(async () => undefined) };
    plugin.manualIndex = { cancel: vi.fn() };
    plugin.registerEvent = vi.fn();
    plugin.registerInterval = vi.fn();
    plugin.runIndex = vi.fn(async () => undefined);
    try {
      plugin.startAutomaticIndexing({
        vault: { on: (event: string, handler: any) => (handlers.set(event, handler), {}) },
      });
      expect(plugin.runIndex).toHaveBeenCalledOnce();
      handlers.get("modify")!({ path: "notes/a.md" });
      handlers.get("create")!({ path: "notes/b.md" });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(plugin.runIndex).toHaveBeenCalledTimes(2);
      intervalCallback();
      expect(plugin.runIndex).toHaveBeenCalledTimes(3);
    } finally {
      plugin.onunload();
      vi.useRealTimers();
      if (previousWindow === undefined) vi.unstubAllGlobals();
      else vi.stubGlobal("window", previousWindow);
    }
  });

  it("keeps an empty index paused through events and timers until a manual Update indexes notes", async () => {
    vi.useFakeTimers();
    const previousWindow = (globalThis as any).window;
    let intervalCallback!: () => void;
    vi.stubGlobal("window", {
      setInterval: (callback: () => void) => ((intervalCallback = callback), 1),
    });
    const handlers = new Map<string, (file: any, oldPath?: string) => void>();
    let databaseHasNotes = false;
    let nextUpdateHasNotes = false;
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.client = {
      call: vi.fn(async (method: string) => {
        if (method === "noteStoreHasNotes") return databaseHasNotes;
      }),
      close: vi.fn(async () => undefined),
    };
    plugin.indexedNotes = await plugin.client.call("noteStoreHasNotes", {});
    plugin.manualIndex = {
      update: vi.fn(async () => {
        databaseHasNotes = nextUpdateHasNotes;
        return { visited: 1, deleted: 0, numAdded: 0, numUpdated: 0, numSkipped: 1 };
      }),
      rebuild: vi.fn(),
      cancel: vi.fn(),
    };
    plugin.settingsStore.commit({
      ...plugin.getSettings(),
      embedding: { ...plugin.getSettings().embedding, modelId: "local-embed" },
    });
    plugin.registerEvent = vi.fn();
    plugin.registerInterval = vi.fn();
    try {
      plugin.startAutomaticIndexing({
        vault: { on: (event: string, handler: any) => (handlers.set(event, handler), {}) },
      });
      handlers.get("modify")!({ path: "notes/a.md" });
      await vi.advanceTimersByTimeAsync(20_000);
      intervalCallback();
      expect(plugin.manualIndex.update).not.toHaveBeenCalled();
      expect(plugin.client.call).toHaveBeenCalledTimes(1);

      await plugin.updateIndex();
      intervalCallback();
      expect(plugin.manualIndex.update).toHaveBeenCalledOnce();
      expect(plugin.client.call).toHaveBeenCalledTimes(2);

      nextUpdateHasNotes = true;
      await plugin.updateIndex();
      intervalCallback();
      await vi.waitFor(() => expect(plugin.manualIndex.update).toHaveBeenCalledTimes(3));
      expect(plugin.client.call).toHaveBeenCalledTimes(4);
    } finally {
      plugin.onunload();
      vi.useRealTimers();
      if (previousWindow === undefined) vi.unstubAllGlobals();
      else vi.stubGlobal("window", previousWindow);
    }
  });

  it("queues a vault event during the first manual indexing run and follows after notes publish", async () => {
    vi.useFakeTimers();
    const previousWindow = (globalThis as any).window;
    let intervalCallback!: () => void;
    vi.stubGlobal("window", {
      setInterval: (callback: () => void) => ((intervalCallback = callback), 1),
    });
    const handlers = new Map<string, (file: any, oldPath?: string) => void>();
    let databaseHasNotes = false;
    let finishManual!: (result: any) => void;
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.client = {
      call: vi.fn(async () => databaseHasNotes),
      close: vi.fn(async () => undefined),
    };
    plugin.indexedNotes = false;
    plugin.manualIndex = {
      update: vi.fn(() =>
        plugin.manualIndex.update.mock.calls.length === 1
          ? new Promise((resolve) => (finishManual = resolve))
          : Promise.resolve({
              visited: 1,
              deleted: 0,
              numAdded: 0,
              numUpdated: 0,
              numSkipped: 0,
              sharing: "complete",
            })
      ),
      cancel: vi.fn(),
    };
    plugin.settingsStore.commit({
      ...plugin.getSettings(),
      embedding: { ...plugin.getSettings().embedding, modelId: "local-embed" },
    });
    plugin.registerEvent = vi.fn();
    plugin.registerInterval = vi.fn();
    try {
      plugin.startAutomaticIndexing({
        vault: { on: (event: string, handler: any) => (handlers.set(event, handler), {}) },
      });
      const manual = plugin.updateIndex();
      handlers.get("modify")!({ path: "notes/new.md" });
      await vi.advanceTimersByTimeAsync(20_000);
      intervalCallback();
      expect(plugin.manualIndex.update).toHaveBeenCalledOnce();

      databaseHasNotes = true;
      finishManual({
        visited: 1,
        deleted: 0,
        numAdded: 1,
        numUpdated: 0,
        numSkipped: 0,
        sharing: "complete",
      });
      await manual;
      await vi.waitFor(() => expect(plugin.manualIndex.update).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(plugin.indexRun).toBeUndefined());
      expect(plugin.client.call).toHaveBeenCalledTimes(2);
    } finally {
      plugin.onunload();
      vi.useRealTimers();
      if (previousWindow === undefined) vi.unstubAllGlobals();
      else vi.stubGlobal("window", previousWindow);
    }
  });

  it("keeps Clear and last-note deletion paused across a fresh plugin instance", async () => {
    vi.useFakeTimers();
    const previousWindow = (globalThis as any).window;
    let intervalCallback!: () => void;
    vi.stubGlobal("window", {
      setInterval: (callback: () => void) => ((intervalCallback = callback), 1),
    });
    let databaseHasNotes = true;
    const client = {
      call: vi.fn(async (method: string, _payload?: unknown) => {
        if (method === "noteStoreClear") databaseHasNotes = false;
        if (method === "noteStoreHasNotes") return databaseHasNotes;
      }),
      close: vi.fn(async () => undefined),
    };
    const first = new TramaPlugin(undefined as never, undefined as never) as any;
    first.client = client;
    first.app = { vault: { adapter: { exists: vi.fn(async () => false) } } };
    await first.clearIndex();
    expect(databaseHasNotes).toBe(false);
    expect(first.hasIndexedNotes).toBe(false);

    const handlers = new Map<string, (file: any, oldPath?: string) => void>();
    const second = new TramaPlugin(undefined as never, undefined as never) as any;
    second.client = client;
    second.indexedNotes = await client.call("noteStoreHasNotes", {});
    second.manualIndex = { update: vi.fn(), cancel: vi.fn() };
    second.settingsStore.commit({
      ...second.getSettings(),
      embedding: { ...second.getSettings().embedding, modelId: "local-embed" },
    });
    second.registerEvent = vi.fn();
    second.registerInterval = vi.fn();
    try {
      second.startAutomaticIndexing({
        vault: { on: (event: string, handler: any) => (handlers.set(event, handler), {}) },
      });
      handlers.get("create")!({ path: "notes/after-clear.md" });
      await vi.advanceTimersByTimeAsync(20_000);
      intervalCallback();
      expect(second.manualIndex.update).not.toHaveBeenCalled();

      databaseHasNotes = true;
      second.indexedNotes = await client.call("noteStoreHasNotes", {});
      second.manualIndex.update.mockImplementationOnce(async () => {
        databaseHasNotes = false;
        return { visited: 1, deleted: 1, numAdded: 0, numUpdated: 0, numSkipped: 0 };
      });
      intervalCallback();
      await vi.waitFor(() => expect(second.manualIndex.update).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(second.hasIndexedNotes).toBe(false));
      intervalCallback();
      expect(second.manualIndex.update).toHaveBeenCalledOnce();
    } finally {
      first.onunload();
      second.onunload();
      vi.useRealTimers();
      if (previousWindow === undefined) vi.unstubAllGlobals();
      else vi.stubGlobal("window", previousWindow);
    }
  });

  it("coalesces events during an active automatic run into one successful follow-up", async () => {
    vi.useFakeTimers();
    const previousWindow = (globalThis as any).window;
    let intervalCallback!: () => void;
    vi.stubGlobal("window", {
      setInterval: (callback: () => void) => ((intervalCallback = callback), 1),
    });
    const handlers = new Map<string, (file: any, oldPath?: string) => void>();
    let finishFirst!: (result: any) => void;
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.client = {
      call: vi.fn(async () => true),
      close: vi.fn(async () => undefined),
    };
    plugin.manualIndex = {
      update: vi.fn(() =>
        plugin.manualIndex.update.mock.calls.length === 1
          ? new Promise((resolve) => (finishFirst = resolve))
          : Promise.resolve({
              visited: 1,
              deleted: 0,
              numAdded: 0,
              numUpdated: 0,
              numSkipped: 0,
            })
      ),
      cancel: vi.fn(),
    };
    plugin.indexedNotes = true;
    plugin.settingsStore.commit({
      ...plugin.getSettings(),
      embedding: { ...plugin.getSettings().embedding, modelId: "local-embed" },
    });
    plugin.registerEvent = vi.fn();
    plugin.registerInterval = vi.fn();
    try {
      plugin.startAutomaticIndexing({
        vault: { on: (event: string, handler: any) => (handlers.set(event, handler), {}) },
      });
      handlers.get("modify")!({ path: "notes/a.md" });
      handlers.get("create")!({ path: "notes/b.md" });
      await vi.advanceTimersByTimeAsync(20_000);
      handlers.get("modify")!({ path: "notes/c.md" });
      await vi.advanceTimersByTimeAsync(20_000);
      intervalCallback();
      intervalCallback();
      expect(plugin.manualIndex.update).toHaveBeenCalledOnce();

      finishFirst({
        visited: 1,
        deleted: 0,
        numAdded: 0,
        numUpdated: 0,
        numSkipped: 0,
        sharing: "complete",
      });
      await vi.waitFor(() => expect(plugin.manualIndex.update).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(plugin.indexRun).toBeUndefined());
      expect(plugin.manualIndex.update).toHaveBeenCalledTimes(2);
    } finally {
      plugin.onunload();
      vi.useRealTimers();
      if (previousWindow === undefined) vi.unstubAllGlobals();
      else vi.stubGlobal("window", previousWindow);
    }
  });

  it("does not turn repeated busy timer ticks into a follow-up run", async () => {
    vi.useFakeTimers();
    const previousWindow = (globalThis as any).window;
    let intervalCallback!: () => void;
    vi.stubGlobal("window", {
      setInterval: (callback: () => void) => ((intervalCallback = callback), 1),
    });
    let finishFirst!: (result: any) => void;
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.client = {
      call: vi.fn(async () => true),
      close: vi.fn(async () => undefined),
    };
    plugin.manualIndex = {
      update: vi.fn(() => new Promise((resolve) => (finishFirst = resolve))),
      cancel: vi.fn(),
    };
    plugin.indexedNotes = true;
    plugin.settingsStore.commit({
      ...plugin.getSettings(),
      embedding: { ...plugin.getSettings().embedding, modelId: "local-embed" },
    });
    plugin.registerEvent = vi.fn();
    plugin.registerInterval = vi.fn();
    try {
      plugin.startAutomaticIndexing({ vault: { on: () => ({}) } });
      intervalCallback();
      intervalCallback();
      expect(plugin.manualIndex.update).toHaveBeenCalledOnce();
      finishFirst({
        visited: 1,
        deleted: 0,
        numAdded: 0,
        numUpdated: 0,
        numSkipped: 0,
        sharing: "complete",
      });
      await vi.waitFor(() => expect(plugin.indexRun).toBeUndefined());
      expect(plugin.manualIndex.update).toHaveBeenCalledOnce();
    } finally {
      plugin.onunload();
      vi.useRealTimers();
      if (previousWindow === undefined) vi.unstubAllGlobals();
      else vi.stubGlobal("window", previousWindow);
    }
  });

  it("does not retry a pending edit after publication is incomplete", async () => {
    vi.useFakeTimers();
    const previousWindow = (globalThis as any).window;
    vi.stubGlobal("window", { setInterval: () => 1 });
    const handlers = new Map<string, (file: any, oldPath?: string) => void>();
    let finishFirst!: (result: any) => void;
    const status = new IndexStatusController();
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.status = status;
    plugin.client = {
      call: vi.fn(async () => true),
      close: vi.fn(async () => undefined),
    };
    plugin.manualIndex = {
      update: vi.fn(() => new Promise((resolve) => (finishFirst = resolve))),
      cancel: vi.fn(),
    };
    plugin.indexedNotes = true;
    plugin.settingsStore.commit({
      ...plugin.getSettings(),
      embedding: { ...plugin.getSettings().embedding, modelId: "local-embed" },
    });
    plugin.registerEvent = vi.fn();
    plugin.registerInterval = vi.fn();
    try {
      plugin.startAutomaticIndexing({
        vault: { on: (event: string, handler: any) => (handlers.set(event, handler), {}) },
      });
      handlers.get("modify")!({ path: "notes/a.md" });
      await vi.advanceTimersByTimeAsync(20_000);
      finishFirst({
        visited: 1,
        deleted: 0,
        numAdded: 0,
        numUpdated: 0,
        numSkipped: 0,
        sharing: "incomplete",
      });
      await vi.waitFor(() => expect(plugin.indexRun).toBeUndefined());
      expect(plugin.hasIndexedNotes).toBe(true);
      expect(plugin.manualIndex.update).toHaveBeenCalledOnce();
      expect(status.getStatus()).toMatchObject({
        kind: "ready",
        message: "Index updated; sharing incomplete.",
      });
    } finally {
      plugin.onunload();
      vi.useRealTimers();
      if (previousWindow === undefined) vi.unstubAllGlobals();
      else vi.stubGlobal("window", previousWindow);
    }
  });

  it.each(["failure", "stop", "unload"] as const)(
    "drops a pending automatic follow-up after %s",
    async (ending) => {
      vi.useFakeTimers();
      const previousWindow = (globalThis as any).window;
      vi.stubGlobal("window", {
        setInterval: () => 1,
      });
      const handlers = new Map<string, (file: any, oldPath?: string) => void>();
      let rejectFirst!: (error: unknown) => void;
      let firstStarted!: () => void;
      const started = new Promise<void>((resolve) => (firstStarted = resolve));
      let calls = 0;
      const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
      plugin.client = {
        call: vi.fn(async () => true),
        close: vi.fn(async () => undefined),
      };
      plugin.manualIndex = {
        update: vi.fn(() => {
          calls++;
          if (calls === 1) {
            firstStarted();
            return new Promise((_resolve, reject) => (rejectFirst = reject));
          }
          return Promise.resolve({
            visited: 1,
            deleted: 0,
            numAdded: 0,
            numUpdated: 0,
            numSkipped: 0,
          });
        }),
        cancel: vi.fn(() => rejectFirst(new DOMException("Aborted", "AbortError"))),
      };
      plugin.indexedNotes = true;
      plugin.settingsStore.commit({
        ...plugin.getSettings(),
        embedding: { ...plugin.getSettings().embedding, modelId: "local-embed" },
      });
      plugin.registerEvent = vi.fn();
      plugin.registerInterval = vi.fn();
      try {
        plugin.startAutomaticIndexing({
          vault: { on: (event: string, handler: any) => (handlers.set(event, handler), {}) },
        });
        await started;
        handlers.get("modify")!({ path: "notes/a.md" });
        handlers.get("create")!({ path: "notes/b.md" });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(calls).toBe(1);

        if (ending === "failure") rejectFirst(new Error("index failed"));
        if (ending === "stop") plugin.stopIndex();
        if (ending === "unload") plugin.onunload();
        await vi.waitFor(() => expect(plugin.indexRun).toBeUndefined());
        expect(calls).toBe(1);
        expect(calls).toBe(1);
      } finally {
        plugin.onunload();
        vi.useRealTimers();
        if (previousWindow === undefined) vi.unstubAllGlobals();
        else vi.stubGlobal("window", previousWindow);
      }
    }
  );

  it("clears the index and SQLite/shared caches and reports the committed status", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.status = new IndexStatusController();
    const invalidateRelated = vi.fn();
    const refreshSubmitted = vi.fn();
    const cancelSearches = vi.fn();
    const clearResults = vi.fn();
    plugin.retrieval = { invalidateRelated, cancelSearches };
    plugin.app = {
      workspace: { getLeavesOfType: () => [{ view: { refreshSubmitted, clearResults } }] },
      vault: {
        adapter: {
          exists: vi.fn(async () => false),
          list: vi.fn(async () => ({ folders: [], files: [] })),
        },
      },
    };
    plugin.client = { call: vi.fn(async () => undefined) };
    await plugin.clearIndex();
    expect(plugin.client.call).toHaveBeenCalledWith("noteStoreClear", {}, expect.any(AbortSignal));
    expect(invalidateRelated).toHaveBeenCalledOnce();
    expect(refreshSubmitted).not.toHaveBeenCalled();
    expect(clearResults).toHaveBeenCalledOnce();
    expect(cancelSearches).toHaveBeenCalledOnce();
    expect(plugin.status.getStatus()).toMatchObject({
      kind: "index-required",
      message: "Local index and embedding cache cleared.",
    });
    expect(plugin.updateIndex).toBeDefined();
  });

  it.each([false, true])(
    "keeps caches empty after Clear with a submitted Lente query (pending: %s)",
    async (pending) => {
      const sqlite = await loadTestSqlite();
      const db = new sqlite.oo1.DB(":memory:", "c");
      const database = new NoteSqliteDatabase(db);
      const call = database.call.bind(database);
      let release!: (vector: number[]) => void;
      const embedQuery = vi.fn(() =>
        pending
          ? new Promise<number[]>((resolve) => {
              release = resolve;
            })
          : Promise.resolve([1, 0])
      );
      const cache = new SqliteEmbeddingCache(
        { embedDocuments: async () => [], embedQuery },
        call,
        embeddingCacheIdentity("test", 2),
        2
      );
      const retrieval = new VaultRetrieval(call, cache, "profile", async () => null);
      const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
      const view = new LenteView({} as any, retrieval.runnable) as any;
      view.opened = true;
      view.submitted = "needle";
      plugin.retrieval = retrieval;
      plugin.client = { call };
      plugin.app = {
        workspace: {
          getLeavesOfType: (type: string) => (type === "trama-lente" ? [{ view }] : []),
        },
        vault: { adapter: { exists: async () => false } },
      };
      try {
        const search = view.run("needle");
        await vi.waitFor(() => expect(embedQuery).toHaveBeenCalledOnce());
        if (!pending) {
          await search;
          expect(db.selectValue("SELECT count(*) FROM embedding_cache")).toBe(1);
        }
        await plugin.clearIndex();
        if (pending) release([1, 0]);
        await search;
        view.refreshSubmitted();
        expect(embedQuery).toHaveBeenCalledOnce();
        expect(db.selectValue("SELECT count(*) FROM embedding_cache")).toBe(0);
        expect(view.output).toBeUndefined();
        expect(view.submitted).toBe("");
      } finally {
        db.close();
      }
    }
  );

  it("keeps committed clear status after shared-file cancellation and allows a retry", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.status = new IndexStatusController();
    plugin.indexedNotes = true;
    plugin.app = { vault: { adapter: {} } };
    plugin.client = { call: vi.fn(async () => undefined) };
    let cleanupSignal!: AbortSignal;
    let rejectCleanup!: (error: unknown) => void;
    const cleanup = vi
      .spyOn(VaultEmbeddingCache, "clearManagedFiles")
      .mockImplementationOnce((_adapter, signal) => {
        cleanupSignal = signal;
        return new Promise((_resolve, reject) => (rejectCleanup = reject));
      })
      .mockResolvedValueOnce(0);

    const first = plugin.clearIndex();
    await vi.waitFor(() => expect(cleanupSignal).toBeInstanceOf(AbortSignal));
    plugin.stopIndex();
    expect(cleanupSignal.aborted).toBe(true);
    rejectCleanup(new DOMException("Aborted", "AbortError"));
    await first;
    expect(plugin.hasIndexedNotes).toBe(false);
    expect(plugin.status.getStatus()).toMatchObject({
      kind: "index-required",
      message: expect.stringContaining("shared cache cleanup is incomplete"),
      canCancel: false,
    });

    await plugin.clearIndex();
    expect(plugin.client.call).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(plugin.status.getStatus()).toMatchObject({
      kind: "index-required",
      message: "Local index and embedding cache cleared.",
    });
    cleanup.mockRestore();
  });

  it("reports shared-file cleanup failure after SQL commit and retries safely", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.status = new IndexStatusController();
    plugin.indexedNotes = true;
    plugin.app = { vault: { adapter: {} } };
    plugin.client = { call: vi.fn(async () => undefined) };
    const cleanup = vi
      .spyOn(VaultEmbeddingCache, "clearManagedFiles")
      .mockRejectedValueOnce(new Error("vault is read-only"))
      .mockResolvedValueOnce(0);

    await plugin.clearIndex();
    expect(plugin.hasIndexedNotes).toBe(false);
    expect(plugin.status.getStatus()).toMatchObject({
      kind: "index-required",
      message: expect.stringContaining("shared cache cleanup is incomplete"),
      canIndex: false,
    });
    expect((Notice as any).instances.at(-1).message).toContain(
      "Local index and SQLite cache cleared; shared cache cleanup is incomplete. Retry Clear to finish. vault is read-only"
    );
    await plugin.clearIndex();
    expect(plugin.client.call).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(plugin.status.getStatus().message).toBe("Local index and embedding cache cleared.");
    cleanup.mockRestore();
  });

  it("stops a running clear without claiming success and excludes other index actions", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.status = new IndexStatusController();
    let rejectReset!: (error: unknown) => void;
    let resetSignal!: AbortSignal;
    const reset = new Promise((_, reject) => (rejectReset = reject));
    plugin.client = {
      call: vi.fn((_method: string, _payload: unknown, signal: AbortSignal) => {
        resetSignal = signal;
        return reset;
      }),
    };
    const clear = plugin.clearIndex();
    await plugin.updateIndex();
    expect(plugin.manualIndex).toBeUndefined();
    plugin.stopIndex();
    expect(resetSignal.aborted).toBe(true);
    rejectReset(new DOMException("Aborted", "AbortError"));
    await clear;
    expect(plugin.status.getStatus().kind).toBe("index-required");
  });

  it("returns the active note and first five distinct related catalog paths for Voce", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.activeNote = "notes/current.md";
    plugin.catalog = () => [
      "notes/current.md",
      "notes/a.md",
      "notes/b.md",
      "notes/c.md",
      "notes/d.md",
      "notes/e.md",
      "notes/f.md",
    ];
    plugin.retrieval = {
      relatedPaths: vi.fn(async () => ({
        available: true,
        paths: [
          "notes/current.md",
          "notes/a.md",
          "notes/a.md",
          "hidden.md",
          "notes/b.md",
          "notes/c.md",
          "notes/d.md",
          "notes/e.md",
          "notes/f.md",
        ],
      })),
    };
    await expect(plugin.relatedNoteSuggestions(new AbortController().signal)).resolves.toEqual([
      "notes/a.md",
      "notes/b.md",
      "notes/c.md",
      "notes/d.md",
      "notes/e.md",
    ]);
    expect(plugin.retrieval.relatedPaths).toHaveBeenCalledWith(
      "notes/current.md",
      expect.any(AbortSignal),
      7
    );
  });

  it.each([
    { initial: [], next: ["Projects"], active: true, following: false },
    { initial: ["Projects"], next: [], active: false, following: true },
  ])(
    "keeps eligibility stable when exclusions change during an active Update ($initial to $next)",
    async ({ initial, next, active, following }) => {
      const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
      plugin.settingsStore.load({ ...plugin.getSettings(), excludedFolders: initial });
      plugin.saveData = vi.fn(async () => undefined);
      plugin.configureServices = vi.fn(async () => undefined);
      let releaseRead!: () => void;
      let notifyRead!: () => void;
      const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
      const readStarted = new Promise<void>((resolve) => (notifyRead = resolve));
      const eligibility: boolean[] = [];
      let isPaused = true;
      plugin.manualIndex = {
        update: async () => {
          eligibility.push(plugin.isIndexableMarkdown("Projects/note.md"));
          if (isPaused) {
            isPaused = false;
            notifyRead();
            await readGate;
          }
          eligibility.push(plugin.isIndexableMarkdown("Projects/note.md"));
          return { visited: 1, deleted: 0, numAdded: 0, numUpdated: 0, numSkipped: 1 };
        },
        rebuild: async () => ({
          visited: 0,
          deleted: 0,
          numAdded: 0,
          numUpdated: 0,
          numSkipped: 0,
        }),
        cancel: vi.fn(),
      };

      const activeUpdate = plugin.updateIndex();
      await readStarted;
      await plugin.saveSettings((current: any) => ({ ...current, excludedFolders: next }));
      expect(plugin.configureServices).not.toHaveBeenCalled();
      releaseRead();
      await activeUpdate;
      expect(eligibility).toEqual([active, active]);

      await plugin.updateIndex();
      expect(eligibility.slice(2)).toEqual([following, following]);
    }
  );

  it.each(["stop", "unload"] as const)(
    "starts ManualIndex synchronously so immediate %s reaches the active run",
    async (action) => {
      const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
      let cancelled = false;
      let startedAfterCancel = false;
      const manualIndex = {
        update: vi.fn(async () => {
          startedAfterCancel ||= cancelled;
          return { visited: 0, deleted: 0, numAdded: 0, numUpdated: 0, numSkipped: 0 };
        }),
        rebuild: vi.fn(async () => ({
          visited: 0,
          deleted: 0,
          numAdded: 0,
          numUpdated: 0,
          numSkipped: 0,
        })),
        cancel: vi.fn(() => {
          cancelled = true;
        }),
      };
      plugin.manualIndex = manualIndex;
      const update = plugin.updateIndex();
      if (action === "stop") plugin.stopIndex();
      else plugin.onunload();
      await update;
      expect(manualIndex.update).toHaveBeenCalledOnce();
      expect(manualIndex.cancel).toHaveBeenCalledOnce();
      expect(startedAfterCancel).toBe(false);
    }
  );

  it("assigns each vault a stable independent namespace and rejects a malformed identity", async () => {
    const runtime = new NoteSqliteRuntime();
    const makeApp = () => {
      const files = new Map<string, string>();
      const directories = new Set<string>();
      return {
        files,
        app: {
          vault: {
            adapter: {
              exists: async (path: string) => files.has(path),
              read: async (path: string) => files.get(path) ?? "",
              mkdir: async (path: string) => directories.add(path),
              write: async (path: string, contents: string) => files.set(path, contents),
            },
          },
        },
      };
    };
    const first = makeApp();
    const second = makeApp();
    const firstNamespace = await runtime.resolveNamespace(first.app);
    const secondNamespace = await runtime.resolveNamespace(second.app);
    expect(firstNamespace).toMatch(/^[0-9a-f]{64}$/);
    expect(secondNamespace).toMatch(/^[0-9a-f]{64}$/);
    expect(firstNamespace).not.toBe(secondNamespace);
    expect(await runtime.resolveNamespace(first.app)).toBe(firstNamespace);
    const customNamespace = await runtime.resolveNamespace(first.app, "Sync/Trama");
    expect(customNamespace).not.toBe(firstNamespace);
    expect(first.files.has("Sync/Trama/identity.json")).toBe(true);
    expect(await runtime.resolveNamespace(first.app, "Sync/Trama")).toBe(customNamespace);
    first.files.set(".trama/identity.json", "{}");
    await expect(runtime.resolveNamespace(first.app)).rejects.toThrow(/identity is invalid/);
  });

  it("shows successful indexing separately from incomplete or cancelled sharing", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.status = new IndexStatusController();
    const results = ["incomplete", "cancelled"];
    plugin.manualIndex = {
      update: async () => ({
        visited: 3,
        deleted: 0,
        numAdded: 1,
        numUpdated: 0,
        numSkipped: 2,
        sharing: results.shift(),
      }),
      rebuild: async () => {
        throw new Error("unused");
      },
      cancel: vi.fn(),
    };

    await plugin.updateIndex();
    expect(plugin.status.getStatus()).toMatchObject({
      kind: "ready",
      message: "Index updated; sharing incomplete.",
      canIndex: true,
      canReindex: true,
    });
    await plugin.updateIndex();
    expect(plugin.status.getStatus()).toMatchObject({
      kind: "ready",
      message: "Index updated; sharing cancelled.",
      canIndex: true,
      canReindex: true,
    });
  });

  it("allows a replacement index run while an old run settles and fences stale status callbacks", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.status = new IndexStatusController();
    let finishOld!: (value: { visited: number; deleted: number; lexicalOnly: boolean }) => void;
    const old = {
      update: () => new Promise((resolve) => (finishOld = resolve)),
      rebuild: () => Promise.reject(new Error("unused")),
      cancel: vi.fn(),
    };
    plugin.manualIndex = old;
    const oldRun = plugin.updateIndex();
    const fresh = {
      update: async () => ({ visited: 2, deleted: 0, lexicalOnly: false }),
      rebuild: async () => ({ visited: 2, deleted: 0, lexicalOnly: false }),
      cancel: vi.fn(),
    };
    plugin.manualIndex = fresh;
    const freshRun = plugin.updateIndex();
    await freshRun;
    expect(plugin.status.getStatus().message).toBe("Indexed 2 notes.");
    finishOld({ visited: 1, deleted: 0, lexicalOnly: false });
    await oldRun;
    expect(plugin.status.getStatus().message).toBe("Indexed 2 notes.");
    expect(plugin.indexRun).toBeUndefined();
  });

  it("does not create a worker or UI when unload happens during namespace resolution", async () => {
    let releaseNamespace!: (namespace: string) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const namespace = new Promise<string>((resolve) => (releaseNamespace = resolve));
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.app = {
      vault: { getMarkdownFiles: () => [] },
      workspace: { getActiveFile: () => null, getLeavesOfType: () => [], on: () => ({}) },
      metadataCache: {},
    };
    plugin.manifest = { id: "trama", dir: ".obsidian/plugins/trama", version: "test" };
    plugin.loadData = vi.fn(async () => undefined);
    plugin.sqliteRuntime.resolveNamespace = vi.fn(() => {
      entered();
      return namespace;
    });
    const createWorker = vi.spyOn(plugin.sqliteRuntime, "createWorker");
    const loadUi = vi.spyOn(await import("@/plugin/PluginUi"), "loadPluginUi");
    const loading = plugin.onload();
    await started;
    plugin.onunload();
    releaseNamespace("a".repeat(64));
    await loading;
    expect(createWorker).not.toHaveBeenCalled();
    expect(loadUi).not.toHaveBeenCalled();
    loadUi.mockRestore();
  });

  it("rejects startup and closes the candidate worker when SQLite initialization fails", async () => {
    const workers: any[] = [];
    const WorkerStub = vi.fn(function () {
      const listeners = new Set<(event: any) => void>();
      const worker = {
        postMessage: vi.fn((request: any) => {
          if (request.method === "init")
            for (const listener of listeners)
              listener({
                data: {
                  id: request.id,
                  ok: false,
                  error: { name: "Error", message: "WASM failed" },
                },
              });
        }),
        addEventListener: vi.fn(
          (_type: string, listener: (event: any) => void) =>
            _type === "message" && listeners.add(listener)
        ),
        removeEventListener: vi.fn((_type: string, listener: (event: any) => void) =>
          listeners.delete(listener)
        ),
        terminate: vi.fn(),
      };
      // Observe the original native hooks before the runtime wraps termination.
      workers.push({ ...worker });
      return worker;
    });
    const originalWorker = globalThis.Worker;
    globalThis.Worker = WorkerStub as unknown as typeof Worker;
    const files = new Map<string, string>();
    const directories = new Set<string>();
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.app = {
      vault: {
        configDir: ".obsidian",
        getMarkdownFiles: () => [],
        adapter: {
          getResourcePath: (path: string) => `app://vault/${path}`,
          exists: async (path: string) => files.has(path),
          read: async (path: string) => files.get(path) ?? "",
          mkdir: async (path: string) => directories.add(path),
          write: async (path: string, contents: string) => files.set(path, contents),
        },
      },
      workspace: { getActiveFile: () => null, getLeavesOfType: () => [], on: () => ({}) },
      metadataCache: {},
    };
    plugin.manifest = { id: "trama", dir: ".obsidian/plugins/trama", version: "test" };
    plugin.loadData = vi.fn(async () => undefined);
    try {
      await expect(plugin.onload()).rejects.toThrow("WASM failed");
      expect(workers).toHaveLength(1);
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      expect(plugin.session).toBeUndefined();
    } finally {
      plugin.onunload();
      globalThis.Worker = originalWorker;
    }
  });

  it("serializes overlapping settings saves and leaves only the latest worker active", async () => {
    let releaseFirstClose!: () => void;
    let closeStarted!: () => void;
    const closeSeen = new Promise<void>((resolve) => (closeStarted = resolve));
    const firstClose = new Promise<void>((resolve) => (releaseFirstClose = resolve));
    const workers: any[] = [];
    const WorkerStub = vi.fn(function () {
      const listeners = new Set<(event: any) => void>();
      const worker = {
        postMessage: vi.fn((request: any) => {
          if (request.method === "close" && workers.length === 1) {
            closeStarted();
            void firstClose.then(() => {
              for (const listener of listeners)
                listener({ data: { id: request.id, ok: true, result: undefined } });
            });
          } else if (
            request.method === "init" ||
            request.method === "close" ||
            request.method === "noteStoreHasNotes"
          ) {
            for (const listener of listeners)
              listener({
                data: {
                  id: request.id,
                  ok: true,
                  result: request.method === "noteStoreHasNotes" ? false : undefined,
                },
              });
          }
        }),
        addEventListener: vi.fn(
          (_type: string, listener: (event: any) => void) =>
            _type === "message" && listeners.add(listener)
        ),
        removeEventListener: vi.fn((_type: string, listener: (event: any) => void) =>
          listeners.delete(listener)
        ),
        terminate: vi.fn(),
      };
      // Observe the original native hooks before the runtime wraps termination.
      workers.push({ ...worker });
      return worker;
    });
    const originalWorker = globalThis.Worker;
    globalThis.Worker = WorkerStub as unknown as typeof Worker;
    const files = new Map<string, string>();
    const directories = new Set<string>();
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.app = {
      vault: {
        configDir: ".obsidian",
        getMarkdownFiles: () => [],
        getFileByPath: () => null,
        read: async () => "",
        adapter: {
          getResourcePath: (path: string) => `app://vault/${path}`,
          exists: async (path: string) => files.has(path),
          read: async (path: string) => files.get(path) ?? "",
          mkdir: async (path: string) => directories.add(path),
          write: async (path: string, contents: string) => files.set(path, contents),
        },
      },
      workspace: { getActiveFile: () => null, getLeavesOfType: () => [], on: () => ({}) },
      metadataCache: {},
    };
    plugin.manifest = { id: "trama", dir: ".obsidian/plugins/trama", version: "test" };
    plugin.loadData = vi.fn(async () => undefined);
    const saved: string[] = [];
    plugin.saveData = vi.fn(async (settings: any) => saved.push(settings.embedding.modelId));
    try {
      await plugin.onload();
      const first = plugin.saveSettings((settings: any) => ({
        ...settings,
        embedding: { ...settings.embedding, modelId: "first" },
      }));
      const second = plugin.saveSettings((settings: any) => ({
        ...settings,
        embedding: { ...settings.embedding, modelId: "second" },
      }));
      await closeSeen;
      expect(saved).toEqual(["first"]);
      expect(workers).toHaveLength(1);
      releaseFirstClose();
      await Promise.all([first, second]);
      expect(saved).toEqual(["first", "second"]);
      expect(plugin.getSettings().embedding.modelId).toBe("second");
      expect(workers).toHaveLength(3);
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      expect(workers[1].terminate).toHaveBeenCalledOnce();
      expect(workers[2].terminate).not.toHaveBeenCalled();
    } finally {
      plugin.onunload();
      globalThis.Worker = originalWorker;
    }
  });
});
