import { PluginSettingTab, Setting } from "obsidian";
import { Plugin } from "obsidian";
import { EndpointApproval } from "@/security/EndpointPolicy";
import { TramaSettings } from "@/settings/Settings";

/** Callbacks supplied by composition to keep settings UI independent of runtime wiring. */
export interface SettingsTabCallbacks {
  getSettings(): TramaSettings;
  saveSettings?(
    settings: TramaSettings | ((current: TramaSettings) => TramaSettings)
  ): Promise<void>;
  updateChatEndpoint(value: string): Promise<void>;
  updateChatModel(value: string): Promise<void>;
  updateEmbeddingEndpoint(value: string): Promise<void>;
  updateEmbeddingModel(value: string): Promise<void>;
  addApprovedOrigin(endpoint: string): Promise<void>;
  removeApprovedOrigin(origin: EndpointApproval): Promise<void>;
  discoverModels(target: "chat" | "embedding"): Promise<readonly string[]>;
  getIndexStatusMessage(): string;
}

export interface SettingsDraft {
  chatEndpoint: string;
  chatModelId: string;
  chatTemperature: number;
  chatMaxOutputTokens: number;
  chatReasoningEffort: string;
  embeddingEndpoint: string;
  embeddingModelId: string;
}

const REASONING_EFFORTS = ["auto", "none", "low", "medium", "high"] as const;

/** Returns the first invalid chat-control draft value, or an empty string. */
export function validateChatDraft(draft: SettingsDraft): string {
  if (
    !Number.isFinite(draft.chatTemperature) ||
    draft.chatTemperature < 0 ||
    draft.chatTemperature > 1 ||
    !Number.isInteger(draft.chatTemperature * 10)
  )
    return "Temperature must be from 0 to 1 in increments of 0.1.";
  if (
    !Number.isSafeInteger(draft.chatMaxOutputTokens) ||
    draft.chatMaxOutputTokens < 0 ||
    draft.chatMaxOutputTokens > 131_072 ||
    draft.chatMaxOutputTokens % 1024 !== 0
  )
    return "Maximum generated-output tokens must be Auto or a multiple of 1024 up to 131072.";
  if (!REASONING_EFFORTS.includes(draft.chatReasoningEffort as (typeof REASONING_EFFORTS)[number]))
    return "Reasoning effort must be Auto, None, Low, Medium, or High.";
  return "";
}

/** Projects locally edited endpoint and model fields onto the current persisted settings. */
export function projectSettingsWithDraft(
  settings: TramaSettings,
  draft: SettingsDraft
): TramaSettings {
  const chat = { ...settings.chat, endpoint: draft.chatEndpoint, modelId: draft.chatModelId };
  chat.temperature = draft.chatTemperature;
  if (draft.chatMaxOutputTokens) chat.maxOutputTokens = draft.chatMaxOutputTokens;
  else delete chat.maxOutputTokens;
  if (draft.chatReasoningEffort !== "auto")
    chat.reasoningEffort = draft.chatReasoningEffort as "low" | "medium" | "high";
  else delete chat.reasoningEffort;
  return {
    ...settings,
    chat,
    embedding: {
      ...settings.embedding,
      endpoint: draft.embeddingEndpoint,
      modelId: draft.embeddingModelId,
    },
  };
}

/** Presents independent LM Studio configuration and explicit endpoint/model actions. */
export class TramaSettingsTab extends PluginSettingTab {
  private errorMessage = "";
  private draft?: SettingsDraft;
  private readonly discoveredModels: Partial<Record<"chat" | "embedding", readonly string[]>> = {};
  private readonly discoveryRevisions: Record<"chat" | "embedding", number> = {
    chat: 0,
    embedding: 0,
  };
  constructor(
    app: ConstructorParameters<typeof PluginSettingTab>[0],
    private readonly controller: Plugin & Partial<SettingsTabCallbacks>
  ) {
    super(app, controller);
  }
  override display(): void {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "Trama" });
    this.containerEl.createEl("p", {
      text: "LM Studio is contacted only after an explicit action.",
    });
    const settings = this.controller.getSettings?.();
    if (!settings) return;
    const draft = (this.draft ??= {
      chatEndpoint: settings.chat.endpoint,
      chatModelId: settings.chat.modelId,
      chatTemperature: settings.chat.temperature ?? 0.7,
      chatMaxOutputTokens: settings.chat.maxOutputTokens ?? 0,
      chatReasoningEffort: settings.chat.reasoningEffort ?? "auto",
      embeddingEndpoint: settings.embedding.endpoint,
      embeddingModelId: settings.embedding.modelId,
    });
    this.text("Voce endpoint", draft.chatEndpoint, (value) => {
      draft.chatEndpoint = value;
    });
    this.text("Voce model", draft.chatModelId, (value) => {
      draft.chatModelId = value;
    });
    this.chatControls(draft);
    this.text("Embedding endpoint", draft.embeddingEndpoint, (value) => {
      draft.embeddingEndpoint = value;
    });
    this.text("Embedding model", draft.embeddingModelId, (value) => {
      draft.embeddingModelId = value;
    });
    new Setting(this.containerEl).addButton((button) =>
      button.setButtonText("Save").onClick(
        () =>
          void this.run(async () => {
            const draftSnapshot = { ...draft };
            const validation = validateChatDraft(draftSnapshot);
            if (validation) throw new Error(validation);
            await this.controller.saveSettings?.((current) =>
              projectSettingsWithDraft(current, draftSnapshot)
            );
            this.draft = undefined;
          })
      )
    );
    let approvalInput = "";
    new Setting(this.containerEl)
      .setName("Approved LAN origins")
      .setDesc("Warning: note excerpts leave this device for the approved LAN host.")
      .addText((text) => {
        text.setPlaceholder("http://192.168.1.20:1234/v1");
        text.onChange((value) => {
          approvalInput = value;
        });
      })
      .addButton((button) =>
        button
          .setButtonText("Approve")
          .onClick(() => void this.run(() => this.controller.addApprovedOrigin?.(approvalInput)))
      );
    for (const origin of settings.approvedOrigins)
      new Setting(this.containerEl)
        .setName(`${origin.scheme}://${origin.host}:${origin.port}`)
        .addButton((button) =>
          button
            .setButtonText("Remove")
            .onClick(() => void this.run(() => this.controller.removeApprovedOrigin?.(origin)))
        );
    for (const target of ["chat", "embedding"] as const)
      new Setting(this.containerEl)
        .setName(`${target === "chat" ? "Voce" : "Embedding"} model discovery`)
        .setDesc("Queries LM Studio only when you click Discover.")
        .addButton((button) =>
          button
            .setButtonText(`Discover ${target === "chat" ? "Voce" : "Embedding"} Models`)
            .onClick(
              () =>
                void this.run(async () => {
                  const revision = ++this.discoveryRevisions[target];
                  const models = (await this.controller.discoverModels?.(target)) ?? [];
                  if (revision === this.discoveryRevisions[target])
                    this.discoveredModels[target] = models;
                })
            )
        );
    for (const target of ["chat", "embedding"] as const) {
      const models = this.discoveredModels[target];
      if (!models) continue;
      this.containerEl.createEl("p", {
        text: `${target === "chat" ? "Voce" : "Embedding"} models: ${models.length ? "" : "No models discovered."}`,
      });
      for (const modelId of models) {
        const row = this.containerEl.createDiv({ text: modelId });
        const select = row.createEl("button", { text: `Use for ${target}` });
        select.addEventListener("click", () => {
          if (target === "chat") draft.chatModelId = modelId;
          else draft.embeddingModelId = modelId;
          this.display();
        });
      }
    }
    new Setting(this.containerEl)
      .setName("Filo index")
      .setDesc(this.controller.getIndexStatusMessage?.() ?? "Not initialized");
    if (this.errorMessage)
      this.containerEl.createEl("p", { text: this.errorMessage, cls: "mod-warning" });
  }
  private text(name: string, value: string, update: (value: string) => void): void {
    new Setting(this.containerEl).setName(name).addText((text) => {
      text.setValue(value);
      text.onChange(update);
    });
  }

  private chatControls(draft: SettingsDraft): void {
    new Setting(this.containerEl)
      .setName("Temperature")
      .setDesc("Controls response variability from 0 to 1.")
      .addSlider((slider) => {
        slider.setLimits(0, 1, 0.1);
        slider.setValue(draft.chatTemperature);
        slider.setDynamicTooltip();
        slider.onChange((value) => {
          draft.chatTemperature = value;
        });
      });
    new Setting(this.containerEl)
      .setName("Maximum generated-output tokens")
      .setDesc("0 is Auto. Reasoning tokens count toward this limit where applicable.")
      .addSlider((slider) => {
        slider.setLimits(0, 131_072, 1024);
        slider.setValue(draft.chatMaxOutputTokens);
        slider.setDynamicTooltip();
        slider.onChange((value) => {
          draft.chatMaxOutputTokens = value;
        });
      });
    new Setting(this.containerEl)
      .setName("Reasoning effort")
      .setDesc("Auto uses the model default; available effort levels depend on the selected model.")
      .addDropdown((dropdown) => {
        for (const value of REASONING_EFFORTS)
          dropdown.addOption(value, value[0].toUpperCase() + value.slice(1));
        dropdown.setValue(draft.chatReasoningEffort);
        dropdown.onChange((value) => {
          draft.chatReasoningEffort = value;
        });
      });
  }
  private async run(action: () => Promise<void> | undefined): Promise<void> {
    try {
      await action();
      this.errorMessage = "";
      this.display();
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.display();
    }
  }
}
