import { describe, expect, it, vi } from "vitest";
import { Setting } from "obsidian";
import { DEFAULT_SETTINGS } from "@/settings/Settings";
import {
  projectSettingsWithDraft,
  TramaSettingsTab,
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
  lenteAutomaticSearches: false,
  automaticMaintenance: false,
  filoExcludedPaths: [],
  ...overrides,
});

describe("settings projection", () => {
  it("wires Settings Update and Rebuild buttons to required maintenance callbacks", async () => {
    const updateIndex = vi.fn(async () => undefined);
    const rebuildIndex = vi.fn(async () => undefined);
    const stopIndex = vi.fn(async () => undefined);
    const callbacks = new Map<string, () => unknown>();
    const warnings: string[] = [];
    let indexStatus: { kind?: string; message?: string; publicationWarning?: string } | undefined;
    const proto = Setting.prototype as any;
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const chain = [
      "setName",
      "setDesc",
      "setHeading",
      "setPlaceholder",
      "setLimits",
      "setValue",
      "setDynamicTooltip",
    ];
    for (const method of chain) {
      originals.set(method, Object.getOwnPropertyDescriptor(proto, method));
      Object.defineProperty(proto, method, {
        configurable: true,
        value() {
          return this;
        },
      });
    }
    originals.set("addButton", Object.getOwnPropertyDescriptor(proto, "addButton"));
    Object.defineProperty(proto, "addButton", {
      configurable: true,
      value(configure: (button: any) => void) {
        let label = "";
        const button = {
          setButtonText(value: string) {
            label = value;
            return this;
          },
          onClick(callback: () => unknown) {
            callbacks.set(label, callback);
            return this;
          },
        };
        configure(button);
        return this;
      },
    });
    for (const method of ["addToggle", "addDropdown", "addText", "addSlider"]) {
      originals.set(method, Object.getOwnPropertyDescriptor(proto, method));
      Object.defineProperty(proto, method, {
        configurable: true,
        value(configure: (control: any) => void) {
          const control = {
            addOption() {
              return this;
            },
            setLimits() {
              return this;
            },
            setValue() {
              return this;
            },
            setDynamicTooltip() {
              return this;
            },
            onChange() {
              return this;
            },
            setPlaceholder() {
              return this;
            },
          };
          configure(control);
          return this;
        },
      });
    }
    try {
      const tab = new TramaSettingsTab(
        {} as any,
        {
          getSettings: () => DEFAULT_SETTINGS,
          getIndexStatus: () => indexStatus,
          updateIndex,
          rebuildIndex,
          stopIndex,
        } as any
      );
      (tab as any).containerEl = {
        empty() {},
        createEl(_tag: string, options?: { text?: string }) {
          if (options?.text) warnings.push(options.text);
          return {
            addEventListener(_event: string, callback: () => unknown) {
              callbacks.set("Save", callback);
            },
          };
        },
      };
      tab.display();
      await callbacks.get("Update")?.();
      await callbacks.get("Rebuild")?.();
      expect(updateIndex).toHaveBeenCalledOnce();
      expect(rebuildIndex).toHaveBeenCalledOnce();
      expect(callbacks.has("Prepare")).toBe(false);

      indexStatus = { kind: "error", message: "Lexical write failed." };
      await callbacks.get("Update")?.();
      await vi.waitFor(() => expect(warnings).toContain("Lexical write failed."));
      indexStatus = { kind: "error", message: "Semantic service failed." };
      await callbacks.get("Rebuild")?.();
      await vi.waitFor(() => expect(warnings).toContain("Semantic service failed."));
      indexStatus = { publicationWarning: "Index saved locally, but publication failed: offline" };
      await callbacks.get("Update")?.();
      await vi.waitFor(() =>
        expect(warnings).toContain("Index saved locally, but publication failed: offline")
      );
    } finally {
      for (const [method, descriptor] of originals)
        if (descriptor) Object.defineProperty(proto, method, descriptor);
        else delete proto[method];
    }
  });

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
      lente: { searchMethod: "keyword", maxResults: 35, automaticSearches: false },
      filo: { excludedPaths: ["Projects/Private"] },
    });
  });

  it("projects the two opt-in settings independently", () => {
    const projected = projectSettingsWithDraft(
      DEFAULT_SETTINGS,
      draft({ lenteAutomaticSearches: true, automaticMaintenance: true })
    );
    expect(projected.lente.automaticSearches).toBe(true);
    expect(projected.automaticMaintenance).toBe(true);
    expect(projected.filo).not.toHaveProperty("automaticUpdates");
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
