import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/settings/Settings";
import { projectSettingsWithDraft } from "@/ui/settings/SettingsTab";

describe("Settings tab module", () => {
  describe("projectSettingsWithDraft()", () => {
    it("keeps character-by-character endpoint edits local until the projected save", () => {
      const draft = {
        chatEndpoint: "http://127.0.0.1:1234/v1",
        chatModelId: "chat-v2",
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
});
