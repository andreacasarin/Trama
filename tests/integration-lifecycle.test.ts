import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { TramaPlugin } from "@/plugin/TramaPlugin";
import { DEFAULT_SETTINGS } from "@/settings/Settings";
import { IndexStatusController } from "@/ui/index/IndexStatus";
import { LenteSearch } from "@/index/LenteSearch";
import type { TramaDiagnosticRecord } from "@/diagnostics/TramaDiagnostics";
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
  plugin.registerEvent = vi.fn();
  return plugin as TramaPlugin & { app: typeof app };
}

async function optInToAutomaticUpdates(plugin: TramaPlugin): Promise<void> {
  const current = plugin.getSettings();
  await plugin.saveSettings({
    ...current,
    filo: { ...current.filo, automaticUpdates: true },
  });
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
    expect(plugin.sqliteWorkerUrl(app)).toBe(
      "app://local/.obsidian/plugins/trama/sqlite-worker.mjs"
    );
  });

  it("falls back to the configured plugin directory when manifest.dir is absent", () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app) as any;
    plugin.manifest = { id: "trama" };
    expect(plugin.sqliteWorkerUrl(app)).toBe(
      "app://local/.obsidian/plugins/trama/sqlite-worker.mjs"
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
      expect(await bootstrap!.text()).toContain(
        'const __tramaWorkerUrl="app://local/.obsidian/plugins/trama/sqlite-worker.mjs"'
      );
      expect(await bootstrap!.text()).toContain("await import(__tramaWorkerUrl)");
      expect(await bootstrap!.text()).toContain('code:"storage_unavailable"');
      expect(await bootstrap!.text()).toContain("URL.revokeObjectURL(globalThis.location.href)");
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    } finally {
      globalThis.Worker = originalWorker;
      URL.createObjectURL = originalCreateObjectUrl;
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
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
    plugin.indexStatus = { setUpdating: vi.fn(), setReady: vi.fn(), markStale: vi.fn() };
    plugin.index = {
      isBuilding: () => false,
      isComplete: () => true,
      reconcileQueuedChanges: vi
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
    expect(plugin.addCommand).toHaveBeenCalledTimes(7);
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
    expect(app.listeners).toHaveLength(4);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it("keeps default-off vault events queued and stale without scheduling or contacting LM Studio", async () => {
    const load = vi
      .spyOn((await import("@/index/IndexManager")).IndexManager.prototype, "load")
      .mockResolvedValue(true);
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await plugin.onload();
    await (plugin as any).indexLoad;
    const index = (plugin as any).index;
    const queue = vi.spyOn(index, "queueChange");
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
    load.mockRestore();
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
    expect(plugin.addCommand).toHaveBeenCalledTimes(7);
    expect(plugin.registerView).toHaveBeenCalledTimes(3);
    expect(plugin.registerEvent).toHaveBeenCalledTimes(4);
    expect(fetchSpy).not.toHaveBeenCalled();
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
    await expect(oldRebuild).rejects.toThrow("Operation cancelled");
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
      filo: { ...DEFAULT_SETTINGS.filo, automaticUpdates: true },
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
    const reconcile = vi
      .spyOn(index, "reconcileQueuedChanges")
      .mockResolvedValue({ changed: true, converged: true });
    const emit = (event: string, ...args: any[]) => {
      for (const ref of app.listeners.filter((item) => item.active && item.event === event))
        ref.callback(...args);
    };
    emit("modify", { path: "Note.md" });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(reconcile).toHaveBeenCalled();
    expect(voceView.refreshRelatedSuggestions).toHaveBeenCalledTimes(2);
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
    const reconcile = vi
      .spyOn(index, "reconcileQueuedChanges")
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
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith(expect.any(AbortSignal)));
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
    const reconcile = vi
      .spyOn(index, "reconcileQueuedChanges")
      .mockRejectedValueOnce(new Error("v2 embedding failed"))
      .mockResolvedValue(undefined);
    const rebuild = (plugin as any).addCommand.mock.calls.find(
      ([command]: [{ id: string }]) => command.id === "reindex-filo-vault"
    )[0].callback;
    rebuild();
    await vi.waitFor(() => expect((index as any).build).toHaveBeenCalled());
    for (const ref of app.listeners.filter((item) => item.active && item.event === "modify"))
      ref.callback({ path: "Note.md" });
    release();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect((plugin as any).indexReady).toBe(true);
    expect((plugin as any).indexStatus.getStatus()).toMatchObject({
      kind: "stale",
      hasLastGood: true,
    });
    rebuild();
    await vi.waitFor(() => expect((plugin as any).indexReady).toBe(true));
    expect((index as any).build).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(1);
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
    const queue = vi.spyOn(index, "queueChange");
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
    await vi.advanceTimersByTimeAsync(1500);
    plugin.onunload();
    plugin.onunload();
    expect(app.listeners.every((ref) => !ref.active)).toBe(true);
    vi.useRealTimers();
  });

  it("coalesces opted-in edits, does not retry a failed background pass, and retries on a later event", async () => {
    vi.useFakeTimers();
    const load = vi
      .spyOn((await import("@/index/IndexManager")).IndexManager.prototype, "load")
      .mockResolvedValue(true);
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticUpdates: true },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await optInToAutomaticUpdates(plugin);
    const index = (plugin as any).index;
    const reconcile = vi
      .spyOn(index, "reconcileQueuedChanges")
      .mockRejectedValueOnce(new Error("embedding failed"))
      .mockResolvedValue(undefined);
    const modify = app.listeners.find((ref) => ref.event === "modify");

    modify?.callback({ path: "Note.md" });
    modify?.callback({ path: "Note.md" });
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reconcile).toHaveBeenCalledTimes(1);

    modify?.callback({ path: "Other.md" });
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    load.mockRestore();
    vi.useRealTimers();
  });

  it("opt-out clears the debounce, aborts automatic work, and preserves queued stale work", async () => {
    vi.useFakeTimers();
    const load = vi
      .spyOn((await import("@/index/IndexManager")).IndexManager.prototype, "load")
      .mockResolvedValue(true);
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticUpdates: true },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await optInToAutomaticUpdates(plugin);
    const index = (plugin as any).index;
    const pending = deferred<{ changed: boolean; converged: boolean }>();
    const reconcile = vi.spyOn(index, "reconcileQueuedChanges").mockReturnValue(pending.promise);
    const modify = app.listeners.find((ref) => ref.event === "modify");
    modify?.callback({ path: "Note.md" });
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    const signal = reconcile.mock.calls[0][0] as AbortSignal;

    await plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticUpdates: false },
    });
    expect(signal.aborted).toBe(true);
    expect((plugin as any).eventTimer).toBeUndefined();
    expect((plugin as any).queuedWork).toBe(true);
    expect((plugin as any).indexStatus.getStatus().kind).toBe("stale");
    pending.resolve({ changed: false, converged: false });
    await Promise.resolve();
    load.mockRestore();
    vi.useRealTimers();
  });

  it("resumes queued automatic work after a slow cancelled pass and rapid re-opt-in", async () => {
    vi.useFakeTimers();
    const load = vi
      .spyOn((await import("@/index/IndexManager")).IndexManager.prototype, "load")
      .mockResolvedValue(true);
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticUpdates: true },
    });
    await plugin.onload();
    await (plugin as any).indexLoad;
    await optInToAutomaticUpdates(plugin);
    const index = (plugin as any).index;
    const reconcile = vi
      .spyOn(index, "reconcileQueuedChanges")
      .mockImplementationOnce(
        (signal) =>
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
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));

    await plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticUpdates: false },
    });
    const optIn = plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticUpdates: true },
    });
    await optIn;
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));

    load.mockRestore();
    vi.useRealTimers();
  });

  it("exposes monotonic status/actions and coalesces typed edits after first indexing", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app, {
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticUpdates: true },
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
    const reconcile = vi
      .spyOn(index, "reconcileQueuedChanges")
      .mockResolvedValue({ changed: false, converged: false });
    const emit = (event: string, ...args: any[]) => {
      for (const ref of app.listeners.filter((item) => item.active && item.event === event))
        ref.callback(...args);
    };
    emit("modify", { path: "Note.md" });
    emit("modify", { path: "Note.md" });
    expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1499);
    expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(status.getStatus().kind).toBe("stale");
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
    const queue = vi.spyOn(index, "queueChange");
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
    const queue = vi.spyOn(index, "queueChange");
    const ref = app.listeners.find((item) => item.event === "rename");

    ref?.callback({ path: ".hidden.md" }, "Visible.md");
    ref?.callback({ path: "Visible.md" }, ".hidden.md");

    expect(queue).toHaveBeenCalledTimes(2);
    plugin.onunload();
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
      message: "Creating embeddings — 2 of 4 texts",
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
      message: "Creating embeddings — 4 of about 20 texts · about 8 sec remaining",
    });
  });
});
