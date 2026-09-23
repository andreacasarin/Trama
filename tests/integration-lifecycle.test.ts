import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { TramaPlugin } from "@/plugin/TramaPlugin";
import { DEFAULT_SETTINGS } from "@/settings/Settings";
import { IndexStatusController } from "@/ui/index/IndexStatus";
import { LenteSearch } from "@/index/LenteSearch";
import type { TramaDiagnosticRecord } from "@/diagnostics/TramaDiagnostics";
import { createTestSqliteClient } from "./sqlite-test-client";
import { SQLITE_PROTOCOL_VERSION } from "@/index/sqlite/protocol";

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
  const layoutCallbacks: Array<() => void> = [];
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
    getLeavesOfType: (_type?: string) => [],
    getLeaf: () => ({ setViewState: vi.fn() }),
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
    onLayoutReady: (callback: () => void) => {
      layoutCallbacks.push(callback);
    },
  };
  return {
    vault,
    workspace,
    metadataCache: { getFirstLinkpathDest: () => null, getFileCache: () => ({ links: [] }) },
    listeners,
    layoutCallbacks,
  };
}

function projectedPlugin(app: ReturnType<typeof projectedApp>, data = DEFAULT_SETTINGS) {
  const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
  plugin.app = app;
  plugin.manifest = { dir: ".obsidian/plugins/trama" };
  plugin.loadData = vi.fn(async () => data);
  plugin.saveData = vi.fn(async () => undefined);
  plugin.sqliteClientFactory = (storage: object) => createTestSqliteClient(storage);
  plugin.addCommand = vi.fn();
  plugin.addSettingTab = vi.fn();
  plugin.registerView = vi.fn();
  const registeredEvents: { unsubscribe?: () => void }[] = [];
  plugin.registerEvent = vi.fn((ref: { unsubscribe?: () => void }) => {
    registeredEvents.push(ref);
  });
  const onunload = plugin.onunload.bind(plugin);
  plugin.onunload = () => {
    for (const ref of registeredEvents) ref.unsubscribe?.();
    onunload();
  };
  return plugin as TramaPlugin & { app: typeof app };
}

async function optInToAutomaticUpdates(plugin: TramaPlugin): Promise<void> {
  const current = plugin.getSettings();
  await plugin.saveSettings({
    ...current,
    filo: { ...current.filo, automaticLexicalDelayMs: 750 },
  });
}

function automaticSemanticHarness(delayMs: number, eligible = true) {
  const settings = {
    ...DEFAULT_SETTINGS,
    filo: { ...DEFAULT_SETTINGS.filo, automaticSemanticDelayMs: delayMs },
  };
  const plugin = projectedPlugin(projectedApp(), settings) as any;
  plugin.settingsStore.load({ ...settings, schemaVersion: 5 });
  const manager = {
    isComplete: () => true,
    isBuilding: () => false,
    capabilities: () => ({ semantic: { searchable: eligible, activity: "idle" } }),
    disposeImmediately: vi.fn(),
    hasCompatibleSemanticVectors: () => eligible,
    prepareSemanticCacheBatch: vi.fn(async () => ({
      converged: true,
      state: { semanticReady: true },
    })),
  };
  plugin.index = manager;
  plugin.indexStatus = new IndexStatusController({} as any, {
    index: async () => undefined,
    reindex: async () => undefined,
    cancel: () => undefined,
  });
  plugin.indexReady = true;
  plugin.automaticSemanticEligible = eligible;
  return { plugin, manager };
}

describe("TramaPlugin lifecycle integration", () => {
  beforeEach(() => {
    Platform.isDesktopApp = true;
    vi.restoreAllMocks();
  });

  it("persists one opaque SQLite identity through the vault adapter", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app) as any;
    plugin.lifecycleAbort = new AbortController();
    plugin.composeRuntime(app, DEFAULT_SETTINGS);
    await plugin.indexLoad;
    const path = ".trama/sqlite/v1/identity.json";
    const first = JSON.parse(await app.vault.adapter.read(path));
    expect(first).toMatchObject({ version: 1, identity: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(first.identity).not.toBe("vault");
    plugin.composeRuntime(app, DEFAULT_SETTINGS);
    await plugin.indexLoad;
    expect(JSON.parse(await app.vault.adapter.read(path)).identity).toBe(first.identity);
  });

  it("resolves the Worker from the installed plugin resource path", () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app) as any;
    expect(plugin.sqliteWorkerUrl(app)).toEqual(
      expect.stringMatching(
        /^app:\/\/local\/\.obsidian\/plugins\/trama\/sqlite-worker\.mjs\?v=8&nonce=.+$/
      )
    );
  });

  it("falls back to the configured plugin directory when manifest.dir is absent", () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app) as any;
    plugin.manifest = { id: "trama" };
    expect(plugin.sqliteWorkerUrl(app)).toEqual(
      expect.stringMatching(
        /^app:\/\/local\/\.obsidian\/plugins\/trama\/sqlite-worker\.mjs\?v=8&nonce=.+$/
      )
    );
  });

  it("boots the Worker through a blob module with explicit local asset URLs", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app) as any;
    const originalWorker = globalThis.Worker;
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    let bootstrap: Blob | undefined;
    const worker = { postMessage: vi.fn(), addEventListener: vi.fn(), terminate: vi.fn() };
    URL.createObjectURL = vi.fn((blob: Blob) => {
      bootstrap = blob;
      return "blob:trama-worker";
    });
    URL.revokeObjectURL = vi.fn();
    globalThis.Worker = vi.fn(() => worker) as any;
    try {
      expect(plugin.createSqliteWorker(app)).toBe(worker);
      expect(globalThis.Worker).toHaveBeenCalledWith("blob:trama-worker", { type: "module" });
      expect(await bootstrap!.text()).toContain(
        '"moduleUrl":"app://local/.obsidian/plugins/trama/sqlite3.mjs"'
      );
      expect(await bootstrap!.text()).toContain(
        '"wasmUrl":"app://local/.obsidian/plugins/trama/sqlite3.wasm"'
      );
      expect(await bootstrap!.text()).toEqual(
        expect.stringContaining(
          'const __tramaWorkerUrl="app://local/.obsidian/plugins/trama/sqlite-worker.mjs?v=8&nonce='
        )
      );
      expect(await bootstrap!.text()).toContain("await import(__tramaWorkerUrl)");
      expect(await bootstrap!.text()).toContain(
        `v:${SQLITE_PROTOCOL_VERSION},id:Number.isSafeInteger`
      );
      expect(await bootstrap!.text()).toContain('code:"storage_unavailable"');
      expect(await bootstrap!.text()).toContain("URL.revokeObjectURL(globalThis.location.href)");
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    } finally {
      globalThis.Worker = originalWorker;
      URL.createObjectURL = originalCreateObjectUrl;
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });

  it("cache-busts worker URLs across plugin instances", () => {
    const app = projectedApp();
    const first = projectedPlugin(app) as any;
    const second = projectedPlugin(app) as any;
    expect(first.sqliteWorkerUrl(app)).not.toBe(second.sqliteWorkerUrl(app));
    expect(first.sqliteWorkerUrl(app)).toBe(first.sqliteWorkerUrl(app));
  });

  it("revokes the bootstrap blob when Worker construction fails", () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app) as any;
    const originalWorker = globalThis.Worker;
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:trama-worker");
    URL.revokeObjectURL = vi.fn();
    globalThis.Worker = vi.fn(() => {
      throw new Error("worker construction failed");
    }) as any;
    try {
      expect(() => plugin.createSqliteWorker(app)).toThrow("worker construction failed");
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:trama-worker");
    } finally {
      globalThis.Worker = originalWorker;
      URL.createObjectURL = originalCreateObjectUrl;
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });

  it("refreshes Lente only when reconciliation changes the index", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    const refreshSubmitted = vi.fn();
    plugin.app = {
      workspace: {
        getLeavesOfType: (type: string) =>
          type === "trama-lente" ? [{ view: { refreshSubmitted } }] : [],
      },
    };
    plugin.indexReady = true;
    plugin.lifecycleAbort = new AbortController();
    plugin.indexStatus = {
      setUpdating: vi.fn(),
      setReady: vi.fn(),
      markStale: vi.fn(),
      setCapabilities: vi.fn(),
      setSchedulerMessage: vi.fn(),
    };
    plugin.index = {
      isBuilding: () => false,
      hasCompatibleSemanticVectors: () => false,
      capabilities: () => ({ semantic: { activity: "idle" } }),
      isComplete: () => true,
      journalSnapshot: () => ({ changes: [], fullRecovery: true, revision: 1 }),
      pendingChangeCount: () => 0,
      clearJournalIfCurrent: vi.fn(),
      hasPendingWork: () => false,
      synchronize: vi
        .fn()
        .mockResolvedValueOnce({ changed: false, converged: true })
        .mockResolvedValueOnce({ changed: true, converged: true }),
    };
    await plugin.reconcileNow();
    expect(refreshSubmitted).not.toHaveBeenCalled();
    plugin.queuedWork = true;
    await plugin.reconcileNow();
    expect(refreshSubmitted).toHaveBeenCalledTimes(1);
  });

  it("does not refresh Lente after load or replacement, but refreshes after an index change", async () => {
    const app = projectedApp();
    const refreshSubmitted = vi.fn();
    const setSearch = vi.fn();
    const getLeavesOfType = app.workspace.getLeavesOfType;
    app.workspace.getLeavesOfType = ((type?: string) =>
      type === "trama-lente"
        ? [{ view: { refreshSubmitted, setSearch } }]
        : getLeavesOfType()) as any;
    const plugin = projectedPlugin(app) as any;
    vi.spyOn(
      (await import("@/index/IndexManager")).IndexManager.prototype,
      "load"
    ).mockResolvedValue(true);
    plugin.lifecycleAbort = new AbortController();
    plugin.composeRuntime(app, DEFAULT_SETTINGS);
    await plugin.indexLoad;
    await Promise.resolve();
    expect(setSearch).toHaveBeenCalled();
    expect(refreshSubmitted).not.toHaveBeenCalled();

    const index = plugin.index;
    vi.spyOn(index, "synchronize").mockResolvedValue({ changed: true, converged: true });
    await plugin.runIndex(new AbortController().signal, false);
    expect(refreshSubmitted).toHaveBeenCalledTimes(1);
  });

  it("cold desktop startup registers shell surfaces and listeners without fetch or discovery", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const debugSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await plugin.onload();

    expect(plugin.isDesktopLoaded()).toBe(true);
    expect(plugin.addCommand).toHaveBeenCalledTimes(12);
    expect(plugin.registerView).toHaveBeenCalledTimes(3);
    expect(plugin.registerView).toHaveBeenCalledWith("trama-voce", expect.any(Function));
    expect(plugin.registerView).toHaveBeenCalledWith("trama-filo", expect.any(Function));
    expect(plugin.registerView).toHaveBeenCalledWith("trama-lente", expect.any(Function));
    expect(
      (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.map(
        ([command]) => (command as { id: string }).id
      )
    ).toEqual([
      "index-filo-vault",
      "reindex-filo-vault",
      "prepare-semantic-index",
      "rebuild-semantic-index",
      "rebuild-both-indexes",
      "force-update-indexes",
      "publish-index-now",
      "cancel-filo-indexing",
      "open-voce",
      "open-filo",
      "open-lente",
      "search-with-lente",
    ]);
    expect(
      (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls
        .map(([command]) => command as { id: string; icon?: string })
        .filter(
          ({ id }) =>
            id === "open-voce" ||
            id === "open-filo" ||
            id === "open-lente" ||
            id === "search-with-lente"
        )
        .map(({ id, icon }) => [id, icon])
    ).toEqual([
      ["open-voce", "message-circle"],
      ["open-filo", "route"],
      ["open-lente", "binoculars"],
      ["search-with-lente", "binoculars"],
    ]);
    expect(plugin.addSettingTab).toHaveBeenCalledTimes(1);
    expect(app.listeners).toHaveLength(6);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it("keeps vault events queued and stale when lexical automation is Off", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 0 },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await plugin.onload();
    await (plugin as any).indexLoad;
    const index = (plugin as any).index;
    const queue = vi.spyOn(index, "recordPathMutation");
    (index as any).hasUsableIndex = vi.fn(() => true);
    const modify = app.listeners.find((ref) => ref.event === "modify");

    modify?.callback({ path: "Note.md" });

    expect(queue).toHaveBeenCalledTimes(1);
    expect((plugin as any).eventTimer).toBeUndefined();
    expect((plugin as any).indexStatus.getStatus()).toMatchObject({
      kind: "stale",
      hasLastGood: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rebinds only Lente when Lente settings change and applies the configured search options", async () => {
    const search = vi.spyOn(LenteSearch.prototype, "search").mockResolvedValue({
      generationId: "g1",
      mode: "lexical",
      degraded: false,
      displayLimit: 35,
      results: [],
      canonicalResults: [],
      durationMs: 0,
    });
    const app = projectedApp();
    const setSearch = vi.fn();
    (app.workspace as any).getLeavesOfType = (type: string) =>
      type === "trama-lente" ? [{ view: { setSearch, refreshSubmitted: vi.fn() } }] : [];
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
    const oldSession = (plugin as any).session;
    const oldIndex = (plugin as any).index;
    const oldLente = (plugin as any).lenteSearch;

    await plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      lente: { ...DEFAULT_SETTINGS.lente, searchMethod: "keyword", maxResults: 35 },
    });

    expect((plugin as any).session).toBe(oldSession);
    expect((plugin as any).index).toBe(oldIndex);
    expect((plugin as any).lenteSearch).not.toBe(oldLente);
    await (plugin as any).lenteSearch.search("needle", { sort: "updated" });
    expect(search).toHaveBeenLastCalledWith(
      "needle",
      expect.objectContaining({ searchMethod: "keyword", maxResults: 35, sort: "updated" })
    );
  });

  it("treats exclusion changes as a new corpus and requires indexing without searching or embedding", async () => {
    const app = projectedApp();
    const lenteView = { setSearch: vi.fn(), refreshSubmitted: vi.fn() };
    (app.workspace as any).getLeavesOfType = (type: string) =>
      type === "trama-lente" ? [{ view: lenteView }] : [];
    const plugin = projectedPlugin(app);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await plugin.onload();
    await (plugin as any).indexLoad;
    const oldIndex = (plugin as any).index;
    const embed = vi.spyOn((oldIndex as any).embedding, "embed");

    await plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, excludedPaths: ["Note.md"] },
    });
    await (plugin as any).indexLoad;

    const newIndex = (plugin as any).index;
    expect(newIndex).not.toBe(oldIndex);
    expect(newIndex.fingerprint().excludedPaths).toEqual(["Note.md"]);
    await expect(oldIndex.search("old", new AbortController().signal, 1)).rejects.toMatchObject({
      code: "unavailable",
    });
    // The old corpus may contain newly excluded content, so it is not a
    // usable last-good index; an explicit Update/Rebuild is required.
    expect((plugin as any).indexStatus.getStatus().kind).toBe("index-required");
    expect(lenteView.refreshSubmitted).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect((plugin as any).isVisibleMarkdown("Note.md")).toBe(true);
    expect((newIndex as any).isIndexEligible("Note.md")).toBe(false);
    const read = await (plugin as any).session.registry
      .get("read_note")
      .execute({ path: "Note.md" }, new AbortController().signal);
    expect(read.ok).toBe(true);
  });

  it("mobile activation registers shared runtime surfaces and makes no fetch", async () => {
    Platform.isDesktopApp = false;
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await plugin.onload();

    expect(plugin.isDesktopLoaded()).toBe(true);
    expect(plugin.addCommand).toHaveBeenCalledTimes(12);
    expect(plugin.registerView).toHaveBeenCalledTimes(3);
    expect(plugin.registerEvent).toHaveBeenCalledTimes(5);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rebuilds lexical before semantic through the combined command", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app) as any;
    await plugin.onload();
    await plugin.indexLoad;
    const order: string[] = [];
    vi.spyOn(plugin.index, "build").mockImplementation(async () => {
      order.push("lexical");
    });
    vi.spyOn(plugin.index, "isComplete").mockReturnValue(true);
    vi.spyOn(plugin.index, "rebuildSemantic").mockImplementation(async () => {
      order.push("semantic");
      return { operation: "rebuild", changed: true, converged: true, state: {} } as any;
    });
    const command = plugin.addCommand.mock.calls.find(
      ([item]: [{ id: string }]) => item.id === "rebuild-both-indexes"
    )[0].callback;

    command();
    await vi.waitFor(() => expect(order).toEqual(["lexical", "semantic"]));
    await vi.waitFor(() => expect(plugin.getIndexStatus()?.kind).toBe("ready"));
  });

  it("saves each open Markdown path before forcing lexical then semantic updates", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app) as any;
    const saving = deferred<void>();
    const order: string[] = [];
    const duplicate = {
      file: { path: "Note.md" },
      save: vi.fn(async () => {
        order.push("save-note-start");
        await saving.promise;
        order.push("save-note-done");
      }),
    };
    const other = {
      file: { path: "Other.md" },
      save: vi.fn(async () => {
        order.push("save-other");
      }),
    };
    (app.workspace as any).getLeavesOfType = (type: string) =>
      type === "markdown" ? [{ view: duplicate }, { view: duplicate }, { view: other }] : [];
    await plugin.onload();
    await plugin.indexLoad;
    const index = plugin.index;
    vi.spyOn(index, "synchronize").mockImplementation(async () => {
      order.push("lexical");
      return { changed: true, converged: true };
    });
    vi.spyOn(index, "isComplete").mockReturnValue(true);
    vi.spyOn(index, "prepareSemantic").mockImplementation(async () => {
      order.push("semantic");
      return {
        operation: "prepare",
        changed: true,
        converged: true,
        state: { incomplete: false },
        stored: 1,
        skipped: 0,
      } as any;
    });

    const update = plugin.runForceUpdate(new AbortController().signal);
    await vi.waitFor(() => expect(order).toContain("save-note-start"));
    expect(order).toEqual(["save-note-start"]);
    saving.resolve();
    await update;

    expect(order).toEqual([
      "save-note-start",
      "save-note-done",
      "save-other",
      "lexical",
      "semantic",
    ]);
    expect(duplicate.save).toHaveBeenCalledOnce();
    expect(other.save).toHaveBeenCalledOnce();
    plugin.onunload();
  });

  it("forces lexical synchronization with no open views and does not require semantic automation", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: {
        ...DEFAULT_SETTINGS.filo,
        automaticLexicalDelayMs: 750,
        automaticSemanticDelayMs: 0,
      },
    }) as any;
    await plugin.onload();
    await plugin.indexLoad;
    const index = plugin.index;
    const synchronize = vi.spyOn(index, "synchronize").mockResolvedValue({
      changed: false,
      converged: true,
    });
    vi.spyOn(index, "isComplete").mockReturnValue(true);
    const prepare = vi.spyOn(index, "prepareSemantic").mockResolvedValue({
      operation: "prepare",
      changed: false,
      converged: true,
      state: { incomplete: false },
      stored: 0,
      skipped: 0,
    } as any);

    await plugin.runForceUpdate(new AbortController().signal);

    expect(app.workspace.getLeavesOfType("markdown")).toHaveLength(0);
    expect(synchronize).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    plugin.onunload();
  });

  it("keeps queued edits stale when they arrive during forced semantic preparation", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 0 },
    }) as any;
    await plugin.onload();
    await plugin.indexLoad;
    const index = plugin.index;
    vi.spyOn(index, "synchronize").mockResolvedValue({ changed: true, converged: true });
    vi.spyOn(index, "isComplete").mockReturnValue(true);
    const semantic = deferred<any>();
    vi.spyOn(index, "prepareSemantic").mockReturnValue(semantic.promise);
    const update = plugin.runForceUpdate(new AbortController().signal);
    await vi.waitFor(() => expect(index.prepareSemantic).toHaveBeenCalled());
    plugin.queueVaultMutation({ type: "upsert", path: "Note.md" });
    semantic.resolve({
      operation: "prepare",
      changed: true,
      converged: true,
      state: { incomplete: false },
      stored: 1,
      skipped: 0,
    });
    await update;

    expect(plugin.queuedWork).toBe(true);
    expect(plugin.getIndexStatus()).toMatchObject({ kind: "stale" });
    plugin.onunload();
  });

  it("reconciles edits that arrive during forced lexical synchronization before semantic work", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app) as any;
    await plugin.onload();
    await plugin.indexLoad;
    const index = plugin.index;
    let syncCount = 0;
    const synchronize = vi.spyOn(index, "synchronize").mockImplementation(async () => {
      syncCount++;
      if (syncCount === 1) plugin.queueVaultMutation({ type: "upsert", path: "Note.md" });
      return { changed: true, converged: true };
    });
    vi.spyOn(index, "isComplete").mockReturnValue(true);
    vi.spyOn(index, "hasPendingWork").mockReturnValue(false);
    const reconcile = vi
      .spyOn(index, "reconcileChanges")
      .mockResolvedValue({ changed: true, converged: true });
    const prepare = vi.spyOn(index, "prepareSemantic").mockResolvedValue({
      operation: "prepare",
      changed: true,
      converged: true,
      state: { incomplete: false },
      stored: 1,
      skipped: 0,
    } as any);

    await plugin.runForceUpdate(new AbortController().signal);

    expect(synchronize).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(plugin.queuedWork).toBe(false);
    plugin.onunload();
  });

  it("does not start forced semantic preparation after lexical failure or nonconvergence", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app) as any;
    await plugin.onload();
    await plugin.indexLoad;
    const index = plugin.index;
    const prepare = vi.spyOn(index, "prepareSemantic");
    vi.spyOn(index, "synchronize").mockRejectedValueOnce(new Error("lexical failure"));
    await expect(plugin.runForceUpdate(new AbortController().signal)).rejects.toThrow(
      "lexical failure"
    );
    expect(prepare).not.toHaveBeenCalled();

    vi.mocked(index.synchronize).mockResolvedValueOnce({ changed: true, converged: false });
    vi.spyOn(index, "isComplete").mockReturnValue(false);
    await expect(plugin.runForceUpdate(new AbortController().signal)).rejects.toThrow(
      "Lexical index did not converge"
    );
    expect(prepare).not.toHaveBeenCalled();
    plugin.onunload();
  });

  it("force update bypasses a scheduled lexical timer and leaves publication delayed", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: {
        ...DEFAULT_SETTINGS.filo,
        automaticLexicalDelayMs: 750,
        automaticPublicationDelayMs: 30_000,
      },
    }) as any;
    await plugin.onload();
    await plugin.indexLoad;
    const index = plugin.index;
    plugin.indexReady = true;
    plugin.queueVaultMutation({ type: "upsert", path: "Note.md" });
    expect(plugin.eventTimer).toBeDefined();
    const synchronize = vi.spyOn(index, "synchronize").mockResolvedValue({
      changed: true,
      converged: true,
    });
    vi.spyOn(index, "isComplete").mockReturnValue(true);
    vi.spyOn(index, "prepareSemantic").mockImplementation(async () => {
      (index as any).options.onSuccessfulOperation({
        operation: "prepare",
        changed: true,
        converged: true,
        state: { incomplete: false, changeCounter: 1 },
      });
      return {
        operation: "prepare",
        changed: true,
        converged: true,
        state: { incomplete: false },
        stored: 1,
        skipped: 0,
      } as any;
    });
    const publish = vi
      .spyOn(plugin.publicationManager, "publish")
      .mockResolvedValue({ published: true, publicationId: "local" } as any);

    await plugin.runForceUpdate(new AbortController().signal);

    expect(plugin.eventTimer).toBeUndefined();
    expect(synchronize).toHaveBeenCalledOnce();
    expect(plugin.automaticPublicationTimer).toBeDefined();
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(publish).toHaveBeenCalledOnce();
    plugin.onunload();
    vi.useRealTimers();
  });

  it("flushes only converged pending publication on desktop quit and reuses an active publish", async () => {
    const plugin = projectedPlugin(projectedApp(), {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticPublicationDelayMs: 30_000 },
    }) as any;
    const manager = {
      isComplete: vi.fn(() => true),
      isBuilding: vi.fn(() => false),
      isInMaintenance: vi.fn(() => false),
      disposeImmediately: vi.fn(),
    };
    const publication = { isBusy: false, publish: vi.fn(async () => ({ published: true })) };
    plugin.index = manager;
    plugin.publicationManager = publication;
    plugin.indexReady = true;
    plugin.pendingAutomaticPublication = { eventRevision: 0 };
    const flush = plugin.publishOnQuit();
    expect(flush).toBeDefined();
    await flush;
    expect(publication.publish).toHaveBeenCalledOnce();
    expect(plugin.pendingAutomaticPublication).toBeUndefined();
    expect(manager.isComplete).toHaveBeenCalledOnce();

    plugin.pendingAutomaticPublication = { eventRevision: 0 };
    const reused = Promise.resolve({ published: true });
    plugin.activePublicationPromise = reused;
    await plugin.publishOnQuit();
    expect(publication.publish).toHaveBeenCalledOnce();
  });

  it("leaves quit publication pending when disabled, absent, or lexical state is unsafe", () => {
    const plugin = projectedPlugin(projectedApp()) as any;
    const manager = {
      isComplete: vi.fn(() => true),
      isBuilding: vi.fn(() => false),
      isInMaintenance: vi.fn(() => false),
      disposeImmediately: vi.fn(),
    };
    plugin.index = manager;
    plugin.publicationManager = { publish: vi.fn() };
    plugin.indexReady = true;
    expect(plugin.publishOnQuit()).toBeUndefined();
    plugin.settingsStore.commit({
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticPublicationDelayMs: 0 },
    });
    plugin.pendingAutomaticPublication = { eventRevision: 0 };
    expect(plugin.publishOnQuit()).toBeUndefined();
    const enabled = plugin.settingsStore.stage({
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticPublicationDelayMs: 0 },
    });
    plugin.settingsStore.commit(enabled);
    expect(plugin.publishOnQuit()).toBeUndefined();
    plugin.settingsStore.commit({
      ...enabled,
      filo: { ...enabled.filo, automaticPublicationDelayMs: 30_000 },
    });
    plugin.queuedWork = true;
    expect(plugin.publishOnQuit()).toBeUndefined();
    plugin.queuedWork = false;
    manager.isComplete.mockReturnValue(false);
    expect(plugin.publishOnQuit()).toBeUndefined();
    expect(plugin.pendingAutomaticPublication).toBeDefined();
  });

  it("keeps an accepted desktop quit task's Worker alive through unload", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticPublicationDelayMs: 30_000 },
    }) as any;
    await plugin.onload();
    await plugin.indexLoad;
    const index = plugin.index;
    plugin.indexReady = true;
    vi.spyOn(index, "isComplete").mockReturnValue(true);
    const dispose = vi.spyOn(index, "disposeImmediately");
    plugin.pendingAutomaticPublication = {
      eventRevision: plugin.vaultEventRevision,
    };
    const completion = deferred<void>();
    vi.spyOn(plugin.publicationManager, "publish").mockReturnValue(
      completion.promise.then(() => ({
        published: false,
        warning: { message: "offline", retryable: false },
      })) as any
    );
    const tasks = { addPromise: vi.fn() };
    app.listeners.find((listener) => listener.event === "quit")!.callback(tasks);
    expect(tasks.addPromise).toHaveBeenCalledOnce();
    const accepted = tasks.addPromise.mock.calls[0][0] as Promise<void>;
    plugin.onunload();
    expect(dispose).not.toHaveBeenCalled();
    completion.resolve();
    await accepted;
    await Promise.resolve();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });

  it("preserves the publication warning when the quit flush fails", async () => {
    const plugin = projectedPlugin(projectedApp(), {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticPublicationDelayMs: 30_000 },
    }) as any;
    const manager = {
      isComplete: () => true,
      isBuilding: () => false,
      isInMaintenance: () => false,
    };
    const warning = { message: "offline", retryable: false };
    const status = { setPublicationWarning: vi.fn(), setSchedulerMessage: vi.fn() };
    plugin.index = manager;
    plugin.indexReady = true;
    plugin.indexStatus = status;
    plugin.publicationManager = { publish: vi.fn(async () => ({ published: false, warning })) };
    plugin.pendingAutomaticPublication = { eventRevision: 0 };

    await plugin.publishOnQuit();

    expect(status.setPublicationWarning).toHaveBeenCalledWith(
      "Index saved locally, but publication failed: offline"
    );
    expect(plugin.index.synchronize).toBeUndefined();
    expect(plugin.index.prepareSemantic).toBeUndefined();
  });

  it("does not register desktop quit behavior on mobile", async () => {
    Platform.isDesktopApp = false;
    const app = projectedApp();
    const plugin = projectedPlugin(app) as any;
    await plugin.onload();
    expect(app.listeners.some((listener) => listener.event === "quit")).toBe(false);
    plugin.onunload();
  });

  it("replaces chat and embedding composition on saved settings and invalidates the old index", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
            'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
      );
    await plugin.onload();
    expect(fetcher).not.toHaveBeenCalled();
    const oldSession = (plugin as any).session;
    const oldIndex = (plugin as any).index;
    await plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      chat: { ...DEFAULT_SETTINGS.chat, endpoint: "HTTP://127.0.0.1:2345/v1/", modelId: "chat-v2" },
      embedding: {
        ...DEFAULT_SETTINGS.embedding,
        endpoint: "http://127.0.0.1:2345/v1",
        modelId: "embed-v2",
      },
    });
    const state = await (plugin as any).session.send({ content: "hello", attachmentPaths: [] });

    expect(oldSession.getState().error?.code).not.toBe("internal");
    expect((plugin as any).session).not.toBe(oldSession);
    expect(state.turns.at(-1)?.content).toBe("ok");
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:2345/v1/responses",
      expect.objectContaining({ body: expect.stringContaining('"model":"chat-v2"') })
    );
    await expect(oldIndex.search("old", new AbortController().signal, 1)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect((plugin as any).index.fingerprint().embeddingBaseUrl).toBe("http://127.0.0.1:2345/v1");
    expect((plugin as any).index.fingerprint().modelId).toBe("embed-v2");
  });

  it("rebinds open Voce views to the replacement related-notes service", async () => {
    const app = projectedApp();
    const voceView = { setSession: vi.fn(), setRelatedNotes: vi.fn() };
    (app.workspace as any).getLeavesOfType = (type: string) =>
      type === "trama-voce" ? ([{ view: voceView }] as any) : [];
    const plugin = projectedPlugin(app);
    await plugin.onload();
    const firstRelated = (plugin as any).relatedNotes;

    await plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-v2" },
    });

    const secondRelated = (plugin as any).relatedNotes;
    expect(secondRelated).not.toBe(firstRelated);
    expect(voceView.setRelatedNotes).toHaveBeenLastCalledWith(secondRelated);
  });

  it("keeps the same index manager and writer during a chat-only save while rebuilding", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
    const index = (plugin as any).index;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const read = app.vault.read;
    app.vault.read = vi.fn(async (file: { path: string }) => {
      await gate;
      return read(file);
    });
    const writes = vi.spyOn(app.vault.adapter, "write");
    const rebuild = index.build(new AbortController().signal);
    await vi.waitFor(() => expect(app.vault.read).toHaveBeenCalled());

    await plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      chat: { ...DEFAULT_SETTINGS.chat, modelId: "chat-v2" },
    });
    expect((plugin as any).index).toBe(index);
    release();
    await rebuild;

    expect(writes).not.toHaveBeenCalled();
    expect(await index.search("contents", new AbortController().signal, 1)).toHaveLength(1);
  });

  it("applies parameter-only chat saves to the next request without replacing the conversation", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
            'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
      );
    await plugin.onload();
    const session = (plugin as any).session;
    await plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      chat: {
        ...DEFAULT_SETTINGS.chat,
        modelId: "parameterized",
        temperature: 0.4,
        maxOutputTokens: 2048,
        reasoningEffort: "high",
      },
    });

    const state = await session.send({ content: "hello", attachmentPaths: [] });
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect((plugin as any).session).toBe(session);
    expect(state.turns.map((message: { content: string }) => message.content)).toEqual([
      "hello",
      "ok",
    ]);
    expect(body).toMatchObject({
      model: "parameterized",
      temperature: 0.4,
      max_output_tokens: 2048,
      reasoning: { effort: "high" },
    });
  });

  it("cancels and awaits the old rebuild before replacing embedding composition", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
    const oldIndex = (plugin as any).index;
    const dispose = vi.spyOn(oldIndex, "dispose");
    let oldStarted!: () => void;
    const started = new Promise<void>((resolve) => (oldStarted = resolve));
    const read = app.vault.read;
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    app.vault.read = vi.fn(async (file: { path: string }) => {
      oldStarted();
      await readGate;
      return read(file);
    });
    const oldRebuild = oldIndex.build((plugin as any).lifecycleAbort.signal);
    await started;

    const save = plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      embedding: {
        ...DEFAULT_SETTINGS.embedding,
        endpoint: "http://127.0.0.1:2345/v1",
        modelId: "embed-v2",
      },
    });
    releaseRead();
    await save;
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(oldRebuild).rejects.toMatchObject({ code: "cancelled" });
    const newIndex = (plugin as any).index;
    expect(newIndex).not.toBe(oldIndex);
    expect(newIndex.fingerprint().modelId).toBe("embed-v2");
    await expect(oldIndex.search("late", new AbortController().signal, 1)).rejects.toMatchObject({
      code: "unavailable",
    });

    await newIndex.build(new AbortController().signal);
    expect(newIndex.isComplete()).toBe(true);
  });

  it("keeps the committed runtime untouched when settings persistence rejects", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    const oldSession = (plugin as any).session;
    const oldIndex = (plugin as any).index;
    (plugin as any).saveData.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      plugin.saveSettings({
        ...DEFAULT_SETTINGS,
        chat: { ...DEFAULT_SETTINGS.chat, modelId: "new-chat" },
      })
    ).rejects.toThrow("disk full");

    expect(plugin.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect((plugin as any).session).toBe(oldSession);
    expect((plugin as any).index).toBe(oldIndex);
    expect(oldSession.getState().error).toBeUndefined();
  });

  it("gates detailed diagnostics at emission time without replacing composition", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    const debugSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await plugin.onload();
    const session = (plugin as any).session;
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
    expect((plugin as any).session).toBe(session);
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
      (plugin as any).session.registry.definitions.map((tool: { name: string }) => tool.name)
    ).toEqual(["read_note", "discover_links", "follow_link", "vault_search"]);
    const searchDefinition = (plugin as any).session.registry.definitions.find(
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

  it("marks a fresh index ready after explicit rebuild and reconciles a later modification", async () => {
    const app = projectedApp();
    const voceView = { refreshRelatedSuggestions: vi.fn() };
    (app.workspace as any).getLeavesOfType = (type: string) =>
      type === "trama-voce" ? [{ view: voceView }] : [];
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 750 },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await optInToAutomaticUpdates(plugin);
    const index = (plugin as any).index;
    vi.spyOn(index, "build").mockResolvedValue(undefined);
    const rebuild = (plugin as any).addCommand.mock.calls.find(
      ([command]: [{ id: string }]) => command.id === "reindex-filo-vault"
    )[0].callback;
    rebuild();
    await vi.waitFor(() => expect((plugin as any).indexReady).toBe(true));
    await vi.waitFor(() => expect(voceView.refreshRelatedSuggestions).toHaveBeenCalledTimes(1));
    vi.spyOn(index, "isComplete").mockReturnValue(true);
    const reconcile = vi
      .spyOn(index, "reconcileChanges")
      .mockResolvedValue({ changed: true, converged: true });
    const emit = (event: string, ...args: any[]) => {
      for (const ref of app.listeners.filter((item) => item.active && item.event === event))
        ref.callback(...args);
    };
    emit("modify", { path: "Note.md" });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(reconcile).toHaveBeenCalled();
    expect(voceView.refreshRelatedSuggestions).toHaveBeenCalledTimes(3);
  });

  it("keeps a failed or cancelled explicit rebuild non-ready", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
    vi.spyOn((plugin as any).index, "build").mockRejectedValue(new Error("cancelled"));
    const rebuild = (plugin as any).addCommand.mock.calls.find(
      ([command]: [{ id: string }]) => command.id === "index-filo-vault"
    )[0].callback;
    await rebuild();
    // Mutable indexing keeps the existing searchable state available after a
    // failed rebuild; it is marked incomplete/stale for a later retry.
    expect((plugin as any).indexReady).toBe(true);
  });

  it("builds v1 then hands late v2 edits to the same manager for reconciliation", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
    await optInToAutomaticUpdates(plugin);
    const index = (plugin as any).index;
    let release!: () => void;
    let building = true;
    const buildGate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(index, "build").mockImplementation(async () => buildGate);
    vi.spyOn(index, "isBuilding").mockImplementation(() => building);
    const synchronize = vi
      .spyOn(index, "synchronize")
      .mockResolvedValue({ changed: true, converged: true });
    const rebuild = (plugin as any).addCommand.mock.calls.find(
      ([command]: [{ id: string }]) => command.id === "reindex-filo-vault"
    )[0].callback;
    rebuild();
    await vi.waitFor(() => expect((index as any).build).toHaveBeenCalled());
    for (const ref of app.listeners.filter((item) => item.active && item.event === "modify"))
      ref.callback({ path: "Note.md" });
    expect((plugin as any).indexStatus.getStatus()).toMatchObject({
      kind: "building",
      canCancel: true,
    });
    building = false;
    release();
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledWith(expect.any(AbortSignal)));
    expect((plugin as any).index).toBe(index);
    expect((plugin as any).indexReady).toBe(true);
  });

  it("keeps v1 unavailable after late v2 failure and recovers on manual rebuild", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
    await optInToAutomaticUpdates(plugin);
    const index = (plugin as any).index;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(index, "build")
      .mockImplementationOnce(async () => gate)
      .mockResolvedValue(undefined);
    const synchronize = vi
      .spyOn(index, "synchronize")
      .mockRejectedValueOnce(new Error("v2 embedding failed"))
      .mockResolvedValue({ changed: false, converged: true });
    const rebuild = (plugin as any).addCommand.mock.calls.find(
      ([command]: [{ id: string }]) => command.id === "reindex-filo-vault"
    )[0].callback;
    rebuild();
    await vi.waitFor(() => expect((index as any).build).toHaveBeenCalled());
    for (const ref of app.listeners.filter((item) => item.active && item.event === "modify"))
      ref.callback({ path: "Note.md" });
    release();
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1));
    expect((plugin as any).indexReady).toBe(true);
    expect((plugin as any).indexStatus.getStatus()).toMatchObject({
      kind: "stale",
      hasLastGood: true,
    });
    rebuild();
    await vi.waitFor(() => expect((plugin as any).indexReady).toBe(true));
    expect((index as any).build).toHaveBeenCalledTimes(2);
    expect(synchronize).toHaveBeenCalledTimes(1);
  });

  it("ignores an old successful load after a replacement index loads unavailable", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app) as any;
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    vi.spyOn((await import("@/index/IndexManager")).IndexManager.prototype, "load")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    plugin.lifecycleAbort = new AbortController();
    plugin.composeRuntime(app, DEFAULT_SETTINGS);
    plugin.composeRuntime(app, DEFAULT_SETTINGS);
    second.resolve(false);
    first.resolve(true);
    await Promise.all([first.promise, second.promise]);
    await Promise.resolve();
    expect(plugin.indexReady).toBe(false);
  });

  it("does not infer readiness from a mocked load without index capabilities", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app) as any;
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    vi.spyOn((await import("@/index/IndexManager")).IndexManager.prototype, "load")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    plugin.lifecycleAbort = new AbortController();
    plugin.composeRuntime(app, DEFAULT_SETTINGS);
    plugin.composeRuntime(app, DEFAULT_SETTINGS);
    first.resolve(false);
    second.resolve(true);
    await Promise.all([first.promise, second.promise]);
    await Promise.resolve();
    expect(plugin.indexReady).toBe(false);
  });

  it("debounces visible Markdown changes, ignores excluded files, and unloads idempotently", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
    await optInToAutomaticUpdates(plugin);
    const index = (plugin as any).index;
    const queue = vi.spyOn(index, "recordPathMutation");
    const emit = (event: string, ...args: any[]) => {
      for (const ref of app.listeners.filter((item) => item.active && item.event === event))
        ref.callback(...args);
    };

    emit("create", { path: "Note.md" });
    emit("modify", { path: "image.png" });
    emit("modify", { path: ".trama/index.md" });
    emit("rename", { path: "Renamed.md" }, "Old.md");
    expect(queue).toHaveBeenCalledTimes(2);
    expect((plugin as any).eventTimer).toBeDefined();
    await vi.advanceTimersByTimeAsync(750);
    plugin.onunload();
    plugin.onunload();
    expect(app.listeners.every((ref) => !ref.active)).toBe(true);
    vi.useRealTimers();
  });

  it("rearms scoped work after quiet time and schedules another pass for events during a run", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 750 },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await vi.waitFor(() => expect((plugin as any).indexReady).toBe(true));
    const index = (plugin as any).index;
    const status = (plugin as any).indexStatus;
    await index.build(new AbortController().signal);
    const pending = deferred<{ changed: boolean; converged: boolean }>();
    const reconcile = vi
      .spyOn(index, "reconcileChanges")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ changed: true, converged: true });
    const modify = app.listeners.find((ref) => ref.event === "modify");

    modify?.callback({ path: "Note.md" });
    await vi.advanceTimersByTimeAsync(500);
    modify?.callback({ path: "Note.md" });
    await vi.advanceTimersByTimeAsync(749);
    expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    modify?.callback({ path: "Other.md" });
    pending.resolve({ changed: true, converged: true });
    await (plugin as any).reconcilePromise;
    expect(status.getStatus().kind).toBe("stale");
    await vi.advanceTimersByTimeAsync(750);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(vi.spyOn(index, "synchronize")).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(status.getStatus().kind).toBe("ready"));
    plugin.onunload();
    vi.useRealTimers();
  });

  it("rearms pending lexical work when the configured delay changes", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 750 },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await vi.waitFor(() => expect((plugin as any).indexReady).toBe(true));
    const index = (plugin as any).index;
    await index.build(new AbortController().signal);
    const reconcile = vi
      .spyOn(index, "reconcileChanges")
      .mockResolvedValue({ changed: true, converged: true });
    app.listeners.find((ref) => ref.event === "modify")?.callback({ path: "Note.md" });
    await vi.advanceTimersByTimeAsync(500);
    await plugin.saveSettings((current) => ({
      ...current,
      filo: { ...current.filo, automaticLexicalDelayMs: 1_000 },
    }));
    await vi.advanceTimersByTimeAsync(999);
    expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    plugin.onunload();
    vi.useRealTimers();
  });

  it("caps lexical retries at 5, 15, and 60 seconds, then resets on a new event", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 750 },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await vi.waitFor(() => expect((plugin as any).indexReady).toBe(true));
    const index = (plugin as any).index;
    await index.build(new AbortController().signal);
    const reconcile = vi.spyOn(index, "reconcileChanges").mockRejectedValue({ retryable: true });
    const synchronize = vi.spyOn(index, "synchronize").mockRejectedValue({ retryable: true });
    app.listeners.find((ref) => ref.event === "modify")?.callback({ path: "Note.md" });
    await vi.advanceTimersByTimeAsync(750);
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(reconcile).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(4);
    expect((plugin as any).automaticRetryAttempt).toBe(3);
    expect((plugin as any).automaticRetryPaused).toBe(true);
    expect((plugin as any).retryTimer).toBeUndefined();
    await vi.waitFor(() =>
      expect((plugin as any).indexStatus.getStatus().schedulerMessage).toContain("lexical failed")
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reconcile).toHaveBeenCalledTimes(4);

    app.listeners.find((ref) => ref.event === "modify")?.callback({ path: "Other.md" });
    expect((plugin as any).automaticRetryAttempt).toBe(0);
    expect((plugin as any).automaticRetryPaused).toBe(false);
    await vi.advanceTimersByTimeAsync(750);
    expect(reconcile).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(reconcile).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(6);
    expect(synchronize).not.toHaveBeenCalled();
    plugin.onunload();
    vi.useRealTimers();
  });

  it("coalesces opted-in edits, does not retry a failed background pass, and retries on a later event", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 750 },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await optInToAutomaticUpdates(plugin);
    const index = (plugin as any).index;
    await index.build(new AbortController().signal);
    const reconcile = vi
      .spyOn(index, "reconcileChanges")
      .mockRejectedValueOnce(new Error("embedding failed"))
      .mockResolvedValue({ changed: false, converged: false });
    const synchronize = vi
      .spyOn(index, "synchronize")
      .mockResolvedValue({ changed: true, converged: true });
    const modify = app.listeners.find((ref) => ref.event === "modify");

    modify?.callback({ path: "Note.md" });
    modify?.callback({ path: "Note.md" });
    await vi.advanceTimersByTimeAsync(750);
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reconcile).toHaveBeenCalledTimes(1);

    modify?.callback({ path: "Other.md" });
    await vi.advanceTimersByTimeAsync(750);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(synchronize).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("opt-out clears the debounce, aborts automatic work, and preserves queued stale work", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 750 },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await optInToAutomaticUpdates(plugin);
    const index = (plugin as any).index;
    await index.build(new AbortController().signal);
    const pending = deferred<{ changed: boolean; converged: boolean }>();
    const reconcile = vi.spyOn(index, "reconcileChanges").mockReturnValue(pending.promise);
    const modify = app.listeners.find((ref) => ref.event === "modify");
    modify?.callback({ path: "Note.md" });
    await vi.advanceTimersByTimeAsync(750);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    const signal = reconcile.mock.calls[0][1] as AbortSignal;

    await plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 0 },
    });
    expect(signal.aborted).toBe(true);
    expect((plugin as any).eventTimer).toBeUndefined();
    expect((plugin as any).queuedWork).toBe(true);
    expect((plugin as any).indexStatus.getStatus().kind).toBe("stale");
    pending.resolve({ changed: false, converged: false });
    await Promise.resolve();
    vi.useRealTimers();
  });

  it("resumes queued automatic work after a slow cancelled pass and rapid re-opt-in", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 750 },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await optInToAutomaticUpdates(plugin);
    const index = (plugin as any).index;
    await index.build(new AbortController().signal);
    const reconcile = vi
      .spyOn(index, "reconcileChanges")
      .mockImplementationOnce(
        (_changes, signal) =>
          new Promise<void>((_resolve, reject) =>
            (signal as AbortSignal).addEventListener(
              "abort",
              () => setTimeout(() => reject(new Error("cancelled")), 100),
              { once: true }
            )
          )
      )
      .mockResolvedValue({ changed: true, converged: true });
    const modify = app.listeners.find((ref) => ref.event === "modify");
    modify?.callback({ path: "Note.md" });
    await vi.advanceTimersByTimeAsync(750);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));

    await plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 0 },
    });
    const optIn = plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 750 },
    });
    await optIn;
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(750);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    expect(vi.spyOn(index, "synchronize")).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("exposes monotonic status/actions and coalesces typed edits after first indexing", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 750 },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await optInToAutomaticUpdates(plugin);
    const index = (plugin as any).index;
    vi.spyOn(index, "build").mockResolvedValue(undefined);
    const statuses: string[] = [];
    const status = (plugin as any).indexStatus;
    status.subscribe((value: { kind: string; revision: number }) =>
      statuses.push(`${value.kind}:${value.revision}`)
    );
    const indexCommand = (plugin as any).addCommand.mock.calls.find(
      ([command]: [{ id: string }]) => command.id === "index-filo-vault"
    )[0];
    expect(indexCommand.checkCallback(true)).toBe(true);
    indexCommand.callback();
    await vi.waitFor(() => expect((plugin as any).indexReady).toBe(true));
    await vi.waitFor(() => expect(status.getStatus().kind).toBe("ready"));
    vi.spyOn(index, "isComplete").mockReturnValue(true);
    const reconcile = vi
      .spyOn(index, "reconcileChanges")
      .mockResolvedValue({ changed: false, converged: true });
    const emit = (event: string, ...args: any[]) => {
      for (const ref of app.listeners.filter((item) => item.active && item.event === event))
        ref.callback(...args);
    };
    emit("modify", { path: "Note.md" });
    emit("modify", { path: "Note.md" });
    expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(749);
    expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(status.getStatus().kind).toBe("ready"));
    expect((plugin as any).queuedWork).toBe(false);
    expect(statuses.map((entry) => Number(entry.split(":")[1]))).toEqual(
      statuses.map((entry) => Number(entry.split(":")[1])).sort((a, b) => a - b)
    );
    plugin.onunload();
    vi.useRealTimers();
  });

  it("delivers rename as one dirty watermark", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
    const index = (plugin as any).index;
    vi.spyOn(index, "build").mockResolvedValue(undefined);
    const command = (plugin as any).addCommand.mock.calls.find(
      ([item]: [{ id: string }]) => item.id === "index-filo-vault"
    )[0];
    command.callback();
    await vi.waitFor(() => expect((plugin as any).indexReady).toBe(true));
    const queue = vi.spyOn(index, "recordPathMutation");
    const ref = app.listeners.find((item) => item.event === "rename");
    ref?.callback({ path: "Renamed.md" }, "Old.md");
    expect(queue).toHaveBeenCalledTimes(1);
    plugin.onunload();
  });

  it("maps renames across the visibility boundary to delete or create", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
    const index = (plugin as any).index;
    vi.spyOn(index, "build").mockResolvedValue(undefined);
    const command = (plugin as any).addCommand.mock.calls.find(
      ([item]: [{ id: string }]) => item.id === "index-filo-vault"
    )[0];
    command.callback();
    await vi.waitFor(() => expect((plugin as any).indexReady).toBe(true));
    const queue = vi.spyOn(index, "recordPathMutation");
    const ref = app.listeners.find((item) => item.event === "rename");

    ref?.callback({ path: ".hidden.md" }, "Visible.md");
    ref?.callback({ path: "Visible.md" }, ".hidden.md");

    expect(queue).toHaveBeenCalledTimes(2);
    plugin.onunload();
  });

  it("reconciles coalesced note paths and rename chains without retaining content", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 750 },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await vi.waitFor(() => expect((plugin as any).indexReady).toBe(true));
    const index = (plugin as any).index;
    await index.build(new AbortController().signal);
    const reconcile = vi
      .spyOn(index, "reconcileChanges")
      .mockResolvedValue({ changed: true, converged: true });
    const emit = (event: string, ...args: any[]) => {
      for (const ref of app.listeners.filter((item) => item.active && item.event === event))
        ref.callback(...args);
    };

    emit("create", { path: "Temp.md" });
    emit("modify", { path: "Temp.md" });
    emit("delete", { path: "Temp.md" });
    emit("rename", { path: "Renamed.md" }, "Note.md");
    emit("rename", { path: "Final.md" }, "Renamed.md");
    emit("rename", { path: "Middle.md" }, "Other.md");
    emit("modify", { path: "Middle.md" });
    emit("rename", { path: "Last.md" }, "Middle.md");
    emit("rename", { path: ".hidden.md" }, "Visible.md");
    emit("rename", { path: "Back.md" }, ".hidden.md");
    await vi.advanceTimersByTimeAsync(750);

    expect(reconcile).toHaveBeenCalledWith(
      [
        { type: "delete", path: "Temp.md" },
        { type: "rename", from: "Note.md", to: "Final.md" },
        { type: "rename", from: "Other.md", to: "Middle.md" },
        { type: "delete", path: "Middle.md" },
        { type: "upsert", path: "Last.md" },
        { type: "delete", path: "Visible.md" },
        { type: "upsert", path: "Back.md" },
      ],
      expect.any(AbortSignal)
    );
    plugin.onunload();
    vi.useRealTimers();
  });

  it("keeps an intervening renamed-note edit ordered and converges the final path content", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const files = app.vault.getMarkdownFiles() as Array<{ path: string }>;
    const file = { path: "A.md" };
    files.splice(0, files.length, file);
    const contents = new Map<string, string>([["A.md", "alpha original"]]);
    vi.spyOn(app.vault, "read").mockImplementation(
      async (current) => contents.get(current.path) ?? ""
    );
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 750 },
    }) as any;
    await plugin.onload();
    await plugin.indexLoad;
    await vi.waitFor(() => expect(plugin.indexReady).toBe(true));
    const index = plugin.index;
    await index.build(new AbortController().signal);
    const reconcile = vi.spyOn(index, "reconcileChanges");
    const synchronize = vi.spyOn(index, "synchronize");
    const emit = (event: string, ...args: any[]) => {
      for (const ref of app.listeners.filter((item) => item.active && item.event === event))
        ref.callback(...args);
    };

    file.path = "B.md";
    contents.set("B.md", contents.get("A.md")!);
    contents.delete("A.md");
    emit("rename", file, "A.md");
    contents.set("B.md", "beta modified while at B");
    emit("modify", file);
    file.path = "C.md";
    contents.set("C.md", contents.get("B.md")!);
    contents.delete("B.md");
    emit("rename", file, "B.md");

    await vi.advanceTimersByTimeAsync(750);
    expect(synchronize).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    await (plugin as any).reconcilePromise;
    await vi.waitFor(() => expect(index.isComplete()).toBe(true));

    expect(reconcile).toHaveBeenCalledWith(
      [
        { type: "rename", from: "A.md", to: "B.md" },
        { type: "delete", path: "B.md" },
        { type: "upsert", path: "C.md" },
      ],
      expect.any(AbortSignal)
    );
    expect(
      (await index.search("beta modified", new AbortController().signal, 5)).map(
        (hit: any) => hit.path
      )
    ).toEqual(["C.md"]);
    expect(
      (await index.search("alpha original", new AbortController().signal, 5)).map(
        (hit: any) => hit.path
      )
    ).toEqual([]);
    plugin.onunload();
    vi.useRealTimers();
  });

  it("retains dirty scoped work after scoped reconciliation fails or stays incomplete", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 750 },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await vi.waitFor(() => expect((plugin as any).indexReady).toBe(true));
    const index = (plugin as any).index;
    await index.build(new AbortController().signal);
    const reconcile = vi
      .spyOn(index, "reconcileChanges")
      .mockRejectedValueOnce(new Error("race"))
      .mockResolvedValueOnce({ changed: false, converged: false });
    app.listeners.find((ref) => ref.event === "modify")?.callback({ path: "Note.md" });
    await vi.advanceTimersByTimeAsync(750);
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(vi.spyOn(index, "synchronize")).not.toHaveBeenCalled();
    app.listeners.find((ref) => ref.event === "modify")?.callback({ path: "Other.md" });
    await vi.advanceTimersByTimeAsync(750);
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(vi.spyOn(index, "synchronize")).not.toHaveBeenCalled();
    plugin.onunload();
    vi.useRealTimers();
  });

  it("uses full recovery for folder events and leaves the publication target adoption-only", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 750 },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await vi.waitFor(() => expect((plugin as any).indexReady).toBe(true));
    const index = (plugin as any).index;
    await index.build(new AbortController().signal);
    const scoped = vi.spyOn(index, "reconcileChanges");
    const synchronize = vi
      .spyOn(index, "synchronize")
      .mockResolvedValue({ changed: false, converged: true });
    app.listeners
      .find((ref) => ref.event === "create")
      ?.callback({
        path: "Folder",
        children: [],
      });
    await vi.advanceTimersByTimeAsync(750);
    await Promise.resolve();
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(scoped).not.toHaveBeenCalled();

    app.listeners
      .find((ref) => ref.event === "modify")
      ?.callback({
        path: "Trama/index/index.sqlite3",
      });
    await vi.advanceTimersByTimeAsync(750);
    expect(synchronize).toHaveBeenCalledTimes(1);
    plugin.onunload();
    vi.useRealTimers();
  });

  it("runs one loaded-first full startup recovery after layout readiness when enabled", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 750 },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await vi.waitFor(() => expect((plugin as any).indexLoaded).toBe(true));
    expect((plugin as any).indexReady).toBe(true);
    expect((plugin as any).indexReady).toBe(true);
    const index = (plugin as any).index;
    const synchronize = vi.spyOn(index, "synchronize");
    expect(synchronize).not.toHaveBeenCalled();
    app.layoutCallbacks[0]?.();
    await vi.advanceTimersByTimeAsync(749);
    expect(synchronize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1));
    plugin.onunload();
    vi.useRealTimers();
  });

  it("does not scan on startup when lexical automation is Off", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 0 },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await vi.waitFor(() => expect((plugin as any).indexLoaded).toBe(true));
    const synchronize = vi.spyOn((plugin as any).index, "synchronize");
    app.layoutCallbacks[0]?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(synchronize).not.toHaveBeenCalled();
    plugin.onunload();
    vi.useRealTimers();
  });

  it("merges events during startup into its single full recovery and cancels pending work on unload", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 750 },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await vi.waitFor(() => expect((plugin as any).indexLoaded).toBe(true));
    const index = (plugin as any).index;
    const synchronize = vi.spyOn(index, "synchronize");
    const scoped = vi.spyOn(index, "reconcileChanges");
    app.layoutCallbacks[0]?.();
    app.listeners.find((ref) => ref.event === "modify")?.callback({ path: "Note.md" });
    await vi.advanceTimersByTimeAsync(750);
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1));
    expect(scoped).not.toHaveBeenCalled();
    app.listeners.find((ref) => ref.event === "modify")?.callback({ path: "Other.md" });
    plugin.onunload();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(synchronize).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("publishes incremental progress while the status is updating", () => {
    const status = new IndexStatusController({} as any, {
      index: async () => undefined,
      reindex: async () => undefined,
      cancel: () => undefined,
    });
    status.setReady();
    status.setUpdating();

    status.reportProgress({
      operation: "incremental",
      phase: "embed",
      completed: 2,
      total: 4,
      unit: "texts",
      determinate: true,
    });

    expect(status.getStatus()).toMatchObject({
      kind: "updating",
      message: "Embedding semantic index chunks — 2 of 4 texts",
      progress: { operation: "incremental", phase: "embed", completed: 2, total: 4 },
    });
  });

  it("routes semantic preparation through status progress and cancellation", async () => {
    let preparationSignal!: AbortSignal;
    const cancelled = vi.fn();
    const status = new IndexStatusController({} as any, {
      index: async () => undefined,
      reindex: async () => undefined,
      prepare: (signal) => {
        preparationSignal = signal;
        return new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          })
        );
      },
      cancel: cancelled,
    });
    status.setReady();
    const run = status.prepare();
    await vi.waitFor(() =>
      expect(status.getStatus()).toMatchObject({
        kind: "preparing",
        canPrepare: false,
        canCancel: true,
      })
    );
    status.reportProgress({
      operation: "incremental",
      phase: "build-vector",
      completed: 2,
      total: 4,
      unit: "chunks",
      determinate: true,
    });
    expect(status.getStatus()).toMatchObject({
      kind: "preparing",
      progress: { completed: 2, total: 4 },
    });
    status.cancel();
    await run;
    expect(preparationSignal.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(status.getStatus()).toMatchObject({ kind: "cancelled", canPrepare: true });
  });

  it("keeps the registered reindex command unavailable during incremental updating", async () => {
    const plugin = { addCommand: vi.fn() };
    const reindex = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          })
        )
    );
    const status = new IndexStatusController(plugin as any, {
      index: async () => undefined,
      reindex,
      cancel: () => undefined,
    });
    status.setReady();
    status.register();
    const command = plugin.addCommand.mock.calls
      .map(([item]) => item as { id: string; checkCallback: (checking: boolean) => boolean })
      .find((item) => item.id === "reindex-filo-vault")!;

    expect(command.checkCallback(true)).toBe(true);
    status.setUpdating();

    expect(command.checkCallback(true)).toBe(false);
    expect(command.checkCallback(false)).toBe(false);
    expect(reindex).not.toHaveBeenCalled();

    status.setReady();
    expect(command.checkCallback(true)).toBe(true);
    status.markError(new Error("failed"));
    expect(command.checkCallback(true)).toBe(true);

    status.setReady();
    const run = status.run("reindex");
    status.cancel();
    await run;
    expect(command.checkCallback(true)).toBe(true);
  });

  it("logs elapsed time for a completed user index action", async () => {
    let now = 1_000;
    const records: TramaDiagnosticRecord[] = [];
    const status = new IndexStatusController(
      {} as any,
      {
        index: async () => undefined,
        reindex: async () => {
          now = 3_500;
        },
        cancel: () => undefined,
      },
      { emit: (record) => records.push(record) },
      {
        now: () => now,
        setTimeout: (callback) => setTimeout(callback, 0),
        clearTimeout: (timer) => clearTimeout(timer),
      }
    );
    status.setReady();

    await status.run("reindex");

    expect(records).toContainEqual(
      expect.objectContaining({
        area: "index",
        event: "index_operation",
        operation: "full",
        stage: "user-completed",
        durationMs: 2_500,
      })
    );
  });

  it("estimates remaining embedding time from observed throughput", () => {
    let now = 0;
    const status = new IndexStatusController(
      {} as any,
      {
        index: async () => undefined,
        reindex: async () => undefined,
        cancel: () => undefined,
      },
      undefined,
      {
        now: () => now,
        setTimeout: (callback) => setTimeout(callback, 0),
        clearTimeout: (timer) => clearTimeout(timer),
      }
    );
    status.setReady();
    status.setUpdating();
    status.reportProgress({
      operation: "incremental",
      phase: "embed",
      completed: 0,
      total: 20,
      unit: "texts",
      determinate: true,
      estimated: true,
    });
    now = 2_000;
    status.reportProgress({
      operation: "incremental",
      phase: "embed",
      completed: 4,
      total: 20,
      unit: "texts",
      determinate: true,
      estimated: true,
    });

    expect(status.getStatus()).toMatchObject({
      etaSeconds: 8,
      message: "Embedding semantic index chunks — 4 of about 20 texts · about 8 sec remaining",
    });
  });

  it("keeps automatic semantic work Off by default and respects the quiet delay", async () => {
    vi.useFakeTimers();
    const off = automaticSemanticHarness(0);
    off.plugin.scheduleAutomaticSemantic();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(off.manager.prepareSemanticCacheBatch).not.toHaveBeenCalled();

    const delayed = automaticSemanticHarness(1_000);
    delayed.plugin.scheduleAutomaticSemantic();
    await vi.advanceTimersByTimeAsync(999);
    expect(delayed.manager.prepareSemanticCacheBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(delayed.manager.prepareSemanticCacheBatch).toHaveBeenCalledTimes(1);
    off.plugin.onunload();
    delayed.plugin.onunload();
    vi.useRealTimers();
  });

  it("does not schedule automatic enrichment without prior compatible coverage", async () => {
    vi.useFakeTimers();
    const { plugin, manager } = automaticSemanticHarness(1_000, false);
    plugin.scheduleAutomaticSemantic();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.prepareSemanticCacheBatch).not.toHaveBeenCalled();
    plugin.onunload();
    vi.useRealTimers();
  });

  it("bootstraps automatic semantic work from pending lexical heads", async () => {
    vi.useFakeTimers();
    const { plugin, manager } = automaticSemanticHarness(1_000, false);
    (manager as any).hasPendingSemanticWork = vi.fn(() => true);
    expect(plugin.hasAutomaticSemanticWork(manager)).toBe(true);
    plugin.automaticSemanticEligible = true;

    plugin.scheduleAutomaticSemantic("startup");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(manager.prepareSemanticCacheBatch).toHaveBeenCalledTimes(1);
    expect(plugin.automaticSemanticEligible).toBe(false);
    expect(plugin.automaticSemanticRetryTimer).toBeUndefined();
    plugin.onunload();
    vi.useRealTimers();
  });

  it("keeps fresh semantic work network silent when automatic semantic delay is Off", async () => {
    vi.useFakeTimers();
    const { plugin, manager } = automaticSemanticHarness(0, false);
    (manager as any).hasPendingSemanticWork = vi.fn(() => true);
    plugin.automaticSemanticEligible = plugin.hasAutomaticSemanticWork(manager);

    plugin.scheduleAutomaticSemantic("startup");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(manager.prepareSemanticCacheBatch).not.toHaveBeenCalled();
    plugin.onunload();
    vi.useRealTimers();
  });

  it("yields between semantic batches and stops when lexical work arrives", async () => {
    vi.useFakeTimers();
    const { plugin, manager } = automaticSemanticHarness(1_000);
    const batch = deferred<any>();
    manager.prepareSemanticCacheBatch.mockReturnValueOnce(batch.promise);
    plugin.scheduleAutomaticSemantic();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(manager.prepareSemanticCacheBatch).toHaveBeenCalledTimes(1);
    plugin.queuedWork = true;
    batch.resolve({ converged: false, state: { semanticReady: false } });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.prepareSemanticCacheBatch).toHaveBeenCalledTimes(1);
    plugin.queuedWork = false;
    plugin.pauseAutomaticSemanticForLexicalWork();
    manager.prepareSemanticCacheBatch.mockResolvedValueOnce({
      converged: true,
      state: { semanticReady: true },
    });
    plugin.scheduleAutomaticSemantic();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(manager.prepareSemanticCacheBatch).toHaveBeenCalledTimes(2);
    plugin.onunload();
    vi.useRealTimers();
  });

  it("retries only retryable automatic semantic failures at the bounded intervals", async () => {
    vi.useFakeTimers();
    const { plugin, manager } = automaticSemanticHarness(1_000);
    manager.prepareSemanticCacheBatch
      .mockRejectedValueOnce({ retryable: true })
      .mockRejectedValueOnce({ retryable: true })
      .mockRejectedValueOnce({ retryable: true })
      .mockRejectedValueOnce({ retryable: true });
    plugin.scheduleAutomaticSemantic();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(manager.prepareSemanticCacheBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(manager.prepareSemanticCacheBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.prepareSemanticCacheBatch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(manager.prepareSemanticCacheBatch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.prepareSemanticCacheBatch).toHaveBeenCalledTimes(4);
    expect(plugin.automaticSemanticRetryPaused).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(manager.prepareSemanticCacheBatch).toHaveBeenCalledTimes(4);

    const permanent = automaticSemanticHarness(1_000);
    permanent.manager.prepareSemanticCacheBatch.mockRejectedValueOnce({ retryable: false });
    permanent.plugin.scheduleAutomaticSemantic();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(permanent.manager.prepareSemanticCacheBatch).toHaveBeenCalledTimes(1);
    expect(permanent.plugin.automaticSemanticRetryTimer).toBeUndefined();
    plugin.onunload();
    permanent.plugin.onunload();
    vi.useRealTimers();
  });

  it("cancels automatic semantic timers and requests when its delay is set Off", async () => {
    vi.useFakeTimers();
    const { plugin, manager } = automaticSemanticHarness(1_000);
    plugin.scheduleAutomaticSemantic();
    await plugin.saveSettings({
      ...plugin.getSettings(),
      filo: { ...plugin.getSettings().filo, automaticSemanticDelayMs: 0 },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.prepareSemanticCacheBatch).not.toHaveBeenCalled();
    expect(plugin.automaticSemanticTimer).toBeUndefined();
    await plugin.saveSettings({
      ...plugin.getSettings(),
      filo: { ...plugin.getSettings().filo, automaticSemanticDelayMs: 2_000 },
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(manager.prepareSemanticCacheBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.prepareSemanticCacheBatch).toHaveBeenCalledTimes(1);
    plugin.onunload();
    vi.useRealTimers();
  });
});
