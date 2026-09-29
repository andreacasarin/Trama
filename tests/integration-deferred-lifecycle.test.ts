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

describe("TramaPlugin deferred lifecycle integration", () => {
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
  it("transfers pending edits and edits during replacement to the new composition exactly once", async () => {
    const app = projectedApp();
    const oldLoad = deferred<boolean>();
    const newLoad = deferred<boolean>();
    vi.spyOn((await import("@/index/IndexManager")).IndexManager.prototype, "load")
      .mockReturnValueOnce(oldLoad.promise)
      .mockReturnValueOnce(newLoad.promise);
    const plugin = projectedPlugin(app);
    await plugin.onload();
    const IndexManager = (await import("@/index/IndexManager")).IndexManager;
    const MaintenanceScheduler = (await import("@/index/MaintenanceScheduler"))
      .MaintenanceScheduler;
    vi.spyOn(MaintenanceScheduler.prototype, "checkPublication").mockResolvedValue({
      adopted: false,
      ignored: "missing",
    });
    const requestFullRecovery = vi.spyOn(IndexManager.prototype, "requestFullRecovery");
    const maintenanceInvalidate = vi.spyOn(MaintenanceScheduler.prototype, "invalidate");
    const oldIndex = (plugin as any).index;
    const oldMaintenance = (plugin as any).maintenance;
    const oldQueue = vi.spyOn(oldIndex, "requestFullRecovery");
    const oldInvalidate = vi.spyOn(oldMaintenance, "invalidate");
    const disposeMaintenance = vi.spyOn(oldMaintenance, "dispose");
    vi.spyOn(oldIndex, "dispose").mockResolvedValue(undefined);
    oldMaintenance.invalidate();

    const save = plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-next" },
    });
    await vi.waitFor(() => expect(disposeMaintenance).toHaveBeenCalledOnce());
    const emit = (event: string, ...args: any[]) => {
      for (const ref of app.listeners.filter((item) => item.active && item.event === event))
        ref.callback(...args);
    };
    emit("modify", { path: "Note.md" });
    expect(oldQueue).not.toHaveBeenCalled();
    expect(oldInvalidate).toHaveBeenCalledOnce();

    oldLoad.resolve(true);
    await save;
    const newIndex = (plugin as any).index;
    const newMaintenance = (plugin as any).maintenance;
    expect(newIndex).not.toBe(oldIndex);
    expect(
      requestFullRecovery.mock.contexts.filter((context) => context === newIndex)
    ).toHaveLength(1);
    expect(
      maintenanceInvalidate.mock.contexts.filter((context) => context === newMaintenance)
    ).toHaveLength(1);
    expect(newMaintenance.snapshot.pending).toBe(true);
    expect(plugin.getIndexStatus()?.kind).toBe("stale");
    newLoad.resolve(true);
    await (plugin as any).indexLoad;
    await vi.waitFor(() => expect(plugin.getIndexStatus()?.kind).toBe("stale"));
  });

  it("keeps a startup edit stale after the delayed index load completes", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    const load = deferred<boolean>();
    vi.spyOn((await import("@/index/IndexManager")).IndexManager.prototype, "load").mockReturnValue(
      load.promise
    );
    const MaintenanceScheduler = (await import("@/index/MaintenanceScheduler"))
      .MaintenanceScheduler;
    vi.spyOn(MaintenanceScheduler.prototype, "checkPublication").mockResolvedValue({
      adopted: false,
      ignored: "missing",
    });
    await plugin.onload();
    (plugin as any).maintenance.invalidate();
    load.resolve(true);
    await vi.waitFor(() => expect(plugin.getIndexStatus()?.kind).toBe("stale"));
  });
});
