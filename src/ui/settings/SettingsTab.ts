import { PluginSettingTab, Setting } from "obsidian";
import { Plugin } from "obsidian";
import { EndpointApproval } from "@/security/EndpointPolicy";
import {
  normalizeExcludedPaths,
  normalizeExcludedPath,
  type LenteSearchMethod,
  TramaSettings,
} from "@/settings/Settings";

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
  exportSnapshot?(): Promise<unknown>;
  importSnapshot?(bytes: ArrayBuffer, sha256?: string): Promise<void>;
  addApprovedOrigin(endpoint: string): Promise<void>;
  removeApprovedOrigin(origin: EndpointApproval): Promise<void>;
  discoverModels(target: "chat" | "embedding"): Promise<readonly string[]>;
}

export interface SettingsDraft {
  chatEndpoint: string;
  chatModelId: string;
  chatTemperature: number;
  chatMaxOutputTokens: number;
  chatReasoningEffort: string;
  embeddingEndpoint: string;
  embeddingModelId: string;
  lenteSearchMethod: LenteSearchMethod;
  lenteMaxResults: number;
  lenteAutomaticSearchDelayMs: number;
  filoExcludedPaths: readonly string[];
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
    lente: {
      searchMethod: draft.lenteSearchMethod,
      maxResults: draft.lenteMaxResults,
      automaticSearchDelayMs: draft.lenteAutomaticSearchDelayMs,
    },
    filo: {
      automaticUpdates: false,
      excludedPaths: normalizeExcludedPaths(draft.filoExcludedPaths),
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
      lenteSearchMethod: settings.lente.searchMethod,
      lenteMaxResults: settings.lente.maxResults,
      lenteAutomaticSearchDelayMs: settings.lente.automaticSearchDelayMs,
      filoExcludedPaths: [...settings.filo.excludedPaths],
    });

    this.sectionHeading("Lente");
    new Setting(this.containerEl)
      .setName("Search method")
      .setDesc("Hybrid combines semantic and keyword search; Keyword only never uses embeddings.")
      .addDropdown((dropdown) => {
        dropdown.addOption("hybrid", "Hybrid");
        dropdown.addOption("keyword", "Keyword only");
        dropdown.setValue(draft.lenteSearchMethod);
        dropdown.onChange((value) => {
          draft.lenteSearchMethod = value as LenteSearchMethod;
        });
      });
    new Setting(this.containerEl)
      .setName("Automatic search delay")
      .setDesc(
        "Search with Lente modal only: 0 keeps explicit Enter/Search submission. Hybrid queries still use LM Studio."
      )
      .addSlider((slider) => {
        slider.setLimits(0, 1000, 50);
        slider.setValue(draft.lenteAutomaticSearchDelayMs);
        slider.setDynamicTooltip();
        slider.onChange((value) => {
          draft.lenteAutomaticSearchDelayMs = value;
        });
      });
    new Setting(this.containerEl)
      .setName("Maximum displayed results")
      .setDesc("Controls how many unique notes Lente displays.")
      .addSlider((slider) => {
        slider.setLimits(5, 50, 5);
        slider.setValue(draft.lenteMaxResults);
        slider.setDynamicTooltip();
        slider.onChange((value) => {
          draft.lenteMaxResults = value;
        });
      });

    this.sectionHeading("Voce");
    this.text("Chat endpoint", draft.chatEndpoint, (value) => {
      draft.chatEndpoint = value;
    });
    this.modelSelector("chat", draft);
    this.chatControls(draft);

    this.sectionHeading("Filo");
    this.text("Embedding endpoint", draft.embeddingEndpoint, (value) => {
      draft.embeddingEndpoint = value;
    });
    this.modelSelector("embedding", draft);
    this.exclusions(draft);

    this.sectionHeading("Advanced");
    this.advanced(settings);
    if (this.errorMessage)
      this.containerEl.createEl("p", { text: this.errorMessage, cls: "mod-warning" });
    const saveButton = this.containerEl.createEl("button", { text: "Save", cls: "mod-cta" });
    saveButton.addEventListener(
      "click",
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
    );
  }

  override hide(): void {
    // Drafts intentionally survive a temporary Settings hide/reopen.
  }
  private text(name: string, value: string, update: (value: string) => void): void {
    new Setting(this.containerEl).setName(name).addText((text) => {
      text.setValue(value);
      text.onChange(update);
    });
  }

  private modelSelector(target: "chat" | "embedding", draft: SettingsDraft): void {
    const isChat = target === "chat";
    const selectedModel = isChat ? draft.chatModelId : draft.embeddingModelId;
    const discoveredModels = this.discoveredModels[target] ?? [];
    const models = selectedModel
      ? [selectedModel, ...discoveredModels.filter((modelId) => modelId !== selectedModel)]
      : discoveredModels;
    new Setting(this.containerEl)
      .setName(isChat ? "AI model" : "Embedding model")
      .setDesc(
        isChat
          ? "Click Discover to query LM Studio, then choose an AI model."
          : "Used by Filo indexing and Hybrid Lente search; changing it requires a full reindex. Click Discover to query LM Studio."
      )
      .addDropdown((dropdown) => {
        if (!selectedModel) dropdown.addOption("", "Select a model");
        for (const modelId of models) dropdown.addOption(modelId, modelId);
        dropdown.setValue(selectedModel);
        dropdown.onChange((value) => {
          if (isChat) draft.chatModelId = value;
          else draft.embeddingModelId = value;
        });
      })
      .addButton((button) =>
        button.setButtonText("Discover").onClick(
          () =>
            void this.run(async () => {
              const revision = ++this.discoveryRevisions[target];
              const models = (await this.controller.discoverModels?.(target)) ?? [];
              if (revision === this.discoveryRevisions[target])
                this.discoveredModels[target] = models;
            })
        )
      );
  }

  private sectionHeading(name: string): void {
    new Setting(this.containerEl).setName(name).setHeading();
  }

  private exclusions(draft: SettingsDraft): void {
    let input = "";
    new Setting(this.containerEl)
      .setName("Excluded files and directories")
      .setDesc(
        "Vault-relative paths omitted from the Filo index and Lente search. After changing this list, reindex the vault to apply it."
      )
      .addText((text) => {
        text.setPlaceholder("Projects/Private");
        text.onChange((value) => {
          input = value;
        });
      })
      .addButton((button) =>
        button.setButtonText("Add").onClick(() => {
          void this.run(async () => {
            const normalized = normalizeExcludedPath(input);
            if (!normalized)
              throw new Error("Enter a valid vault-relative file or directory path.");
            draft.filoExcludedPaths = normalizeExcludedPaths([
              ...draft.filoExcludedPaths,
              normalized,
            ]);
            input = "";
          });
        })
      );
    for (const path of draft.filoExcludedPaths)
      new Setting(this.containerEl).setName(path).addButton((button) =>
        button.setButtonText("Remove").onClick(() => {
          draft.filoExcludedPaths = draft.filoExcludedPaths.filter((value) => value !== path);
          this.display();
        })
      );
  }

  private advanced(settings: TramaSettings): void {
    new Setting(this.containerEl)
      .setName("SQLite index snapshot")
      .setDesc(
        "Explicitly export an immutable backup, or import a selected backup. Imported indexes remain incomplete until Update or Rebuild index."
      )
      .addButton((button) =>
        button
          .setButtonText("Export snapshot")
          .onClick(() => void this.run(() => this.controller.exportSnapshot?.()))
      )
      .addButton((button) =>
        button.setButtonText("Import snapshot").onClick(() => {
          const input = this.containerEl.createEl("input", { type: "file" });
          input.setAttribute("accept", ".sqlite3,.sqlite");
          input.hidden = true;
          input.addEventListener("change", () => {
            const file = (input as HTMLInputElement).files?.[0];
            if (!file) return;
            void this.run(async () => {
              const match = file.name.match(/^([0-9a-f]{64})\.sqlite3$/i);
              await this.controller.importSnapshot?.(await file.arrayBuffer(), match?.[1]);
            });
          });
          input.click();
        })
      );
    new Setting(this.containerEl)
      .setName("Detailed debugging")
      .setDesc(
        "Warning: detailed console diagnostics include sensitive rich chat data (full prompts, selected-note contents, requests/SSE events, tool arguments/results/errors) plus index metadata (paths, counts, timings, generation/status). No diagnostic file is created."
      )
      .addToggle((toggle) => {
        toggle.setValue(settings.detailedDebug);
        toggle.onChange(
          (detailedDebug) =>
            void this.run(() =>
              this.controller.saveSettings?.((current) => ({ ...current, detailedDebug }))
            )
        );
      });
    let approvalInput = "";
    new Setting(this.containerEl)
      .setName("Approved LAN origins")
      .setDesc(
        "Approved origins allow note excerpts to leave this device for a LAN host. Add only hosts you trust; LAN endpoints require explicit approval."
      )
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
  private async run(action: () => Promise<unknown> | undefined): Promise<void> {
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
