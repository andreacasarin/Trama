import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import { TramaPlugin } from "@/plugin/TramaPlugin";
import { SqliteRuntime } from "@/plugin/SqliteRuntime";

describe("TramaPlugin module", () => {
  beforeEach(() => {
    Platform.isDesktopApp = true;
  });

  it("preserves resource queries and buffers messages during desktop Worker startup", async () => {
    const runtime = new SqliteRuntime(() => ({ id: "trama" }));
    const app = {
      vault: {
        adapter: { getResourcePath: (path: string) => `app://local/${path}?timestamp=123` },
      },
    };
    expect(runtime.workerUrl(app)).toMatch(/\?timestamp=123&v=9&nonce=/);
    let bootstrap: Blob | undefined;
    const worker = { postMessage: vi.fn(), addEventListener: vi.fn(), terminate: vi.fn() };
    vi.stubGlobal(
      "Worker",
      vi.fn(() => worker)
    );
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      bootstrap = blob as Blob;
      return "blob:test";
    });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      expect(runtime.createWorker(app)).toBe(worker);
      const source = (await bootstrap!.text()).replace(
        "await import(__tramaWorkerUrl)",
        "await loadModule(__tramaWorkerUrl)"
      );
      const delivered: unknown[] = [];
      const scope = { onmessage: (_event: unknown) => undefined };
      let finishImport!: () => void;
      const loadModule = () =>
        new Promise<void>((resolve) => {
          finishImport = () => {
            scope.onmessage = (event) => {
              delivered.push(event);
            };
            resolve();
          };
        });
      const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
      const startup = new AsyncFunction("self", "globalThis", "URL", "loadModule", source)(
        scope,
        { location: { href: "blob:test" } },
        URL,
        loadModule
      );
      const handshake = { data: { id: 1, method: "handshake" } };
      scope.onmessage(handshake);
      expect(delivered).toEqual([]);
      finishImport();
      await startup;
      expect(delivered).toEqual([handshake]);
      expect(revoke).toHaveBeenCalledWith("blob:test");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  describe("TramaPlugin", () => {
    describe("onload()", () => {
      it("keeps desktop startup network-silent without app composition", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const plugin = new TramaPlugin(undefined as never, undefined as never);

        await plugin.onload();

        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
      });

      it("completes mobile startup without app composition", async () => {
        Platform.isDesktopApp = false;
        const plugin = new TramaPlugin(undefined as never, undefined as never);

        await plugin.onload();
      });

      it("keeps mobile startup network-silent while composing runtime surfaces", async () => {
        Platform.isDesktopApp = false;
        const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
        plugin.app = {
          vault: {
            configDir: ".obsidian",
            getMarkdownFiles: () => [],
            on: () => ({ unsubscribe: vi.fn() }),
            adapter: {
              getResourcePath: (path: string) => `app://local/${path}`,
              read: async () => {
                throw new Error("missing");
              },
              mkdir: async () => undefined,
              write: async () => undefined,
            },
          },
          workspace: {
            getActiveFile: () => null,
            getLeavesOfType: () => [],
            on: () => ({ unsubscribe: vi.fn() }),
          },
          metadataCache: {},
        };
        plugin.loadData = vi.fn(async () => undefined);
        const commands = vi.spyOn(plugin, "addCommand");
        const views = vi.spyOn(plugin, "registerView");
        const setViewState = vi.fn();
        plugin.app.workspace.getLeaf = vi.fn(() => ({ setViewState }));
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        await plugin.onload();

        for (const id of ["open-lente", "open-voce", "open-filo"]) {
          const command = commands.mock.calls.find(
            ([command]) => (command as any).id === id
          )?.[0] as any;
          expect(command).toBeDefined();
          command.callback();
        }
        expect(setViewState).toHaveBeenCalledTimes(3);
        expect(views).toHaveBeenCalledTimes(3);
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
      });

      it("starts SQLite from the packaged module URL on mobile", () => {
        Platform.isDesktopApp = false;
        const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
        plugin.manifest = { id: "trama", dir: ".obsidian/plugins/trama" };
        const app = {
          vault: {
            configDir: ".obsidian",
            adapter: { getResourcePath: (path: string) => `app://local/${path}` },
          },
        };
        const originalWorker = globalThis.Worker;
        const worker = { postMessage: vi.fn(), addEventListener: vi.fn(), terminate: vi.fn() };
        globalThis.Worker = vi.fn(() => worker) as any;
        try {
          expect(plugin.createSqliteWorker(app)).toBe(worker);
          expect(globalThis.Worker).toHaveBeenCalledWith(
            expect.stringMatching(
              /^app:\/\/local\/\.obsidian\/plugins\/trama\/sqlite-worker\.mjs\?v=9&nonce=/
            ),
            { type: "module" }
          );
        } finally {
          globalThis.Worker = originalWorker;
        }
      });
    });

    describe("onunload()", () => {
      it("clears the desktop shell state cleanly", async () => {
        const plugin = new TramaPlugin(undefined as never, undefined as never);
        await plugin.onload();

        expect(() => plugin.onunload()).not.toThrow();
      });
    });
  });
});
