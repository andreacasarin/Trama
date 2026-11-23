import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, normalizeExcludedFolders, SettingsStore } from "@/settings/Settings";
import { ConsoleDebug } from "@/plugin/ConsoleDebug";
import { normalizeStorageFolder } from "@/settings/StorageFolder";
import { TramaSettingsTab } from "@/ui/settings/SettingsTab";
import type { TramaPlugin } from "@/plugin/TramaPlugin";
import type { App, Setting } from "obsidian";
import { Setting as TestSetting } from "./obsidian";

describe("settings", () => {
  it("normalizes console debugging strictly and suppresses every console level when disabled", () => {
    const store = new SettingsStore();
    expect(store.load({ consoleDebug: "true" }).consoleDebug).toBe(false);
    expect(store.load({ consoleDebug: true }).consoleDebug).toBe(true);
    const info = vi.spyOn(console, "debug").mockImplementation(() => {});
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
    debug.info("diagnostic");
    expect(info).toHaveBeenCalledWith("[Trama] diagnostic");
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
      expect(() => normalizeStorageFolder(path, ".obsidian")).toThrow();
    expect(() => normalizeStorageFolder("config/plugins", "config")).toThrow();
    expect(normalizeStorageFolder(".obsidian/plugins", "config")).toBe(".obsidian/plugins");
  });

  it("indexes settings without rendering and uses the same controls on both host APIs", async () => {
    const getAllFolders = vi.fn(() => []);
    const app = { vault: { getAllFolders, configDir: ".obsidian" } } as unknown as App;
    let settings = DEFAULT_SETTINGS;
    const getSettings = vi.fn(() => settings);
    const saveSettings = vi.fn(async (update: (current: typeof settings) => typeof settings) => {
      settings = update(settings);
    });
    const plugin = { getSettings, saveSettings } as unknown as TramaPlugin;
    const tab = new TramaSettingsTab(app, plugin);
    const definitions = tab.getSettingDefinitions().flatMap((group) => group.items);
    expect(getSettings).not.toHaveBeenCalled();
    expect(getAllFolders).not.toHaveBeenCalled();

    const nativeRows = definitions.map((definition) => {
      const row = new TestSetting(tab.containerEl).setName(definition.name);
      definition.render(row as unknown as Setting);
      return row;
    });
    const legacyStart = TestSetting.instances.length;
    tab.display();
    const legacyRows = TestSetting.instances
      .slice(legacyStart)
      .filter((row) => row.controls.length);
    expect(legacyRows.map(({ name }) => name)).toEqual(nativeRows.map(({ name }) => name));
    const debug = legacyRows.find(({ name }) => name === "Console debugging")!.controls[0];
    debug.change(true);
    await vi.waitFor(() => expect(settings.consoleDebug).toBe(true));

    const reopenedTab = new TramaSettingsTab(app, plugin);
    const debugDefinition = reopenedTab
      .getSettingDefinitions()
      .flatMap((group) => group.items)
      .find(({ name }) => name === "Console debugging")!;
    const reopened = new TestSetting(reopenedTab.containerEl);
    debugDefinition.render(reopened as unknown as Setting);
    expect(reopened.controls[0].value).toBe(true);
  });
});
