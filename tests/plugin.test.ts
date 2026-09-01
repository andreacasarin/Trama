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

      it("does not activate on mobile", async () => {
        Platform.isDesktopApp = false;
        const plugin = new TramaPlugin(undefined as never, undefined as never);

        await plugin.onload();

        expect(plugin.isDesktopLoaded()).toBe(false);
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
