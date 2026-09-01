import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { LocalVaultAssistantPlugin } from "@/plugin/LocalVaultAssistantPlugin";
import { DEFAULT_SETTINGS } from "@/settings/Settings";

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
      remove: async (path: string) => {
        adapterFiles.delete(path);
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
  const plugin = new LocalVaultAssistantPlugin(undefined as never, undefined as never) as any;
  plugin.app = app;
  plugin.loadData = vi.fn(async () => data);
  plugin.saveData = vi.fn(async () => undefined);
  plugin.addCommand = vi.fn();
  plugin.addSettingTab = vi.fn();
  plugin.registerView = vi.fn();
  plugin.registerEvent = vi.fn();
  return plugin as LocalVaultAssistantPlugin & { app: typeof app };
}

describe("LocalVaultAssistantPlugin lifecycle integration", () => {
  beforeEach(() => {
    Platform.isDesktopApp = true;
    vi.restoreAllMocks();
  });

  it("cold desktop startup registers shell surfaces and listeners without fetch or discovery", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await plugin.onload();

    expect(plugin.isDesktopLoaded()).toBe(true);
    expect(plugin.addCommand).toHaveBeenCalledTimes(3);
    expect(plugin.registerView).toHaveBeenCalledTimes(1);
    expect(plugin.addSettingTab).toHaveBeenCalledTimes(1);
    expect(app.listeners).toHaveLength(4);
    expect(fetchSpy).not.toHaveBeenCalled();
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
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
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
    const state = await (plugin as any).session.send("hello");

    expect(oldSession.getState().error?.code).not.toBe("internal");
    expect((plugin as any).session).not.toBe(oldSession);
    expect(state.messages.at(-1)?.content).toBe("ok");
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:2345/v1/chat/completions",
      expect.objectContaining({ body: expect.stringContaining('"model":"chat-v2"') })
    );
    await expect(oldIndex.search("old", new AbortController().signal, 1)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect((plugin as any).index.fingerprint().embeddingBaseUrl).toBe("http://127.0.0.1:2345/v1");
    expect((plugin as any).index.fingerprint().modelId).toBe("embed-v2");
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
    const activate = vi.spyOn((index as any).storage, "activate");
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

    expect(activate).toHaveBeenCalledTimes(1);
    expect(await index.search("anything", new AbortController().signal, 1)).toHaveLength(1);
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

  it("marks a fresh index ready after explicit rebuild and reconciles a later modification", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
    const index = (plugin as any).index;
    vi.spyOn(index, "build").mockResolvedValue(undefined);
    const rebuild = (plugin as any).addCommand.mock.calls.find(
      ([command]: [{ id: string }]) => command.id === "rebuild-vault-index"
    )[0].callback;
    rebuild();
    await vi.waitFor(() => expect((plugin as any).indexReady).toBe(true));
    const reconcile = vi.spyOn(index, "reconcileQueuedChanges").mockResolvedValue(undefined);
    const emit = (event: string, ...args: any[]) => {
      for (const ref of app.listeners.filter((item) => item.active && item.event === event))
        ref.callback(...args);
    };
    emit("modify", { path: "Note.md" });
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(reconcile).toHaveBeenCalled();
  });

  it("keeps a failed or cancelled explicit rebuild non-ready", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    await plugin.onload();
    await (plugin as any).indexLoad;
    vi.spyOn((plugin as any).index, "build").mockRejectedValue(new Error("cancelled"));
    const rebuild = (plugin as any).addCommand.mock.calls.find(
      ([command]: [{ id: string }]) => command.id === "rebuild-vault-index"
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
    const buildGate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(index, "build").mockImplementation(async () => buildGate);
    const reconcile = vi.spyOn(index, "reconcileQueuedChanges").mockResolvedValue(undefined);
    const rebuild = (plugin as any).addCommand.mock.calls.find(
      ([command]: [{ id: string }]) => command.id === "rebuild-vault-index"
    )[0].callback;
    rebuild();
    await vi.waitFor(() => expect((index as any).build).toHaveBeenCalled());
    for (const ref of app.listeners.filter((item) => item.active && item.event === "modify"))
      ref.callback({ path: "Note.md" });
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
    vi.spyOn(index, "search").mockRejectedValue(new Error("unavailable"));
    const rebuild = (plugin as any).addCommand.mock.calls.find(
      ([command]: [{ id: string }]) => command.id === "rebuild-vault-index"
    )[0].callback;
    rebuild();
    await vi.waitFor(() => expect((index as any).build).toHaveBeenCalled());
    for (const ref of app.listeners.filter((item) => item.active && item.event === "modify"))
      ref.callback({ path: "Note.md" });
    release();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect((plugin as any).indexReady).toBe(false);
    await expect(index.search("v1", new AbortController().signal, 1)).rejects.toThrow(
      "unavailable"
    );
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
    emit("modify", { path: ".local-vault-assistant/index.md" });
    emit("rename", { path: "Renamed.md" }, "Old.md");
    expect(queue).not.toHaveBeenCalledWith("Note.md");
    expect(queue).not.toHaveBeenCalledWith("Renamed.md");
    expect(queue).not.toHaveBeenCalledWith("Old.md");
    expect(queue).not.toHaveBeenCalledWith("image.png");
    expect(queue).not.toHaveBeenCalledWith(".local-vault-assistant/index.md");
    expect(queue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    plugin.onunload();
    plugin.onunload();
    expect(app.listeners.every((ref) => !ref.active)).toBe(true);
    vi.useRealTimers();
  });
});
