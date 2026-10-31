import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, normalizeExcludedFolders, SettingsStore } from "@/settings/Settings";
import { ConsoleDebug } from "@/plugin/ConsoleDebug";
import { normalizeStorageFolder } from "@/settings/StorageFolder";

describe("settings", () => {
  it("normalizes console debugging strictly and suppresses every console level when disabled", () => {
    const store = new SettingsStore();
    expect(store.load({ consoleDebug: "true" }).consoleDebug).toBe(false);
    expect(store.load({ consoleDebug: true }).consoleDebug).toBe(true);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let enabled = false;
    const debug = new ConsoleDebug(() => enabled);
    debug.info("hidden");
    debug.warn("hidden", new Error("hidden"));
    debug.error("hidden", new Error("hidden"));
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    enabled = true;
    debug.error("visible", new Error("detail"));
    expect(error).toHaveBeenCalledOnce();
    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it("loads supported reasoning efforts and treats removed on/off values as Auto", () => {
    const store = new SettingsStore();
    const loaded = store.load({
      ...DEFAULT_SETTINGS,
      chat: { ...DEFAULT_SETTINGS.chat, modelId: "local-chat", reasoningEffort: "minimal" },
    });
    expect(loaded.chat.reasoningEffort).toBe("minimal");
    const staged = store.stage({
      ...loaded,
      chat: { ...loaded.chat, modelId: "another-model", reasoningEffort: "xhigh" },
    });
    expect(staged.chat.reasoningEffort).toBe("xhigh");
    for (const effort of ["on", "off"]) {
      expect(
        store.load({
          ...DEFAULT_SETTINGS,
          chat: { ...DEFAULT_SETTINGS.chat, reasoningEffort: effort },
        }).chat.reasoningEffort
      ).toBeUndefined();
    }
  });

  it("canonicalizes valid vault-relative exclusions and rejects traversal", () => {
    expect(
      normalizeExcludedFolders([
        " Projects/./Archive ",
        "Projects",
        "Projects",
        "../Secret",
        "/Absolute",
        "Bad\\Path",
      ])
    ).toEqual(["Projects", "Projects/Archive"]);
  });

  it("defaults storage to .trama and validates canonical vault-relative paths", () => {
    expect(DEFAULT_SETTINGS.storageFolder).toBe(".trama");
    expect(normalizeStorageFolder(" Notes /./ Trama ")).toBe("Notes/Trama");
    for (const path of [
      "",
      "/absolute",
      "C:/absolute",
      "../outside",
      "Notes/../outside",
      "bad\\path",
      ".obsidian",
      ".obsidian/plugins",
    ])
      expect(() => normalizeStorageFolder(path)).toThrow();
  });
});
