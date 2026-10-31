import { Modal, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { noteEmbeddingProfile } from "@/index/SqliteNoteVectorStore";
import type { TramaPlugin } from "@/plugin/TramaPlugin";
import type { ConsoleDebug } from "@/plugin/ConsoleDebug";
import { DEFAULT_STORAGE_FOLDER, normalizeStorageFolder } from "@/settings/StorageFolder";
import {
  normalizeReasoningEffort,
  normalizeExcludedFolders,
  REASONING_EFFORTS,
  type ChatSettings,
  type EmbeddingSettings,
  type TramaSettings,
} from "@/settings/Settings";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
interface SettingsDraft {
  consoleDebug: boolean;
  chat: Mutable<ChatSettings>;
  embedding: Mutable<EmbeddingSettings>;
  excludedFolders: string[];
  storageFolder: string;
}
interface ParsedText<T> {
  value: T;
  display: string;
}

export class TramaSettingsTab extends PluginSettingTab {
  private draft?: SettingsDraft;
  private readonly pendingText = new Map<string, string>();
  private readonly flushText: Array<() => Promise<void>> = [];
  private readonly discovered: Record<"chat" | "embedding", readonly string[]> = {
    chat: [],
    embedding: [],
  };
  private readonly resetModelOptions: Partial<Record<"chat" | "embedding", () => void>> = {};
  private displayGeneration = 0;
  private textGeneration = 0;
  private settingsGeneration = 0;
  private readonly discoveryGeneration: Record<"chat" | "embedding", number> = {
    chat: 0,
    embedding: 0,
  };
  private folderRows?: HTMLElement;
  private folderDropdown?: { setValue(value: string): unknown };
  private selectedFolder = "";
  constructor(
    app: any,
    private readonly plugin: TramaPlugin & {
      updateIndex(): Promise<void>;
      rebuildIndex(): Promise<void>;
      stopIndex(): void;
      readonly hasIndexedNotes: boolean;
      readonly hasIndexedOrActiveIndex: boolean;
      discoverModels(target: "chat" | "embedding", endpoint?: string): Promise<readonly string[]>;
    },
    private readonly consoleDebug?: ConsoleDebug
  ) {
    super(app, plugin as unknown as Plugin);
  }

  display(): void {
    const displayGeneration = ++this.displayGeneration;
    this.textGeneration++;
    const { containerEl } = this;
    containerEl.empty();
    this.flushText.length = 0;
    const settings = (this.draft ??= cloneSettings(this.plugin.getSettings()));
    this.heading("Voce");
    this.text(
      "Chat endpoint",
      "chat.endpoint",
      () => this.plugin.getSettings().chat.endpoint,
      settings.chat.endpoint,
      (raw) => {
        if (settings.chat.endpoint !== raw) this.clearDiscoveredModels("chat");
        settings.chat.endpoint = raw;
      },
      (raw) => ({ value: raw, display: raw }),
      async (value) =>
        this.persist((current) => ({ ...current, chat: { ...current.chat, endpoint: value } })),
      "OpenAI-compatible base URL."
    );
    this.modelSetting("chat", settings, displayGeneration);
    this.text(
      "Temperature",
      "chat.temperature",
      () => String(this.plugin.getSettings().chat.temperature),
      String(settings.chat.temperature),
      (raw) => {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) settings.chat.temperature = parsed;
      },
      (raw) => {
        const value = Number(raw);
        return Number.isFinite(value) && value >= 0 && value <= 1
          ? { value, display: String(value) }
          : undefined;
      },
      async (value) =>
        this.persist((current) => ({ ...current, chat: { ...current.chat, temperature: value } }))
    );
    const tokenValue = String(settings.chat.maxOutputTokens ?? "");
    this.text(
      "Maximum output tokens",
      "chat.maxOutputTokens",
      () => String(this.plugin.getSettings().chat.maxOutputTokens ?? ""),
      tokenValue,
      (raw) => {
        const count = Number(raw);
        if (!raw.trim()) delete settings.chat.maxOutputTokens;
        else if (Number.isSafeInteger(count) && count >= 1024)
          settings.chat.maxOutputTokens = count;
      },
      (raw) => {
        if (!raw.trim()) return { value: undefined, display: "" };
        const value = Number(raw);
        return Number.isSafeInteger(value) && value >= 1024
          ? { value, display: String(value) }
          : undefined;
      },
      async (value) =>
        this.persist((current) => {
          const chat = { ...current.chat };
          if (value === undefined) delete chat.maxOutputTokens;
          else chat.maxOutputTokens = value;
          return { ...current, chat };
        }),
      "Leave blank for the model default."
    );
    this.text(
      "Context window tokens",
      "chat.contextWindowTokens",
      () => String(this.plugin.getSettings().chat.contextWindowTokens),
      String(settings.chat.contextWindowTokens),
      (raw) => {
        const count = Number(raw);
        if (Number.isSafeInteger(count) && count > 0) settings.chat.contextWindowTokens = count;
      },
      (raw) => {
        const value = Number(raw);
        return Number.isSafeInteger(value) && value > 0
          ? { value, display: String(value) }
          : undefined;
      },
      async (value) =>
        this.persist((current) => ({
          ...current,
          chat: { ...current.chat, contextWindowTokens: value },
        })),
      "Approximate usable model context, including the reserved output space."
    );
    new Setting(containerEl).setName("Reasoning effort").addDropdown((dropdown) => {
      dropdown.addOption("auto", "Auto");
      for (const value of REASONING_EFFORTS)
        dropdown.addOption(value, value[0].toUpperCase() + value.slice(1));
      dropdown.setValue(settings.chat.reasoningEffort ?? "auto");
      dropdown.onChange((value) => {
        const effort = value === "auto" ? undefined : normalizeReasoningEffort(value);
        if (value !== "auto" && effort === undefined) return;
        void this.persistDiscrete((current) => {
          const chat = { ...current.chat };
          if (effort === undefined) delete chat.reasoningEffort;
          else chat.reasoningEffort = effort;
          return { ...current, chat };
        }).then((saved) => {
          if (saved) {
            if (saved.chat.reasoningEffort === undefined) delete settings.chat.reasoningEffort;
            else settings.chat.reasoningEffort = saved.chat.reasoningEffort;
          }
        });
      });
    });

    this.heading("Lente");
    this.heading("Filo");
    this.text(
      "Embedding endpoint",
      "embedding.endpoint",
      () => this.plugin.getSettings().embedding.endpoint,
      settings.embedding.endpoint,
      (raw) => {
        if (settings.embedding.endpoint !== raw) this.clearDiscoveredModels("embedding");
        settings.embedding.endpoint = raw;
      },
      (raw) => ({ value: raw, display: raw }),
      async (value) =>
        this.persist((current) => ({
          ...current,
          embedding: { ...current.embedding, endpoint: value },
        })),
      "OpenAI-compatible base URL shared by Filo search, related-note suggestions, and Voce."
    );
    this.modelSetting("embedding", settings, displayGeneration);

    this.heading("Storage");
    let storageInput: HTMLInputElement;
    new Setting(containerEl)
      .setName("Storage folder")
      .setDesc(
        "Stores the vault identity and reusable embeddings. The default hidden folder may be excluded from sync. Choose a visible folder, such as Trama, and include it in your sync service to share embeddings across devices."
      )
      .addText((text) => {
        storageInput = text.inputEl;
        text.setValue(settings.storageFolder);
      })
      .addButton((button) =>
        button
          .setButtonText("Apply")
          .setCta()
          .onClick(() => {
            try {
              const folder = normalizeStorageFolder(
                storageInput.value,
                this.app.vault.configDir || ".obsidian"
              );
              void this.persistDiscrete((current) => ({ ...current, storageFolder: folder })).then(
                (saved) => {
                  if (saved) {
                    settings.storageFolder = saved.storageFolder;
                    storageInput.value = saved.storageFolder;
                  }
                }
              );
            } catch (error) {
              new Notice(error instanceof Error ? error.message : "Invalid storage folder.");
            }
          })
      );
    this.text(
      "Embedding dimensions",
      "embedding.dimensions",
      () => String(this.plugin.getSettings().embedding.dimensions),
      String(settings.embedding.dimensions),
      (raw) => {
        const value = Number(raw);
        if (Number.isSafeInteger(value)) settings.embedding.dimensions = value;
      },
      (raw) => {
        const value = Number(raw);
        return Number.isSafeInteger(value) && value > 0
          ? { value, display: String(value) }
          : undefined;
      },
      async (value) =>
        this.persist((current) => ({
          ...current,
          embedding: { ...current.embedding, dimensions: value },
        }))
    );

    this.heading("Excluded folders");
    this.folderRows = containerEl.createDiv();
    this.renderFolders(settings);
    new Setting(containerEl)
      .setName("Exclude folder")
      .addDropdown((dropdown) => {
        this.folderDropdown = dropdown;
        dropdown.addOption("", "Select a folder");
        const folders = this.app.vault.getAllFolders(false) as Array<{ path: string }>;
        for (const folder of folders) dropdown.addOption(folder.path, folder.path);
        dropdown.setValue(this.selectedFolder);
        dropdown.onChange((value) => {
          this.selectedFolder = value;
        });
      })
      .setDesc("Saved exclusions are applied on the next Update.")
      .addButton((button) =>
        button.setButtonText("Add").onClick(() => void this.addFolder(settings))
      );

    this.heading("Maintenance");
    new Setting(containerEl)
      .setName("Update index")
      .setDesc("Index current Markdown notes and remove deleted or excluded notes.")
      .addButton((button) =>
        button.setButtonText("Update").onClick(() => void this.plugin.updateIndex())
      );
    new Setting(containerEl)
      .setName("Rebuild index")
      .addButton((button) =>
        button.setButtonText("Rebuild").onClick(() => void this.plugin.rebuildIndex())
      );
    new Setting(containerEl)
      .setName("Stop index operation")
      .setDesc("Stop an active Update, Rebuild, or Clear operation.")
      .addButton((button) => button.setButtonText("Stop").onClick(() => this.plugin.stopIndex()));
    new Setting(containerEl)
      .setName("Clear index and embedding cache")
      .setDesc(
        "Remove the local index, SQLite embedding cache, and managed shared embedding cache files."
      )
      .addButton((button) =>
        button.setButtonText("Clear index and cache").onClick(() => void this.plugin.clearIndex())
      );
    new Setting(containerEl)
      .setName("Console debugging")
      .setDesc("Log operation timings and errors to the developer console.")
      .addToggle((toggle) => {
        toggle.setValue(settings.consoleDebug);
        toggle.onChange((value) => {
          void this.persistDiscrete((current) => ({ ...current, consoleDebug: value })).then(
            (saved) => {
              if (saved) settings.consoleDebug = saved.consoleDebug;
              else toggle.setValue(this.plugin.getSettings().consoleDebug);
            }
          );
        });
      });
  }

  hide(): void {
    this.displayGeneration++;
    this.discoveryGeneration.chat++;
    this.discoveryGeneration.embedding++;
    void (async () => {
      for (const commit of [...this.flushText]) await commit();
    })();
  }

  refreshExternalSettings(): void {
    this.displayGeneration++;
    this.textGeneration++;
    this.settingsGeneration++;
    this.discoveryGeneration.chat++;
    this.discoveryGeneration.embedding++;
    this.draft = undefined;
    this.pendingText.clear();
    this.flushText.length = 0;
    this.display();
  }

  private heading(title: string): void {
    new Setting(this.containerEl).setName(title).setHeading();
  }

  private text<T>(
    name: string,
    key: string,
    persisted: () => string,
    draftValue: string,
    updateDraft: (value: string) => void,
    parse: (raw: string) => ParsedText<T> | undefined,
    save: (value: T) => Promise<unknown>,
    description?: string
  ): void {
    const setting = new Setting(this.containerEl).setName(name);
    if (description) setting.setDesc(description);
    setting.addText((input) => {
      const generation = this.textGeneration;
      input.setValue(this.pendingText.get(key) ?? draftValue).onChange((raw) => {
        this.pendingText.set(key, raw);
        updateDraft(raw);
      });
      let inFlight: Promise<void> | undefined;
      let committingRaw = "";
      const commit = async () => {
        if (inFlight) {
          await inFlight;
          if (input.getValue() !== committingRaw) return commit();
          return;
        }
        inFlight = (async () => {
          const raw = input.getValue();
          committingRaw = raw;
          this.pendingText.set(key, raw);
          const parsed = parse(raw);
          if (!parsed) {
            new Notice(`${name} is invalid; the saved value was kept.`);
            return;
          }
          if (parsed.display === persisted()) {
            this.pendingText.delete(key);
            return;
          }
          if (this.textGeneration !== generation) return;
          try {
            const saved = await save(parsed.value);
            if (saved === undefined) return;
            this.pendingText.delete(key);
          } catch (error) {
            new Notice(error instanceof Error ? error.message : `${name} could not be saved.`);
          }
        })().finally(() => {
          inFlight = undefined;
        });
        return inFlight;
      };
      input.inputEl.addEventListener("blur", () => void commit());
      input.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          void commit();
        }
      });
      this.flushText.push(commit);
    });
  }

  private modelSetting(
    target: "chat" | "embedding",
    settings: SettingsDraft,
    displayGeneration: number
  ): void {
    const setting = new Setting(this.containerEl).setName(
      target === "chat" ? "Chat model" : "Embedding model"
    );
    const modelId = settings[target].modelId;
    const models = [...new Set([...this.discovered[target], ...(modelId ? [modelId] : [])])];
    setting.addDropdown((dropdown) => {
      this.resetModelOptions[target] = () => {
        const selected = this.plugin.getSettings()[target].modelId;
        dropdown.selectEl.replaceChildren();
        dropdown.addOption("", "Select a model");
        if (selected) dropdown.addOption(selected, selected);
        dropdown.setValue(selected);
      };
      dropdown.addOption("", "Select a model");
      for (const model of models) dropdown.addOption(model, model);
      dropdown.setValue(modelId);
      dropdown.onChange((value) => {
        if (!value) return;
        void this.persistDiscrete((current) => ({
          ...current,
          [target]: { ...current[target], modelId: value },
        })).then((saved) => {
          if (saved) settings[target].modelId = value;
          else dropdown.setValue(this.plugin.getSettings()[target].modelId);
        });
      });
    });
    setting.addExtraButton((button) =>
      button
        .setIcon("search")
        .setTooltip(`Discover ${target} models`)
        .onClick(() => void this.discoverFor(target, settings, displayGeneration, button))
    );
  }

  private async discoverFor(
    target: "chat" | "embedding",
    settings: SettingsDraft,
    displayGeneration: number,
    button: { setDisabled(disabled: boolean): unknown }
  ): Promise<void> {
    const generation = ++this.discoveryGeneration[target];
    const endpoint = settings[target].endpoint;
    button.setDisabled(true);
    try {
      const models = await this.plugin.discoverModels(target, endpoint);
      if (
        this.displayGeneration !== displayGeneration ||
        this.discoveryGeneration[target] !== generation ||
        settings[target].endpoint !== endpoint
      )
        return;
      this.discovered[target] = [...models];
      if (!this.discovered[target].length)
        new Notice("No models were returned by the configured endpoint.");
      this.display();
    } catch (error) {
      if (
        this.displayGeneration !== displayGeneration ||
        this.discoveryGeneration[target] !== generation ||
        settings[target].endpoint !== endpoint
      )
        return;
      this.consoleDebug?.error("Local model discovery failed", error);
      this.clearDiscoveredModels(target);
      new Notice(error instanceof Error ? error.message : "Model discovery failed.");
    } finally {
      button.setDisabled(false);
    }
  }

  private clearDiscoveredModels(target: "chat" | "embedding"): void {
    this.discovered[target] = [];
    this.resetModelOptions[target]?.();
  }

  private async addFolder(settings: SettingsDraft): Promise<void> {
    if (!this.selectedFolder) return;
    const selected = this.selectedFolder;
    const saved = await this.persistDiscrete((current) => ({
      ...current,
      excludedFolders: normalizeExcludedFolders([...current.excludedFolders, selected]),
    }));
    if (!saved) return;
    settings.excludedFolders = [...saved.excludedFolders];
    this.selectedFolder = "";
    this.folderDropdown?.setValue("");
    this.renderFolders(settings);
  }

  private renderFolders(settings: SettingsDraft): void {
    if (!this.folderRows) return;
    this.folderRows.empty();
    const folders = this.app.vault.getAllFolders(false) as Array<{ path: string }>;
    for (const path of settings.excludedFolders) {
      const missing = !folders.some((folder) => folder.path === path);
      new Setting(this.folderRows)
        .setName(missing ? `${path} (folder not found)` : path)
        .addButton((button) =>
          button.setButtonText("Remove").onClick(() => void this.removeFolder(path, settings))
        );
    }
    if (!settings.excludedFolders.length)
      this.folderRows.createEl("p", { text: "No folders are excluded." });
  }

  private async removeFolder(path: string, settings: SettingsDraft): Promise<void> {
    const saved = await this.persistDiscrete((current) => ({
      ...current,
      excludedFolders: current.excludedFolders.filter((folder) => folder !== path),
    }));
    if (!saved) return;
    settings.excludedFolders = [...saved.excludedFolders];
    this.renderFolders(settings);
  }

  private async persist(
    update: (current: TramaSettings) => TramaSettings
  ): Promise<TramaSettings | undefined> {
    const current = this.plugin.getSettings();
    const next = update(current);
    const currentProfile = effectiveEmbeddingProfile(current);
    const nextProfile = effectiveEmbeddingProfile(next);
    const requiresConfirmation =
      this.plugin.hasIndexedOrActiveIndex &&
      currentProfile !== undefined &&
      nextProfile !== undefined &&
      currentProfile !== nextProfile;
    const settingsGeneration = this.settingsGeneration;
    const formGeneration = this.textGeneration;
    if (requiresConfirmation && !(await this.confirmEmbeddingChange())) return undefined;
    if (
      requiresConfirmation &&
      (this.settingsGeneration !== settingsGeneration ||
        this.textGeneration !== formGeneration ||
        effectiveEmbeddingProfile(this.plugin.getSettings()) !== currentProfile)
    )
      return undefined;
    await this.plugin.saveSettings(update);
    const saved = this.plugin.getSettings();
    if (requiresConfirmation)
      new Notice(
        "Embedding settings changed. Clear the index and embedding cache, then run Update or Rebuild. The index and caches remain until you choose Clear."
      );
    return saved;
  }

  private confirmEmbeddingChange(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (save: boolean) => {
        if (settled) return;
        settled = true;
        resolve(save);
      };
      const modal = new (class extends Modal {
        override onClose(): void {
          settle(false);
        }
      })(this.app);
      modal.setTitle("Clear index and embedding cache after saving?");
      modal.contentEl.createEl("p", {
        text: "Changing embedding settings can leave indexed results out of date. Save changes, then choose Clear index and embedding cache and run Update or Rebuild. Existing notes and caches remain until you choose Clear.",
      });
      new Setting(modal.contentEl)
        .setName("Embedding settings change")
        .addButton((button) =>
          button.setButtonText("Cancel").onClick(() => {
            modal.close();
            settle(false);
          })
        )
        .addButton((button) =>
          button
            .setButtonText("Save changes")
            .setCta()
            .onClick(() => {
              settle(true);
              modal.close();
            })
        );
      modal.open();
    });
  }

  private async persistDiscrete(
    update: (current: TramaSettings) => TramaSettings
  ): Promise<TramaSettings | undefined> {
    try {
      return await this.persist(update);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Settings could not be saved.");
      return undefined;
    }
  }
}

function effectiveEmbeddingProfile(settings: TramaSettings): string | undefined {
  if (!settings.embedding.modelId.trim()) return undefined;
  try {
    return noteEmbeddingProfile({
      ...settings.embedding,
      endpoint: settings.embedding.endpoint.trim(),
    });
  } catch {
    return undefined;
  }
}

function cloneSettings(settings: TramaSettings): SettingsDraft {
  return {
    consoleDebug: settings.consoleDebug,
    chat: { ...settings.chat },
    embedding: { ...settings.embedding },
    excludedFolders: [...settings.excludedFolders],
    storageFolder: settings.storageFolder ?? DEFAULT_STORAGE_FOLDER,
  };
}
