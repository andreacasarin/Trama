import { beforeEach, describe, expect, it, vi } from "vitest";
import { Setting } from "obsidian";
import { DEFAULT_SETTINGS } from "@/settings/Settings";
import {
  projectSettingsWithDraft,
  TramaSettingsTab,
  validateChatDraft,
  type SettingsDraft,
} from "@/ui/settings/SettingsTab";

interface SettingInstance {
  name: string;
  description: string;
  isHeading: boolean;
  textControls: Array<{ emit(value: string): void }>;
  sliderControls: Array<{
    value: number;
    limits?: { min: number; max: number; step: number };
    dynamicTooltip: boolean;
    emit(value: number): void;
  }>;
  dropdownControls: Array<{
    value: string;
    options: Record<string, string>;
    emit(value: string): void;
  }>;
  toggleControls: Array<{ value: boolean; emit(value: boolean): void }>;
  buttonControls: Array<{ text: string; click(): void }>;
}

function settingInstances(): SettingInstance[] {
  return (Setting as unknown as { instances: SettingInstance[] }).instances;
}

function latestSetting(name: string): SettingInstance | undefined {
  return settingInstances()
    .filter((setting) => setting.name === name)
    .at(-1);
}

function saveButton(tab: TramaSettingsTab): { click(): void } {
  const button = (tab.containerEl as any).children.find(
    (child: any) => child.tagName === "button" && child.textContent === "Save"
  );
  expect(button).toBeDefined();
  return button;
}

const draft = (overrides: Partial<SettingsDraft> = {}): SettingsDraft => ({
  chatEndpoint: DEFAULT_SETTINGS.chat.endpoint,
  chatModelId: "chat-v1",
  chatTemperature: 0.7,
  chatMaxOutputTokens: 0,
  chatReasoningEffort: "auto",
  embeddingEndpoint: DEFAULT_SETTINGS.embedding.endpoint,
  embeddingModelId: "embed-v1",
  lenteSearchMethod: "hybrid",
  lenteMaxResults: 20,
  filoExcludedPaths: [],
  ...overrides,
});

function controller(saveSettings = vi.fn().mockResolvedValue(undefined)) {
  return {
    getSettings: () => DEFAULT_SETTINGS,
    saveSettings,
    addApprovedOrigin: vi.fn().mockResolvedValue(undefined),
    removeApprovedOrigin: vi.fn().mockResolvedValue(undefined),
    discoverModels: vi.fn().mockResolvedValue([]),
  };
}

describe("Settings tab module", () => {
  beforeEach(() => {
    settingInstances().length = 0;
  });

  describe("projectSettingsWithDraft()", () => {
    it("keeps local edits local until the projected save", () => {
      const localDraft = draft({
        chatEndpoint: "http://127.0.0.1:5678/v1",
        chatModelId: "chat-v2",
        embeddingEndpoint: "http://127.0.0.1:4321/v1",
        embeddingModelId: "embed-v2",
        lenteSearchMethod: "keyword",
        lenteMaxResults: 35,
        filoExcludedPaths: [" ./Projects\\Private/ "],
      });
      const projected = projectSettingsWithDraft(DEFAULT_SETTINGS, localDraft);

      expect(DEFAULT_SETTINGS.chat.endpoint).toBe("http://127.0.0.1:1234/v1");
      expect(projected).toMatchObject({
        chat: { endpoint: "http://127.0.0.1:5678/v1", modelId: "chat-v2" },
        embedding: { endpoint: "http://127.0.0.1:4321/v1", modelId: "embed-v2" },
        lente: { searchMethod: "keyword", maxResults: 35 },
        filo: { automaticUpdates: false, excludedPaths: ["Projects/Private"] },
      });
    });
  });

  describe("validateChatDraft()", () => {
    it.each([
      ["temperature below range", { chatTemperature: -0.1 }],
      ["temperature above range", { chatTemperature: 1.1 }],
      ["temperature off slider step", { chatTemperature: 0.15 }],
      ["non-finite temperature", { chatTemperature: Number.POSITIVE_INFINITY }],
      ["negative output tokens", { chatMaxOutputTokens: -1024 }],
      ["output tokens off slider step", { chatMaxOutputTokens: 1536 }],
      ["output tokens above maximum", { chatMaxOutputTokens: 132096 }],
      ["invalid reasoning effort", { chatReasoningEffort: "minimal" }],
    ])("rejects %s", (_name, values) => {
      expect(validateChatDraft(draft(values))).not.toBe("");
    });

    it.each([0, 0.7, 1])("accepts temperature slider value %s", (chatTemperature) => {
      expect(validateChatDraft(draft({ chatTemperature, chatMaxOutputTokens: 131072 }))).toBe("");
    });
  });

  describe("TramaSettingsTab", () => {
    it("explains that exclusion changes require reindexing", () => {
      const tab = new TramaSettingsTab({} as never, controller() as never);
      tab.display();

      expect(latestSetting("Excluded files and directories")?.description).toContain(
        "reindex the vault"
      );
    });

    it("renders the four headings in order with Lente controls and an unboxed Save button", () => {
      const tab = new TramaSettingsTab({} as never, controller() as never);
      tab.display();

      expect(
        settingInstances()
          .filter((setting) => setting.isHeading)
          .map((setting) => setting.name)
      ).toEqual(["Lente", "Voce", "Filo", "Advanced"]);
      expect(settingInstances().some((setting) => setting.name === "General")).toBe(false);
      expect(latestSetting("Search method")?.dropdownControls[0]).toMatchObject({
        value: "hybrid",
        options: { hybrid: "Hybrid", keyword: "Keyword only" },
      });
      expect(latestSetting("Maximum displayed results")?.sliderControls[0]).toMatchObject({
        value: 20,
        limits: { min: 5, max: 50, step: 5 },
        dynamicTooltip: true,
      });
      expect(latestSetting("Automatic updates")).toBeUndefined();
      expect(latestSetting("Approved LAN origins")?.description).toContain("leave this device");
      expect((tab.containerEl as any).children.some((child: any) => child.tagName === "p")).toBe(
        false
      );
      expect(
        settingInstances().some((setting) =>
          setting.buttonControls.some((button) => button.text === "Save")
        )
      ).toBe(false);
      expect(saveButton(tab)).toBeDefined();
      expect(settingInstances().some((setting) => setting.name === "Filo index")).toBe(false);
    });

    it("keeps Discover on the same row as each model selector and never discovers on display", () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        chat: { ...DEFAULT_SETTINGS.chat, modelId: "chat-current" },
        embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-current" },
      };
      const target = { ...controller(), getSettings: () => settings };
      new TramaSettingsTab({} as never, target as never).display();

      expect(latestSetting("AI model")).toMatchObject({
        description: expect.stringContaining("Discover"),
        dropdownControls: [{ value: "chat-current", options: { "chat-current": "chat-current" } }],
        buttonControls: [{ text: "Discover" }],
      });
      expect(latestSetting("Embedding model")).toMatchObject({
        description: expect.stringContaining("Filo indexing"),
        dropdownControls: [
          { value: "embed-current", options: { "embed-current": "embed-current" } },
        ],
        buttonControls: [{ text: "Discover" }],
      });
      expect(target.discoverModels).not.toHaveBeenCalled();
    });

    it("discovers only after an explicit action and lets the user choose a model", async () => {
      const target = controller();
      target.discoverModels.mockImplementation(async (kind: "chat" | "embedding") =>
        kind === "chat" ? ["chat-a", "chat-b"] : ["embed-a"]
      );
      const tab = new TramaSettingsTab({} as never, target as never);
      tab.display();

      latestSetting("AI model")!.buttonControls[0].click();
      await vi.waitFor(() => {
        expect(latestSetting("AI model")?.dropdownControls[0].options).toEqual({
          "": "Select a model",
          "chat-a": "chat-a",
          "chat-b": "chat-b",
        });
      });
      expect(latestSetting("Embedding model")?.dropdownControls[0].options).toEqual({
        "": "Select a model",
      });
      latestSetting("AI model")!.dropdownControls[0].emit("chat-b");
      expect(target.discoverModels).toHaveBeenCalledWith("chat");
    });

    it("keeps chat, Lente, Filo, and exclusion edits as drafts until the single Save", async () => {
      const saveSettings = vi.fn().mockResolvedValue(undefined);
      const target = controller(saveSettings);
      const tab = new TramaSettingsTab({} as never, target as never);
      tab.display();

      latestSetting("Search method")!.dropdownControls[0].emit("keyword");
      latestSetting("Maximum displayed results")!.sliderControls[0].emit(35);
      latestSetting("Excluded files and directories")!.textControls[0].emit("./Projects\\Private/");
      latestSetting("Excluded files and directories")!.buttonControls[0].click();
      await vi.waitFor(() => expect(latestSetting("Projects/Private")).toBeDefined());

      saveButton(tab).click();
      await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
      const updater = saveSettings.mock.calls[0][0];
      expect(updater(DEFAULT_SETTINGS)).toMatchObject({
        lente: { searchMethod: "keyword", maxResults: 35 },
        filo: { automaticUpdates: false, excludedPaths: ["Projects/Private"] },
      });
    });

    it("projects chat controls and preserves Auto output tokens", async () => {
      const saveSettings = vi.fn().mockResolvedValue(undefined);
      const target = controller(saveSettings);
      const tab = new TramaSettingsTab({} as never, target as never);
      tab.display();
      latestSetting("Temperature")!.sliderControls[0].emit(0.4);
      latestSetting("Maximum generated-output tokens")!.sliderControls[0].emit(2048);
      latestSetting("Reasoning effort")!.dropdownControls[0].emit("none");
      latestSetting("Maximum generated-output tokens")!.sliderControls[0].emit(0);
      saveButton(tab).click();
      await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
      const updater = saveSettings.mock.calls[0][0];
      expect(updater(DEFAULT_SETTINGS).chat).toMatchObject({ temperature: 0.4 });
      expect(updater(DEFAULT_SETTINGS).chat).not.toHaveProperty("maxOutputTokens");
      expect(updater(DEFAULT_SETTINGS).chat).toMatchObject({ reasoningEffort: "none" });
    });

    it("persists the detailed debugging toggle immediately", async () => {
      const saveSettings = vi.fn().mockResolvedValue(undefined);
      const tab = new TramaSettingsTab({} as never, controller(saveSettings) as never);
      tab.display();

      latestSetting("Detailed debugging")!.toggleControls[0].emit(true);

      await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
      const updater = saveSettings.mock.calls[0][0];
      expect(updater(DEFAULT_SETTINGS)).toMatchObject({ detailedDebug: true });
    });
  });
});
