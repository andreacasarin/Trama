import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/settings/Settings";
import {
  projectSettingsWithDraft,
  validateChatDraft,
  type SettingsDraft,
} from "@/ui/settings/SettingsTab";

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
  lenteAutomaticSearchDelayMs: 0,
  filoExcludedPaths: [],
  ...overrides,
});

describe("settings projection", () => {
  it("normalizes one complete draft without mutating current settings", () => {
    const projected = projectSettingsWithDraft(
      DEFAULT_SETTINGS,
      draft({
        chatEndpoint: "http://127.0.0.1:5678/v1",
        chatModelId: "chat-v2",
        embeddingEndpoint: "http://127.0.0.1:4321/v1",
        embeddingModelId: "embed-v2",
        lenteSearchMethod: "keyword",
        lenteMaxResults: 35,
        filoExcludedPaths: [" ./Projects\\Private/ "],
      })
    );

    expect(DEFAULT_SETTINGS.chat.endpoint).toBe("http://127.0.0.1:1234/v1");
    expect(projected).toMatchObject({
      chat: { endpoint: "http://127.0.0.1:5678/v1", modelId: "chat-v2" },
      embedding: { endpoint: "http://127.0.0.1:4321/v1", modelId: "embed-v2" },
      lente: { searchMethod: "keyword", maxResults: 35 },
      filo: { automaticUpdates: false, excludedPaths: ["Projects/Private"] },
    });
  });

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
