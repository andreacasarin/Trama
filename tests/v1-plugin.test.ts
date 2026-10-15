import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { TramaPlugin } from "@/plugin/TramaPlugin";
import { NoteSqliteRuntime } from "@/plugin/NoteSqliteRuntime";
import { IndexStatusController } from "@/ui/index/IndexStatus";

describe("V1 plugin composition", () => {
  beforeEach(() => {
    Platform.isDesktopApp = false;
  });

  it("starts without provider requests, registers manual index controls, and closes the worker", async () => {
    const files = new Map<string, string>();
    const directories = new Set<string>();
    const workers: any[] = [];
    const lifecycle: string[] = [];
    const WorkerStub = vi.fn(() => {
      const listeners = new Set<(event: any) => void>();
      const worker = {
        postMessage: vi.fn((request: any) => {
          if (request.method === "close") lifecycle.push(`close-${workers.length}`);
          if (request.method === "init" || request.method === "close")
            for (const listener of listeners)
              listener({ data: { id: request.id, ok: true, result: undefined } });
        }),
        addEventListener: vi.fn((_type: string, listener: (event: any) => void) =>
          listeners.add(listener)
        ),
        removeEventListener: vi.fn((_type: string, listener: (event: any) => void) =>
          listeners.delete(listener)
        ),
        terminate: vi.fn(() => lifecycle.push(`terminate-${workers.length}`)),
      };
      workers.push(worker);
      lifecycle.push(`create-${workers.length}`);
      return worker;
    });
    const originalWorker = globalThis.Worker;
    globalThis.Worker = WorkerStub as unknown as typeof Worker;
    const app = {
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
      workspace: {
        getActiveFile: () => null,
        getLeavesOfType: () => [],
        on: () => ({ unsubscribe: vi.fn() }),
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
      expect(WorkerStub).toHaveBeenCalledWith(
        expect.stringMatching(
          /^app:\/\/vault\/\.obsidian\/plugins\/trama\/sqlite-worker\.mjs\?v=test&nonce=/
        ),
        { type: "module" }
      );
      expect(commands.mock.calls.map(([command]) => (command as any).id)).toEqual(
        expect.arrayContaining([
          "trama-update-index",
          "trama-rebuild-index",
          "trama-stop-indexing",
          "trama-clear-index",
        ])
      );
      await plugin.saveSettings(plugin.getSettings());
      expect(lifecycle).toEqual(["create-1"]);
      expect(workers).toHaveLength(1);
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

  it("clears only the local note index and reports the committed status", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.status = new IndexStatusController();
    const invalidateRelated = vi.fn();
    const refreshSubmitted = vi.fn();
    plugin.retrieval = { invalidateRelated };
    plugin.app = { workspace: { getLeavesOfType: () => [{ view: { refreshSubmitted } }] } };
    plugin.client = { call: vi.fn(async () => undefined) };
    await plugin.clearIndex();
    expect(plugin.client.call).toHaveBeenCalledWith("noteStoreReset", {}, expect.any(AbortSignal));
    expect(invalidateRelated).toHaveBeenCalledOnce();
    expect(refreshSubmitted).toHaveBeenCalledOnce();
    expect(plugin.status.getStatus()).toMatchObject({
      kind: "index-required",
      message: "Local index cleared.",
    });
    expect(plugin.updateIndex).toBeDefined();
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
    const runtime = new NoteSqliteRuntime(() => undefined);
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
    first.files.set(".trama/note-v1/identity.json", "{}");
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
    const WorkerStub = vi.fn(() => {
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
        addEventListener: vi.fn((_type: string, listener: (event: any) => void) =>
          listeners.add(listener)
        ),
        removeEventListener: vi.fn((_type: string, listener: (event: any) => void) =>
          listeners.delete(listener)
        ),
        terminate: vi.fn(),
      };
      workers.push(worker);
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
    const WorkerStub = vi.fn(() => {
      const listeners = new Set<(event: any) => void>();
      const worker = {
        postMessage: vi.fn((request: any) => {
          if (request.method === "close" && workers.length === 1) {
            closeStarted();
            void firstClose.then(() => {
              for (const listener of listeners)
                listener({ data: { id: request.id, ok: true, result: undefined } });
            });
          } else if (request.method === "init" || request.method === "close") {
            for (const listener of listeners)
              listener({ data: { id: request.id, ok: true, result: undefined } });
          }
        }),
        addEventListener: vi.fn((_type: string, listener: (event: any) => void) =>
          listeners.add(listener)
        ),
        removeEventListener: vi.fn((_type: string, listener: (event: any) => void) =>
          listeners.delete(listener)
        ),
        terminate: vi.fn(),
      };
      workers.push(worker);
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
