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

describe("TramaPlugin publication integration", () => {
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
  it("publishes the lexical index with an empty embedding model and clears an old warning", async () => {
    const app = projectedApp();
    const MaintenanceScheduler = (await import("@/index/MaintenanceScheduler"))
      .MaintenanceScheduler;
    vi.spyOn(MaintenanceScheduler.prototype, "checkPublication").mockResolvedValue({
      adopted: false,
      ignored: "missing",
    });
    const settings = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "  " },
    };
    const plugin = projectedPlugin(app, settings) as any;
    await plugin.onload();
    await plugin.indexLoad;
    const index = plugin.index;
    const semantic = vi.spyOn(index, "prepareSemantic");
    const publication = plugin.publicationManager;
    const publish = vi.spyOn(publication, "publish");
    const warning = {
      phase: "stage" as const,
      message: "offline",
      error: new Error("offline"),
      retryable: true,
    };
    publish.mockImplementationOnce(async () => {
      plugin.handlePublicationWarning(warning, "publication");
      return { published: false, warning };
    });
    await expect(plugin.maintenance.update()).rejects.toEqual(warning);
    expect(semantic).not.toHaveBeenCalled();
    expect(plugin.getIndexStatus().publicationWarning).toContain("offline");
    publish.mockResolvedValueOnce({ published: true });
    await plugin.maintenance.update();
    expect(plugin.getIndexStatus().publicationWarning).toBeUndefined();
  });

  it("publishes Update and Rebuild for an empty corpus with embeddings configured", async () => {
    const app = projectedApp();
    const MaintenanceScheduler = (await import("@/index/MaintenanceScheduler"))
      .MaintenanceScheduler;
    vi.spyOn(MaintenanceScheduler.prototype, "checkPublication").mockResolvedValue({
      adopted: false,
      ignored: "missing",
    });
    app.vault.getMarkdownFiles = () => [];
    const settings = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-v1" },
    };
    const plugin = projectedPlugin(app, settings) as any;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await plugin.onload();
    await plugin.indexLoad;
    const publish = vi.spyOn(plugin.publicationManager, "publish");

    await plugin.maintenance.update();
    expect(plugin.getIndexStatus()).toMatchObject({
      capabilities: {
        lexical: { state: "empty", searchable: false },
        semantic: { state: "empty", searchable: false },
      },
    });
    expect(plugin.getIndexStatus().publicationWarning).toBeUndefined();
    expect(publish).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();

    await plugin.maintenance.rebuild();
    expect(plugin.getIndexStatus()).toMatchObject({
      capabilities: {
        lexical: { state: "empty", searchable: false },
        semantic: { state: "empty", searchable: false },
      },
    });
    expect(plugin.getIndexStatus().publicationWarning).toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a queued Check from reclassifying a deferred publication warning", async () => {
    const app = projectedApp();
    const settings = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "  " },
    };
    const plugin = projectedPlugin(app, settings) as any;
    await plugin.onload();
    await plugin.indexLoad;
    await vi.waitFor(() => expect(plugin.maintenance.snapshot.lane).toBe("idle"));
    const publication = plugin.publicationManager;
    const pending = deferred<any>();
    const warning = {
      phase: "stage",
      message: "offline",
      error: new Error("offline"),
      retryable: true,
    };
    vi.spyOn(publication, "publish").mockImplementationOnce(async () => {
      await pending.promise;
      plugin.handlePublicationWarning(warning, "publication");
      return { published: false, warning };
    });
    const adoption = vi
      .spyOn(publication, "adoptCurrent")
      .mockResolvedValue({ adopted: false, ignored: "missing" });
    adoption.mockClear();
    const update = plugin.maintenance.update();
    await vi.waitFor(() => expect(plugin.maintenance.snapshot.phase).toBe("publication"));
    const check = plugin.checkPublication();
    pending.resolve(undefined);
    await Promise.all([expect(update).rejects.toEqual(warning), check]);
    expect(adoption).toHaveBeenCalled();
    expect(plugin.getIndexStatus().publicationWarning).toBe(
      "Index saved locally, but publication failed: offline"
    );
  });

  it("keeps publication and Check warning lifetimes independent", async () => {
    const plugin = projectedPlugin(projectedApp()) as any;
    await plugin.onload();
    await plugin.indexLoad;
    plugin.handlePublicationWarning(
      { phase: "stage", message: "publish offline", retryable: true },
      "publication"
    );
    plugin.handlePublicationWarning(
      { phase: "inspect", message: "invalid file", retryable: false },
      "check"
    );
    expect(plugin.getIndexStatus().publicationWarning).toBe(
      "Synchronized index check failed: invalid file"
    );
    plugin.clearPublicationWarning("check");
    expect(plugin.getIndexStatus().publicationWarning).toBe(
      "Index saved locally, but publication failed: publish offline"
    );
    plugin.clearPublicationWarning("publication");
    expect(plugin.getIndexStatus().publicationWarning).toBeUndefined();
  });
});
