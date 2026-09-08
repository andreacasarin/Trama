import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { TramaPlugin } from "@/plugin/TramaPlugin";
import { DEFAULT_SETTINGS } from "@/settings/Settings";
import { IndexStatusController } from "@/ui/index/IndexStatus";

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
  plugin.loadData = vi.fn(async () => data);
  plugin.saveData = vi.fn(async () => undefined);
  plugin.addCommand = vi.fn();
  plugin.addSettingTab = vi.fn();
  plugin.registerView = vi.fn();
  plugin.registerEvent = vi.fn();
  return plugin as TramaPlugin & { app: typeof app };
}

describe("TramaPlugin lifecycle integration", () => {
  beforeEach(() => {
    Platform.isDesktopApp = true;
    vi.restoreAllMocks();
  });

  it("cold desktop startup registers shell surfaces and listeners without fetch or discovery", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    await plugin.onload();

    expect(plugin.isDesktopLoaded()).toBe(true);
    expect(plugin.addCommand).toHaveBeenCalledTimes(5);
    expect(plugin.registerView).toHaveBeenCalledTimes(2);
    expect(plugin.registerView).toHaveBeenCalledWith("trama-voce", expect.any(Function));
    expect(plugin.registerView).toHaveBeenCalledWith("trama-filo", expect.any(Function));
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
    ]);
    expect(
      (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls
        .map(([command]) => command as { id: string; icon?: string })
        .filter(({ id }) => id === "open-voce" || id === "open-filo")
        .map(({ id, icon }) => [id, icon])
    ).toEqual([
      ["open-voce", "message-circle"],
      ["open-filo", "route"],
    ]);
    expect(plugin.addSettingTab).toHaveBeenCalledTimes(1);
    expect(app.listeners).toHaveLength(4);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it("mobile activation registers no runtime surfaces and makes no fetch", async () => {
    Platform.isDesktopApp = false;
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await plugin.onload();

    expect(plugin.isDesktopLoaded()).toBe(false);
    expect(plugin.addCommand).not.toHaveBeenCalled();
    expect(plugin.registerView).not.toHaveBeenCalled();
    expect(plugin.registerEvent).not.toHaveBeenCalled();
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
    const embedding = (index as any).embedding;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    embedding.embed = vi.fn(async (texts: readonly string[]) => {
      await gate;
      return texts.map(() => [1, ...Array(embedding.dimensions - 1).fill(0)]);
    });
    const writes = vi.spyOn(app.vault.adapter, "write");
    const rebuild = index.build(new AbortController().signal);
    await vi.waitFor(() => expect(embedding.embed).toHaveBeenCalled());

    await plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      chat: { ...DEFAULT_SETTINGS.chat, modelId: "chat-v2" },
    });
    expect((plugin as any).index).toBe(index);
    expect((plugin as any).index.embedding).toBe(embedding);
    release();
    await rebuild;

    expect(writes).toHaveBeenCalled();
    expect(await index.search("anything", new AbortController().signal, 1)).toHaveLength(1);
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
    const oldEmbedding = (oldIndex as any).embedding;
    let oldStarted!: () => void;
    const started = new Promise<void>((resolve) => (oldStarted = resolve));
    oldEmbedding.embed = vi.fn(
      async (_texts: readonly string[], signal: AbortSignal) =>
        new Promise<readonly number[][]>((_resolve, reject) => {
          oldStarted();
          signal.addEventListener("abort", () => reject(new Error("old rebuild cancelled")), {
            once: true,
          });
        })
    );
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
    await save;
    await expect(oldRebuild).rejects.toThrow("old rebuild cancelled");
    const newIndex = (plugin as any).index;
    expect(newIndex).not.toBe(oldIndex);
    expect(newIndex.fingerprint().modelId).toBe("embed-v2");
    await expect(oldIndex.search("late", new AbortController().signal, 1)).rejects.toMatchObject({
      code: "unavailable",
    });

    const newEmbedding = (newIndex as any).embedding;
    newEmbedding.embed = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => [1, ...Array(newEmbedding.dimensions - 1).fill(0)])
    );
    await newIndex.build(new AbortController().signal);
    expect(newEmbedding.embed).toHaveBeenCalled();
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
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    await plugin.onload();
    const session = (plugin as any).session;
    const model = (plugin as any).chatModel;
    const index = (plugin as any).index;
    const diagnostics = (plugin as any).diagnostics;

    diagnostics.emit({ area: "chat", event: "model_error", error: new Error("hidden") });
    await plugin.saveSettings({ ...DEFAULT_SETTINGS, detailedDebug: true });
    diagnostics.emit({ area: "chat", event: "model_error", error: new Error("visible") });
    await plugin.saveSettings({ ...DEFAULT_SETTINGS, detailedDebug: false });
    diagnostics.emit({ area: "chat", event: "model_error", error: new Error("hidden again") });

    expect(plugin.saveData).toHaveBeenCalledTimes(2);
    expect((plugin as any).session).toBe(session);
    expect((plugin as any).chatModel).toBe(model);
    expect((plugin as any).index).toBe(index);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith("[Trama]", {
      area: "chat",
      event: "model_error",
      error: expect.objectContaining({ message: "visible" }),
    });
  });

  it("keeps embeddings out of detailed diagnostics", async () => {
    const app = projectedApp();
    const settings = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed", dimensions: 2 },
    };
    const plugin = projectedPlugin(app, settings);
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    await plugin.onload();
    await plugin.saveSettings({ ...settings, detailedDebug: true });

    await (plugin as any).embeddingModel.embed(["private note"], new AbortController().signal);

    expect(debugSpy).not.toHaveBeenCalled();
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
    ).not.toContain("current_note");
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
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
    const index = (plugin as any).index;
    vi.spyOn(index, "build").mockResolvedValue(undefined);
    const rebuild = (plugin as any).addCommand.mock.calls.find(
      ([command]: [{ id: string }]) => command.id === "index-filo-vault"
    )[0].callback;
    rebuild();
    await vi.waitFor(() => expect((plugin as any).indexReady).toBe(true));
    expect(voceView.refreshRelatedSuggestions).toHaveBeenCalledTimes(1);
    const reconcile = vi.spyOn(index, "reconcileQueuedChanges").mockResolvedValue(undefined);
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
    expect((plugin as any).indexReady).toBe(false);
  });

  it("publishes v1 then hands late v2 edits to the same manager for reconciliation", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
    const index = (plugin as any).index;
    let release!: () => void;
    let building = true;
    const buildGate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(index, "build").mockImplementation(async () => buildGate);
    vi.spyOn(index, "isBuilding").mockImplementation(() => building);
    const reconcile = vi.spyOn(index, "reconcileQueuedChanges").mockResolvedValue(undefined);
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

  it("ignores an old unavailable load after a replacement index loads ready", async () => {
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
    expect(plugin.indexReady).toBe(true);
  });

  it("debounces visible Markdown changes, ignores excluded files, and unloads idempotently", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
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
    expect(queue).not.toHaveBeenCalledWith("Note.md");
    expect(queue).not.toHaveBeenCalledWith("Renamed.md");
    expect(queue).not.toHaveBeenCalledWith("Old.md");
    expect(queue).not.toHaveBeenCalledWith("image.png");
    expect(queue).not.toHaveBeenCalledWith(".trama/index.md");
    expect(queue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    plugin.onunload();
    plugin.onunload();
    expect(app.listeners.every((ref) => !ref.active)).toBe(true);
    vi.useRealTimers();
  });

  it("exposes monotonic status/actions and coalesces typed edits after first indexing", async () => {
    vi.useFakeTimers();
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
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
    const reconcile = vi.spyOn(index, "reconcileQueuedChanges").mockResolvedValue(undefined);
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
    expect(status.getStatus().kind).toBe("ready");
    expect(statuses.map((entry) => Number(entry.split(":")[1]))).toEqual(
      statuses.map((entry) => Number(entry.split(":")[1])).sort((a, b) => a - b)
    );
    plugin.onunload();
    vi.useRealTimers();
  });

  it("delivers rename as one explicit old/new operation", async () => {
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
    const rename = vi.spyOn(index, "queueRename");
    const ref = app.listeners.find((item) => item.event === "rename");
    ref?.callback({ path: "Renamed.md" }, "Old.md");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith("Old.md", "Renamed.md");
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
    const operation = vi.spyOn(index, "queueOperation");
    const rename = vi.spyOn(index, "queueRename");
    const ref = app.listeners.find((item) => item.event === "rename");

    ref?.callback({ path: ".hidden.md" }, "Visible.md");
    ref?.callback({ path: "Visible.md" }, ".hidden.md");

    expect(operation).toHaveBeenNthCalledWith(1, { kind: "delete", path: "Visible.md" });
    expect(operation).toHaveBeenNthCalledWith(2, { kind: "create", path: "Visible.md" });
    expect(rename).not.toHaveBeenCalled();
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
