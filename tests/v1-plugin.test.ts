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
      },
      metadataCache: { getFirstLinkpathDest: () => null, getFileCache: () => null },
    };
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.app = app;
    plugin.manifest = { id: "trama", dir: ".obsidian/plugins/trama", version: "test" };
    plugin.loadData = vi.fn(async () => undefined);
    plugin.saveData = vi.fn(async () => undefined);
    const commands = vi.spyOn(plugin, "addCommand");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await plugin.onload();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(WorkerStub).toHaveBeenCalledWith(
        expect.stringMatching(
          /^app:\/\/vault\/\.obsidian\/plugins\/trama\/sqlite-worker\.mjs\?v=test&nonce=/
        ),
        { type: "module" }
      );
      expect(commands.mock.calls.map(([command]) => (command as any).id)).toEqual(
        expect.arrayContaining(["trama-update-index", "trama-rebuild-index", "trama-stop-indexing"])
      );
      await plugin.saveSettings(plugin.getSettings());
      expect(lifecycle.slice(0, 4)).toEqual(["create-1", "close-1", "terminate-1", "create-2"]);
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      plugin.onunload();
      await vi.waitFor(() =>
        expect(workers[1].postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ method: "close" })
        )
      );
      await vi.waitFor(() => expect(workers[1].terminate).toHaveBeenCalledOnce());
    } finally {
      fetchSpy.mockRestore();
      globalThis.Worker = originalWorker;
      plugin.onunload();
    }
  });

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
