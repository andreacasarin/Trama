import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal, Notice, Setting } from "obsidian";
import {
  DEFAULT_SETTINGS,
  normalizeExcludedFolders,
  SettingsStore,
  type TramaSettings,
} from "@/settings/Settings";
import { TramaSettingsTab } from "@/ui/settings/SettingsTab";
import { ConsoleDebug } from "@/plugin/ConsoleDebug";

interface MockControl {
  value: string | boolean;
  options: Map<string, string>;
  inputEl: { fire(type: string, event?: any): void };
  change(value: string | boolean): void;
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
    (Modal as unknown as { instances: unknown[] }).instances = [];
    (Notice as unknown as { instances: unknown[] }).instances = [];
  });

  function setup(
    initial: TramaSettings = DEFAULT_SETTINGS,
    consoleDebug?: ConsoleDebug,
    hasIndexedNotes = false,
    hasActiveIndex = false
  ) {
    let settings = structuredClone(initial) as TramaSettings;
    const configureServices = vi.fn();
    const plugin = {
      getSettings: () => settings,
      saveSettings: vi.fn(async (update: (current: TramaSettings) => TramaSettings) => {
        settings = update(settings);
      }),
      configureServices,
      hasIndexedNotes,
      hasIndexedOrActiveIndex: hasIndexedNotes || hasActiveIndex,
      updateIndex: vi.fn(async () => undefined),
      rebuildIndex: vi.fn(async () => undefined),
      stopIndex: vi.fn(),
      clearIndex: vi.fn(async () => undefined),
      discoverModels: vi.fn(async (): Promise<readonly string[]> => []),
    };
    const app = {
      vault: { getAllFolders: () => [{ path: "Projects" }, { path: "Projects Archive" }] },
    };
    const tab = new TramaSettingsTab(app as never, plugin as never, consoleDebug);
    tab.display();
    return {
      tab,
      plugin,
      getSettings: () => settings,
      setSettings: (next: TramaSettings) => (settings = next),
    };
  }

  function setting(name: string): MockSetting {
    const result = mockSettings.instances.find((item) => item.name === name);
    if (!result) throw new Error(`Setting not found: ${name}`);
    return result;
  }

  function resolveEmbeddingConfirmation(choice: "Cancel" | "Save changes"): void {
    const row = mockSettings.instances
      .filter((item) => item.name === "Embedding settings change")
      .at(-1);
    const control = row?.controls.find((item) => item.value === choice);
    if (!control) throw new Error(`Confirmation button not found: ${choice}`);
    control.click();
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

  it("persists the default-off console toggle without rebuilding services", async () => {
    const { plugin, getSettings } = setup();
    expect(DEFAULT_SETTINGS.consoleDebug).toBe(false);
    const toggle = setting("Console debugging").controls[0];
    expect(toggle.value).toBe(false);
    toggle.change(true);
    await vi.waitFor(() => expect(getSettings().consoleDebug).toBe(true));
    expect(plugin.configureServices).not.toHaveBeenCalled();
  });

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

  it("loads supported efforts and treats the removed on/off values as Auto", () => {
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

  it("offers only API efforts globally and preserves the choice across model changes", async () => {
    const { plugin, getSettings } = setup({
      ...DEFAULT_SETTINGS,
      chat: { ...DEFAULT_SETTINGS.chat, modelId: "first-model" },
    });
    const reasoning = setting("Reasoning effort").controls[0];
    expect([...reasoning.options.keys()]).toEqual([
      "auto",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    reasoning.change("xhigh");
    await vi.waitFor(() => expect(getSettings().chat.reasoningEffort).toBe("xhigh"));

    vi.mocked(plugin.discoverModels).mockResolvedValueOnce(["second-model"]);
    setting("Chat model").controls[1].click();
    await vi.waitFor(() =>
      expect(mockSettings.instances.filter((item) => item.name === "Chat model")).toHaveLength(2)
    );
    const refreshedReasoning = mockSettings.instances
      .filter((item) => item.name === "Reasoning effort")
      .at(-1)!.controls[0];
    mockSettings.instances
      .filter((item) => item.name === "Chat model")
      .at(-1)!
      .controls[0].change("second-model");
    await vi.waitFor(() => expect(getSettings().chat.modelId).toBe("second-model"));
    expect(getSettings().chat.reasoningEffort).toBe("xhigh");
    expect([...refreshedReasoning.options.keys()]).toEqual([...reasoning.options.keys()]);
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

  it("flushes valid text drafts on hide without waiting for blur", async () => {
    const { tab, getSettings } = setup();
    setting("Temperature").controls[0].change("0.6");
    tab.hide();
    await vi.waitFor(() => expect(getSettings().chat.temperature).toBe(0.6));
  });

  it("keeps the saved text value when an invalid draft is flushed on hide", async () => {
    const { tab, plugin, getSettings } = setup();
    const original = getSettings().chat.temperature;
    setting("Temperature").controls[0].change("2");
    tab.hide();
    await Promise.resolve();
    expect(getSettings().chat.temperature).toBe(original);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it.each(["model", "dimensions", "endpoint"] as const)(
    "confirms before saving an indexed embedding %s change, then recommends explicit clearing",
    async (field) => {
      const initial = {
        ...DEFAULT_SETTINGS,
        embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-old" },
      };
      const { plugin, getSettings } = setup(initial, undefined, true);
      if (field === "model") setting("Embedding model").controls[0].change("embed-new");
      if (field === "dimensions") {
        const dimensions = setting("Embedding dimensions").controls[0];
        dimensions.change("1024");
        dimensions.inputEl.fire("keydown", { key: "Enter", preventDefault: vi.fn() });
      }
      if (field === "endpoint") {
        const endpoint = setting("Embedding endpoint").controls[0];
        endpoint.change("http://127.0.0.1:1235/v1");
        endpoint.inputEl.fire("blur");
      }
      await vi.waitFor(() => expect((Modal as any).instances).toHaveLength(1));
      expect(plugin.saveSettings).not.toHaveBeenCalled();
      expect((Modal as any).instances[0].title).toContain("Clear index and embedding cache");
      resolveEmbeddingConfirmation("Save changes");
      await vi.waitFor(() => expect(plugin.saveSettings).toHaveBeenCalledOnce());
      expect((Modal as any).instances[0].opened).toBe(false);
      expect((Notice as any).instances.at(-1).message).toContain(
        "Clear the index and embedding cache"
      );
      expect(plugin.rebuildIndex).not.toHaveBeenCalled();
      expect(plugin.clearIndex).not.toHaveBeenCalled();
      if (field === "model") expect(getSettings().embedding.modelId).toBe("embed-new");
      if (field === "dimensions") expect(getSettings().embedding.dimensions).toBe(1024);
      if (field === "endpoint")
        expect(getSettings().embedding.endpoint).toBe("http://127.0.0.1:1235/v1");
    }
  );

  it("keeps a cancelled embedding draft and saved settings unchanged", async () => {
    const initial = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-old" },
    };
    const { tab, plugin, getSettings } = setup(initial, undefined, true);
    const dimensions = setting("Embedding dimensions").controls[0];
    dimensions.change("1024");
    dimensions.inputEl.fire("keydown", { key: "Enter", preventDefault: vi.fn() });
    await vi.waitFor(() => expect((Modal as any).instances).toHaveLength(1));
    resolveEmbeddingConfirmation("Cancel");
    await Promise.resolve();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(getSettings()).toEqual(initial);
    tab.display();
    expect(setting("Embedding dimensions").controls[0].value).toBe("1024");
  });

  it("confirms a profile change during the first active index run", async () => {
    const initial = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-old" },
    };
    const { plugin, getSettings } = setup(initial, undefined, false, true);
    expect(plugin.hasIndexedNotes).toBe(false);
    setting("Embedding model").controls[0].change("embed-new");
    await vi.waitFor(() => expect((Modal as any).instances).toHaveLength(1));
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    resolveEmbeddingConfirmation("Cancel");
    await Promise.resolve();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(getSettings()).toEqual(initial);
  });

  it.each(["blur", "Enter"])(
    "saves an accepted %s confirmation after settings hides",
    async (trigger) => {
      const initial = {
        ...DEFAULT_SETTINGS,
        embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-old" },
      };
      const { tab, plugin, getSettings } = setup(initial, undefined, true);
      const dimensions = setting("Embedding dimensions").controls[0];
      dimensions.change("1024");
      dimensions.inputEl.fire(trigger === "blur" ? "blur" : "keydown", {
        key: "Enter",
        preventDefault: vi.fn(),
      });
      await vi.waitFor(() => expect((Modal as any).instances).toHaveLength(1));
      tab.hide();
      resolveEmbeddingConfirmation("Save changes");
      await vi.waitFor(() => expect(getSettings().embedding.dimensions).toBe(1024));
      expect(plugin.saveSettings).toHaveBeenCalledOnce();
    }
  );

  it("treats native modal close as cancel and lets hide flush finish afterward", async () => {
    const initial = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-old" },
    };
    const { tab, plugin, getSettings } = setup(initial, undefined, true);
    const dimensions = setting("Embedding dimensions").controls[0];
    dimensions.change("1024");
    dimensions.inputEl.fire("keydown", { key: "Enter", preventDefault: vi.fn() });
    await vi.waitFor(() => expect((Modal as any).instances).toHaveLength(1));

    (Modal as any).instances[0].close();
    await vi.waitFor(() => expect(plugin.saveSettings).not.toHaveBeenCalled());
    expect(getSettings()).toEqual(initial);

    tab.hide();
    await vi.waitFor(() => expect((Modal as any).instances).toHaveLength(2));
    resolveEmbeddingConfirmation("Save changes");
    await vi.waitFor(() => expect(getSettings().embedding.dimensions).toBe(1024));
    expect(plugin.saveSettings).toHaveBeenCalledOnce();
  });

  it("reverts a cancelled model selection to the saved value", async () => {
    const initial = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-old" },
    };
    const { plugin } = setup(initial, undefined, true);
    const model = setting("Embedding model").controls[0];
    model.change("embed-new");
    await vi.waitFor(() => expect((Modal as any).instances).toHaveLength(1));
    resolveEmbeddingConfirmation("Cancel");
    await vi.waitFor(() => expect(model.value).toBe("embed-old"));
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("flushes both pending embedding text fields on hide and confirms each current profile change", async () => {
    const initial = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-current" },
    };
    const { tab, getSettings } = setup(initial, undefined, true);
    const endpoint = setting("Embedding endpoint").controls[0];
    const dimensions = setting("Embedding dimensions").controls[0];
    endpoint.change("http://127.0.0.1:1235/v1");
    dimensions.change("1024");
    tab.hide();

    await vi.waitFor(() => expect((Modal as any).instances).toHaveLength(1));
    expect(getSettings().embedding.endpoint).toBe(initial.embedding.endpoint);
    resolveEmbeddingConfirmation("Save changes");
    await vi.waitFor(() =>
      expect(getSettings().embedding.endpoint).toBe("http://127.0.0.1:1235/v1")
    );
    await vi.waitFor(() => expect((Modal as any).instances).toHaveLength(2));
    expect(getSettings().embedding.dimensions).toBe(initial.embedding.dimensions);
    resolveEmbeddingConfirmation("Save changes");
    await vi.waitFor(() => expect(getSettings().embedding.dimensions).toBe(1024));
  });

  it("does not save a modal change after external settings replace its source profile", async () => {
    const initial = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-old" },
    };
    const { tab, plugin, getSettings, setSettings } = setup(initial, undefined, true);
    setting("Embedding model").controls[0].change("embed-local");
    await vi.waitFor(() => expect((Modal as any).instances).toHaveLength(1));
    const external = {
      ...initial,
      embedding: { ...initial.embedding, modelId: "embed-synced" },
    };
    setSettings(external);
    tab.refreshExternalSettings();
    resolveEmbeddingConfirmation("Save changes");
    await Promise.resolve();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(getSettings().embedding.modelId).toBe("embed-synced");
    expect(
      mockSettings.instances.filter((item) => item.name === "Embedding model").at(-1)?.controls[0]
        .value
    ).toBe("embed-synced");
  });

  it("skips confirmation for first model setup, chat changes, equivalent profiles, and invalid text", async () => {
    const first = setup(DEFAULT_SETTINGS, undefined, true);
    setting("Embedding model").controls[0].change("embed-first");
    await vi.waitFor(() => expect(first.getSettings().embedding.modelId).toBe("embed-first"));
    expect((Modal as any).instances).toHaveLength(0);

    mockSettings.instances = [];
    (Modal as any).instances = [];
    const emptyIndexInitial = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-old" },
    };
    const emptyIndex = setup(emptyIndexInitial, undefined, false);
    setting("Embedding model").controls[0].change("embed-new");
    await vi.waitFor(() => expect(emptyIndex.getSettings().embedding.modelId).toBe("embed-new"));
    expect((Modal as any).instances).toHaveLength(0);

    mockSettings.instances = [];
    (Modal as any).instances = [];
    const initial = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-existing" },
    };
    const current = setup(initial, undefined, true);
    setting("Temperature").controls[0].change("0.4");
    setting("Temperature").controls[0].inputEl.fire("blur");
    await vi.waitFor(() => expect(current.getSettings().chat.temperature).toBe(0.4));
    const endpoint = setting("Embedding endpoint").controls[0];
    endpoint.change("http://127.0.0.1:1234/v1/");
    endpoint.inputEl.fire("blur");
    await vi.waitFor(() => expect(current.plugin.saveSettings).toHaveBeenCalledTimes(2));
    const dimensions = setting("Embedding dimensions").controls[0];
    dimensions.change("nope");
    dimensions.inputEl.fire("blur");
    await Promise.resolve();
    expect((Modal as any).instances).toHaveLength(0);
    expect(current.plugin.saveSettings).toHaveBeenCalledTimes(2);
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

  it("uses the same confirmation for LAN approval that changes the embedding profile", async () => {
    const initial = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-current" },
    };
    const { plugin, getSettings } = setup(initial, undefined, true);
    setting("Embedding endpoint").controls[0].change("http://192.168.1.20:8080/v1");
    mockSettings.instances
      .filter((item) => item.name === "Endpoint trust")
      .at(-1)!
      .controls[0].click();
    await vi.waitFor(() => expect((Modal as any).instances).toHaveLength(1));
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    resolveEmbeddingConfirmation("Save changes");
    await vi.waitFor(() => expect(getSettings().approvedOrigins).toHaveLength(1));
    expect(getSettings().embedding.endpoint).toBe("http://192.168.1.20:8080/v1");
    expect(plugin.saveSettings).toHaveBeenCalledOnce();
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

  it("invalidates pending draft and discovery callbacks when settings sync refreshes the tab", async () => {
    const { tab, plugin, getSettings } = setup({
      ...DEFAULT_SETTINGS,
      chat: { ...DEFAULT_SETTINGS.chat, modelId: "saved-model" },
    });
    let resolveModels!: (models: readonly string[]) => void;
    vi.mocked(plugin.discoverModels).mockReturnValue(
      new Promise((resolve) => (resolveModels = resolve))
    );
    const oldTemperature = setting("Temperature").controls[0];
    oldTemperature.change("0.9");
    setting("Chat model").controls[1].click();
    await plugin.saveSettings((current) => ({
      ...current,
      chat: { ...current.chat, modelId: "synced-model", temperature: 0.4 },
    }));
    tab.refreshExternalSettings();
    oldTemperature.inputEl.fire("blur");
    resolveModels(["stale-model"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(getSettings().chat).toMatchObject({ modelId: "synced-model", temperature: 0.4 });
    const modelRow = mockSettings.instances.filter((item) => item.name === "Chat model").at(-1)!;
    expect(modelRow.controls[0].value).toBe("synced-model");
    expect(modelRow.controls[0].options.has("stale-model")).toBe(false);
  });

  it("scopes discovered choices to the current endpoint and clears them on failure", async () => {
    const debugError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { plugin } = setup(
      {
        ...DEFAULT_SETTINGS,
        chat: { ...DEFAULT_SETTINGS.chat, modelId: "saved-model" },
      },
      new ConsoleDebug(() => true)
    );
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
    expect(debugError).toHaveBeenCalledOnce();
    expect(debugError.mock.calls[0][1]).toMatchObject({ message: "endpoint B is unavailable" });
    debugError.mockRestore();
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
    const clear = setting("Clear index and embedding cache").controls.find(
      (control) => control.value === "Clear index and cache"
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

  it("discards pending text callbacks when synchronized settings replace the form", async () => {
    const { tab, plugin, getSettings } = setup();
    const temperature = setting("Temperature").controls[0];
    temperature.change("0.8");
    (getSettings() as any).chat.temperature = 0.4;
    tab.refreshExternalSettings();
    temperature.inputEl.fire("blur");
    await Promise.resolve();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(getSettings().chat.temperature).toBe(0.4);
  });
});
