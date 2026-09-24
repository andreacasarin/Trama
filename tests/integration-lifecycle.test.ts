import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { TramaPlugin } from "@/plugin/TramaPlugin";
import { DEFAULT_SETTINGS } from "@/settings/Settings";
import { createTestSqliteClient } from "./sqlite-test-client";

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
      exists: async (path: string) => adapterFiles.has(path),
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
    await plugin.saveSettings({ ...DEFAULT_SETTINGS, detailedDebug: true });
    diagnostics.emit({
      area: "chat",
      event: "model_error",
      error: new Error("visible"),
      durationMs: 12,
    });
    await plugin.saveSettings({ ...DEFAULT_SETTINGS, detailedDebug: false });
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
        {
          area: "chat",
          event: "model_error",
          error: expect.objectContaining({ message: "visible" }),
          durationMs: 12,
        },
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
    await plugin.saveSettings({ ...settings, detailedDebug: true });

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
