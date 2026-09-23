import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import { TramaPlugin } from "@/plugin/TramaPlugin";

describe("TramaPlugin module", () => {
  beforeEach(() => {
    Platform.isDesktopApp = true;
  });

  describe("TramaPlugin", () => {
    describe("onload()", () => {
      it("activates on desktop without making startup requests", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const plugin = new TramaPlugin(undefined as never, undefined as never);

        await plugin.onload();

        expect(plugin.isDesktopLoaded()).toBe(true);
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
      });

      it("activates the shared shell on mobile", async () => {
        Platform.isDesktopApp = false;
        const plugin = new TramaPlugin(undefined as never, undefined as never);

        await plugin.onload();

        expect(plugin.isRuntimeLoaded()).toBe(true);
        expect(plugin.isDesktopLoaded()).toBe(true);
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
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        await plugin.onload();

        expect(plugin.isRuntimeLoaded()).toBe(true);
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
              /^app:\/\/local\/\.obsidian\/plugins\/trama\/sqlite-worker\.mjs\?v=8&nonce=.+$/
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

        plugin.onunload();

        expect(plugin.isDesktopLoaded()).toBe(false);
      });
    });
  });
});
