import { afterEach, describe, expect, it, vi } from "vitest";
import { Setting } from "obsidian";
import {
  DEFAULT_SETTINGS,
  normalizeExcludedFolders,
  type TramaSettings,
} from "@/settings/Settings";
import { TramaSettingsTab } from "@/ui/settings/SettingsTab";

interface MockControl {
  value: string;
  options: Map<string, string>;
  inputEl: { fire(type: string, event?: any): void };
  change(value: string): void;
  click(): void;
}
interface MockSetting {
  name: string;
  controls: MockControl[];
}
const mockSettings = Setting as unknown as { instances: MockSetting[] };

describe("Trama settings tab autosave", () => {
  afterEach(() => {
    mockSettings.instances = [];
  });

  function setup(initial: TramaSettings = DEFAULT_SETTINGS) {
    let settings = structuredClone(initial) as TramaSettings;
    const configureServices = vi.fn();
    const plugin = {
      getSettings: () => settings,
      saveSettings: vi.fn(async (update: (current: TramaSettings) => TramaSettings) => {
        settings = update(settings);
      }),
      configureServices,
      updateIndex: vi.fn(async () => undefined),
      rebuildIndex: vi.fn(async () => undefined),
      stopIndex: vi.fn(),
      clearIndex: vi.fn(async () => undefined),
      discoverModels: vi.fn(async (): Promise<readonly string[]> => []),
    };
    const app = {
      vault: { getAllFolders: () => [{ path: "Projects" }, { path: "Projects Archive" }] },
    };
    const tab = new TramaSettingsTab(app as never, plugin as never);
    tab.display();
    return { tab, plugin, getSettings: () => settings };
  }

  function setting(name: string): MockSetting {
    const result = mockSettings.instances.find((item) => item.name === name);
    if (!result) throw new Error(`Setting not found: ${name}`);
    return result;
  }

  it("removes Save, delays text persistence until a valid commit, and autosaves dropdowns", async () => {
    const { plugin, getSettings } = setup();
    expect(
      mockSettings.instances.some((item) =>
        item.controls.some((control) => control.value === "Save")
      )
    ).toBe(false);

    const temperature = setting("Temperature").controls[0];
    temperature.change("2");
    temperature.inputEl.fire("blur");
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    temperature.change("0.2");
    temperature.inputEl.fire("blur");
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    temperature.change("0.7");
    temperature.inputEl.fire("keydown", { key: "Enter", preventDefault: vi.fn() });
    await vi.waitFor(() => expect(getSettings().chat.temperature).toBe(0.7));

    const reasoning = setting("Reasoning effort").controls[0];
    reasoning.change("high");
    await vi.waitFor(() => expect(getSettings().chat.reasoningEffort).toBe("high"));
  });

  it("omits the redundant Trama title and starts maintenance at Update index", () => {
    const { tab } = setup();
    const container = tab.containerEl as unknown as { children: Array<{ textContent: string }> };
    expect(container.children.some((child) => child.textContent === "Trama")).toBe(false);
    const settingNames = mockSettings.instances.map((item) => item.name);
    expect(settingNames.indexOf("Maintenance")).toBeLessThan(settingNames.indexOf("Update index"));
  });

  it("keeps a failed endpoint commit visible and leaves the saved value intact", async () => {
    const { tab, plugin, getSettings } = setup();
    vi.mocked(plugin.saveSettings).mockRejectedValueOnce(new Error("disk full"));
    const original = getSettings().chat.endpoint;
    setting("Chat endpoint").controls[0].change("not an endpoint");
    setting("Chat endpoint").controls[0].inputEl.fire("blur");
    await vi.waitFor(() => expect(plugin.saveSettings).toHaveBeenCalledOnce());
    expect(getSettings().chat.endpoint).toBe(original);
    tab.display();
    const rendered = mockSettings.instances.filter((item) => item.name === "Chat endpoint").at(-1);
    expect(rendered?.controls[0].value).toBe("not an endpoint");
  });

  it("flushes valid drafts on hide and keeps rapid field updates independent", async () => {
    const { tab, getSettings } = setup();
    setting("Chat model").controls[0].change("local-chat");
    setting("Embedding model").controls[0].change("local-embed");
    tab.hide();
    await vi.waitFor(() => {
      expect(getSettings().chat.modelId).toBe("local-chat");
      expect(getSettings().embedding.modelId).toBe("local-embed");
    });
  });

  it("saves a LAN endpoint and its approval atomically", async () => {
    const { plugin, getSettings } = setup();
    const endpoint = setting("Chat endpoint").controls[0];
    endpoint.change("http://192.168.1.20:8080/v1");
    const approval = mockSettings.instances.filter((item) => item.name === "Endpoint trust")[0]
      .controls[0];
    approval.click();
    await vi.waitFor(() => expect(getSettings().approvedOrigins).toHaveLength(1));
    expect(getSettings().chat.endpoint).toBe("http://192.168.1.20:8080/v1");
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("combines model selection and discovery in one row and persists a discovered choice", async () => {
    const initial = {
      ...DEFAULT_SETTINGS,
      chat: { ...DEFAULT_SETTINGS.chat, modelId: "saved-model" },
    };
    const { plugin, getSettings } = setup(initial);
    vi.mocked(plugin.discoverModels).mockResolvedValue(["new-model"]);
    expect(mockSettings.instances.filter((item) => item.name === "Chat model")).toHaveLength(1);
    const row = setting("Chat model");
    expect(row.controls).toHaveLength(2);
    expect(row.controls[0].value).toBe("saved-model");
    expect(row.controls[0].options.has("saved-model")).toBe(true);
    row.controls[1].click();
    await vi.waitFor(() =>
      expect(mockSettings.instances.filter((item) => item.name === "Chat model")).toHaveLength(2)
    );
    const refreshed = mockSettings.instances.filter((item) => item.name === "Chat model").at(-1)!;
    expect(refreshed.controls[0].options.has("new-model")).toBe(true);
    expect(refreshed.controls[0].value).toBe("saved-model");
    refreshed.controls[0].change("new-model");
    await vi.waitFor(() => expect(getSettings().chat.modelId).toBe("new-model"));
  });

  it("ignores model discovery results after its endpoint draft changes", async () => {
    const { tab, plugin } = setup({
      ...DEFAULT_SETTINGS,
      chat: { ...DEFAULT_SETTINGS.chat, modelId: "saved-model" },
    });
    let resolveModels!: (models: readonly string[]) => void;
    vi.mocked(plugin.discoverModels).mockReturnValue(
      new Promise((resolve) => (resolveModels = resolve))
    );
    setting("Chat model").controls[1].click();
    setting("Chat endpoint").controls[0].change("http://127.0.0.1:1235/v1");
    resolveModels(["stale-model"]);
    await Promise.resolve();
    await Promise.resolve();
    const rows = mockSettings.instances.filter((item) => item.name === "Chat model");
    expect(rows).toHaveLength(1);
    expect(rows[0].controls[0].options.has("stale-model")).toBe(false);
    expect(rows[0].controls[0].value).toBe("saved-model");
    tab.hide();
  });

  it("scopes discovered choices to the current endpoint and clears them on failure", async () => {
    const { plugin } = setup({
      ...DEFAULT_SETTINGS,
      chat: { ...DEFAULT_SETTINGS.chat, modelId: "saved-model" },
    });
    vi.mocked(plugin.discoverModels)
      .mockResolvedValueOnce(["endpoint-a-model"])
      .mockRejectedValueOnce(new Error("endpoint B is unavailable"));
    setting("Chat model").controls[1].click();
    await vi.waitFor(() =>
      expect(mockSettings.instances.filter((item) => item.name === "Chat model")).toHaveLength(2)
    );
    let modelRow = mockSettings.instances.filter((item) => item.name === "Chat model").at(-1)!;
    expect(modelRow.controls[0].options.has("endpoint-a-model")).toBe(true);

    setting("Chat endpoint").controls[0].change("http://127.0.0.1:1235/v1");
    expect(modelRow.controls[0].options.has("endpoint-a-model")).toBe(false);
    expect(modelRow.controls[0].options.has("saved-model")).toBe(true);
    modelRow.controls[1].click();
    await vi.waitFor(() => expect(plugin.discoverModels).toHaveBeenCalledTimes(2));
    modelRow = mockSettings.instances.filter((item) => item.name === "Chat model").at(-1)!;
    expect(modelRow.controls[0].options.has("endpoint-a-model")).toBe(false);
    expect(modelRow.controls[0].options.has("saved-model")).toBe(true);
  });

  it("adds folders from the native list and keeps missing exclusions removable", async () => {
    const initial = { ...DEFAULT_SETTINGS, excludedFolders: ["Missing"] };
    const { plugin, getSettings } = setup(initial);
    expect(mockSettings.instances.some((item) => item.name === "Missing (folder not found)")).toBe(
      true
    );
    const folderDropdown = setting("Exclude folder").controls[0];
    expect(folderDropdown.options.has("Projects")).toBe(true);
    folderDropdown.change("Projects");
    setting("Exclude folder").controls[1].click();
    await vi.waitFor(() => expect(getSettings().excludedFolders).toEqual(["Missing", "Projects"]));
    await vi.waitFor(() => expect(folderDropdown.value).toBe(""));
    const removeMissing = setting("Missing (folder not found)").controls[0];
    removeMissing.click();
    await vi.waitFor(() => expect(getSettings().excludedFolders).toEqual(["Projects"]));
    expect(plugin.saveSettings).toHaveBeenCalledTimes(2);
  });

  it("exposes a separately labeled local index clear action", () => {
    const { plugin } = setup();
    const clear = setting("Clear local index").controls.find(
      (control) => control.value === "Clear"
    );
    expect(clear).toBeDefined();
    clear!.click();
    expect(plugin.clearIndex).toHaveBeenCalledOnce();
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
});
