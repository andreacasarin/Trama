import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import { LocalVaultAssistantPlugin } from "@/plugin/LocalVaultAssistantPlugin";

describe("LocalVaultAssistantPlugin module", () => {
  beforeEach(() => {
    Platform.isDesktopApp = true;
  });

  describe("LocalVaultAssistantPlugin", () => {
    describe("onload()", () => {
      it("activates on desktop without making startup requests", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const plugin = new LocalVaultAssistantPlugin(undefined as never, undefined as never);

        await plugin.onload();

        expect(plugin.isDesktopLoaded()).toBe(true);
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
      });

      it("does not activate on mobile", async () => {
        Platform.isDesktopApp = false;
        const plugin = new LocalVaultAssistantPlugin(undefined as never, undefined as never);

        await plugin.onload();

        expect(plugin.isDesktopLoaded()).toBe(false);
      });
    });

    describe("onunload()", () => {
      it("clears the desktop shell state cleanly", async () => {
        const plugin = new LocalVaultAssistantPlugin(undefined as never, undefined as never);
        await plugin.onload();

        plugin.onunload();

        expect(plugin.isDesktopLoaded()).toBe(false);
      });
    });
  });
});
