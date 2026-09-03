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
  textControls: Array<{ emit(value: string): void }>;
  sliderControls: Array<{
    value: number;
    limits?: { min: number; max: number; step: number };
    dynamicTooltip: boolean;
    emit(value: number): void;
  }>;
  dropdownControls: Array<{ options: Record<string, string>; emit(value: string): void }>;
  buttonControls: Array<{ text: string; click(): void }>;
}

function settingInstances(): SettingInstance[] {
  return (Setting as unknown as { instances: SettingInstance[] }).instances;
}

const draft = (overrides: Partial<SettingsDraft> = {}): SettingsDraft => ({
  chatEndpoint: DEFAULT_SETTINGS.chat.endpoint,
  chatModelId: "chat-v1",
  chatTemperature: 0.7,
  chatMaxOutputTokens: 0,
  chatReasoningEffort: "auto",
  embeddingEndpoint: DEFAULT_SETTINGS.embedding.endpoint,
  embeddingModelId: "embed-v1",
  ...overrides,
});

function controller(saveSettings = vi.fn().mockResolvedValue(undefined)) {
  return {
    getSettings: () => DEFAULT_SETTINGS,
    saveSettings,
    updateChatEndpoint: vi.fn().mockResolvedValue(undefined),
    updateChatModel: vi.fn().mockResolvedValue(undefined),
    updateEmbeddingEndpoint: vi.fn().mockResolvedValue(undefined),
    updateEmbeddingModel: vi.fn().mockResolvedValue(undefined),
    addApprovedOrigin: vi.fn().mockResolvedValue(undefined),
    removeApprovedOrigin: vi.fn().mockResolvedValue(undefined),
    discoverModels: vi.fn().mockResolvedValue([]),
    getIndexStatusMessage: () => "Ready",
  };
}

describe("Settings tab module", () => {
  beforeEach(() => {
    settingInstances().length = 0;
  });

  describe("projectSettingsWithDraft()", () => {
    it("keeps character-by-character endpoint edits local until the projected save", () => {
      const draft = {
        chatEndpoint: "http://127.0.0.1:1234/v1",
        chatModelId: "chat-v2",
        chatTemperature: 0.7,
        chatMaxOutputTokens: 0,
        chatReasoningEffort: "auto",
        embeddingEndpoint: "http://127.0.0.1:4321/v1",
        embeddingModelId: "embed-v2",
      };
      const oldEndpoint = projectSettingsWithDraft(DEFAULT_SETTINGS, draft);
      draft.chatEndpoint = "http://127.0.0.1:5678/v1";

      expect(DEFAULT_SETTINGS.chat.endpoint).toBe("http://127.0.0.1:1234/v1");
      expect(oldEndpoint.chat.endpoint).toBe("http://127.0.0.1:1234/v1");
      expect(projectSettingsWithDraft(DEFAULT_SETTINGS, draft)).toMatchObject({
        chat: { endpoint: "http://127.0.0.1:5678/v1", modelId: "chat-v2" },
        embedding: { endpoint: "http://127.0.0.1:4321/v1", modelId: "embed-v2" },
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
    ])(
      "rejects %s (https://github.com/logancyang/obsidian-copilot/issues/3077)",
      (_name, values) => {
        expect(validateChatDraft(draft(values))).not.toBe("");
      }
    );

    it.each([0, 0.7, 1])(
      "accepts temperature slider value %s (https://github.com/logancyang/obsidian-copilot/issues/3077)",
      (chatTemperature) => {
        expect(validateChatDraft(draft({ chatTemperature, chatMaxOutputTokens: 131072 }))).toBe("");
      }
    );
  });

  describe("TramaSettingsTab", () => {
    it("renders control labels, descriptions, and all reasoning options", () => {
      const tab = new TramaSettingsTab({} as never, controller() as never);
      tab.display();
      const temperature = settingInstances().find((setting) => setting.name === "Temperature");
      const tokens = settingInstances().find(
        (setting) => setting.name === "Maximum generated-output tokens"
      );
      const effort = settingInstances().find((setting) => setting.name === "Reasoning effort");
      expect(temperature?.sliderControls[0]).toMatchObject({
        value: 0.7,
        limits: { min: 0, max: 1, step: 0.1 },
        dynamicTooltip: true,
      });
      expect(tokens?.description).toContain("Reasoning tokens");
      expect(tokens?.sliderControls[0]).toMatchObject({
        value: 0,
        limits: { min: 0, max: 131072, step: 1024 },
        dynamicTooltip: true,
      });
      expect(effort?.description).toContain("model");
      expect(effort?.dropdownControls[0].options).toEqual({
        auto: "Auto",
        none: "None",
        low: "Low",
        medium: "Medium",
        high: "High",
      });
    });

    it("projects slider values and explicit None without discovery", async () => {
      const saveSettings = vi.fn().mockResolvedValue(undefined);
      const target = controller(saveSettings);
      const tab = new TramaSettingsTab({} as never, target as never);
      tab.display();
      const temperature = settingInstances().find((setting) => setting.name === "Temperature")!;
      const tokens = settingInstances().find(
        (setting) => setting.name === "Maximum generated-output tokens"
      )!;
      const effort = settingInstances().find((setting) => setting.name === "Reasoning effort")!;
      temperature.sliderControls[0].emit(0.4);
      tokens.sliderControls[0].emit(2048);
      effort.dropdownControls[0].emit("none");
      const save = settingInstances().find(
        (setting) => setting.buttonControls[0]?.text === "Save"
      )!;
      save.buttonControls[0].click();
      await Promise.resolve();
      expect(saveSettings).toHaveBeenCalledTimes(1);
      const updater = saveSettings.mock.calls[0][0];
      expect(updater(DEFAULT_SETTINGS)).toMatchObject({
        chat: { temperature: 0.4, maxOutputTokens: 2048, reasoningEffort: "none" },
      });
      expect(target.discoverModels).not.toHaveBeenCalled();
    });

    it("projects a zero output slider value as Auto", async () => {
      const saveSettings = vi.fn().mockResolvedValue(undefined);
      const tab = new TramaSettingsTab({} as never, controller(saveSettings) as never);
      tab.display();
      const tokens = settingInstances().find(
        (setting) => setting.name === "Maximum generated-output tokens"
      )!;
      tokens.sliderControls[0].emit(0);
      const save = settingInstances().find(
        (setting) => setting.buttonControls[0]?.text === "Save"
      )!;
      save.buttonControls[0].click();
      await Promise.resolve();
      expect(saveSettings).toHaveBeenCalledTimes(1);
      const updater = saveSettings.mock.calls[0][0];
      expect(updater(DEFAULT_SETTINGS).chat).toMatchObject({ temperature: 0.7 });
      expect(updater(DEFAULT_SETTINGS).chat).not.toHaveProperty("maxOutputTokens");
    });
  });
});
