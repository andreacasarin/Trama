import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import { TramaPlugin } from "@/plugin/TramaPlugin";

describe("TramaPlugin module", () => {
  beforeEach(() => {
    Platform.isDesktopApp = true;
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
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        await plugin.onload();

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
