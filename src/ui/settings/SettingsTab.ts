import { PluginSettingTab, Setting } from "obsidian";
import { Plugin } from "obsidian";
import { EndpointApproval } from "@/security/EndpointPolicy";
import { LocalVaultAssistantSettings } from "@/settings/Settings";

/** Callbacks supplied by composition to keep settings UI independent of runtime wiring. */
export interface SettingsTabCallbacks {
  getSettings(): LocalVaultAssistantSettings;
  saveSettings?(
    settings:
      | LocalVaultAssistantSettings
      | ((current: LocalVaultAssistantSettings) => LocalVaultAssistantSettings)
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
  embeddingEndpoint: string;
  embeddingModelId: string;
}

/** Projects locally edited endpoint and model fields onto the current persisted settings. */
export function projectSettingsWithDraft(
  settings: LocalVaultAssistantSettings,
  draft: SettingsDraft
): LocalVaultAssistantSettings {
  return {
    ...settings,
    chat: { ...settings.chat, endpoint: draft.chatEndpoint, modelId: draft.chatModelId },
    embedding: {
      ...settings.embedding,
      endpoint: draft.embeddingEndpoint,
      modelId: draft.embeddingModelId,
    },
  };
}

/** Presents independent LM Studio configuration and explicit endpoint/model actions. */
export class LocalVaultAssistantSettingsTab extends PluginSettingTab {
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
    this.containerEl.createEl("h2", { text: "Local Vault Assistant" });
    this.containerEl.createEl("p", {
      text: "LM Studio is contacted only after an explicit action.",
    });
    const settings = this.controller.getSettings?.();
    if (!settings) return;
    const draft = (this.draft ??= {
      chatEndpoint: settings.chat.endpoint,
      chatModelId: settings.chat.modelId,
      embeddingEndpoint: settings.embedding.endpoint,
      embeddingModelId: settings.embedding.modelId,
    });
    this.text("Chat endpoint", draft.chatEndpoint, (value) => {
      draft.chatEndpoint = value;
    });
    this.text("Chat model", draft.chatModelId, (value) => {
      draft.chatModelId = value;
    });
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
        .setName(`${target === "chat" ? "Chat" : "Embedding"} model discovery`)
        .setDesc("Queries LM Studio only when you click Discover.")
        .addButton((button) =>
          button
            .setButtonText(`Discover ${target === "chat" ? "Chat" : "Embedding"} Models`)
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
        text: `${target === "chat" ? "Chat" : "Embedding"} models: ${models.length ? "" : "No models discovered."}`,
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
      .setName("Index")
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
