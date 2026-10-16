import { Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { EndpointPolicy, type EndpointApproval } from "@/security/EndpointPolicy";
import type { TramaPlugin } from "@/plugin/TramaPlugin";
import {
  normalizeExcludedFolders,
  type ChatSettings,
  type EmbeddingSettings,
  type TramaSettings,
} from "@/settings/Settings";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
interface SettingsDraft {
  chat: Mutable<ChatSettings>;
  embedding: Mutable<EmbeddingSettings>;
  approvedOrigins: EndpointApproval[];
  excludedFolders: string[];
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
      discoverModels(
        target: "chat" | "embedding",
        endpoint?: string,
        approvals?: readonly EndpointApproval[]
      ): Promise<readonly string[]>;
    }
  ) {
    super(app, plugin as unknown as Plugin);
  }

  display(): void {
    const displayGeneration = ++this.displayGeneration;
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
      "Local OpenAI-compatible /v1 endpoint."
    );
    this.approval("chat", settings);
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
    new Setting(containerEl).setName("Reasoning effort").addDropdown((dropdown) => {
      dropdown.addOption("auto", "Auto");
      for (const value of ["none", "low", "medium", "high"] as const)
        dropdown.addOption(value, value[0].toUpperCase() + value.slice(1));
      dropdown.setValue(settings.chat.reasoningEffort ?? "auto");
      dropdown.onChange((value) => {
        if (value !== "auto" && !["none", "low", "medium", "high"].includes(value)) return;
        void this.persistDiscrete((current) => {
          const chat = { ...current.chat };
          if (value === "auto") delete chat.reasoningEffort;
          else chat.reasoningEffort = value as NonNullable<typeof chat.reasoningEffort>;
          return { ...current, chat };
        }).then((saved) => {
          if (saved) {
            if (value === "auto") delete settings.chat.reasoningEffort;
            else
              settings.chat.reasoningEffort = value as NonNullable<
                typeof settings.chat.reasoningEffort
              >;
          }
        });
      });
    });

    this.heading("Index and search");
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
      "Local OpenAI-compatible /v1 endpoint."
    );
    this.approval("embedding", settings);
    this.modelSetting("embedding", settings, displayGeneration);
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
      .setName("Clear local index")
      .setDesc("Remove indexed notes and vectors. Vault notes and embedding caches are kept.")
      .addButton((button) =>
        button.setButtonText("Clear").onClick(() => void this.plugin.clearIndex())
      );

    this.heading("Approved private origins");
    this.renderOrigins(settings);
  }

  hide(): void {
    this.displayGeneration++;
    void (async () => {
      for (const commit of this.flushText) await commit();
    })();
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
          try {
            await save(parsed.value);
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

  private approval(target: "chat" | "embedding", settings: SettingsDraft): void {
    new Setting(this.containerEl)
      .setName("Endpoint trust")
      .setDesc(
        "Loopback is allowed automatically. Add a private LAN endpoint explicitly before discovering models."
      )
      .addButton((button) =>
        button.setButtonText("Approve private origin").onClick(
          () =>
            void (async () => {
              try {
                const approval = new EndpointPolicy({
                  approvals: settings.approvedOrigins,
                }).approvalFor(settings[target].endpoint);
                const endpoint = new EndpointPolicy({
                  approvals: [...settings.approvedOrigins, approval],
                }).normalize(settings[target].endpoint);
                const saved = await this.persist((current) => ({
                  ...current,
                  [target]: { ...current[target], endpoint },
                  approvedOrigins: current.approvedOrigins.some((item) =>
                    sameOrigin(item, approval)
                  )
                    ? current.approvedOrigins
                    : [...current.approvedOrigins, approval],
                }));
                if (!saved) return;
                if (settings[target].endpoint !== endpoint) this.clearDiscoveredModels(target);
                settings[target].endpoint = endpoint;
                if (!settings.approvedOrigins.some((item) => sameOrigin(item, approval)))
                  settings.approvedOrigins.push(approval);
                this.pendingText.delete(`${target}.endpoint`);
                this.renderOrigins(settings);
              } catch (error) {
                new Notice(
                  error instanceof Error ? error.message : "This origin cannot be approved."
                );
              }
            })()
        )
      );
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
    const approvals = JSON.stringify(settings.approvedOrigins);
    button.setDisabled(true);
    try {
      const models = await this.plugin.discoverModels(target, endpoint, settings.approvedOrigins);
      if (
        this.displayGeneration !== displayGeneration ||
        this.discoveryGeneration[target] !== generation ||
        settings[target].endpoint !== endpoint ||
        JSON.stringify(settings.approvedOrigins) !== approvals
      )
        return;
      this.discovered[target] = [...models];
      if (!this.discovered[target].length)
        new Notice("No models were returned by the local endpoint.");
      this.display();
    } catch (error) {
      if (
        this.displayGeneration !== displayGeneration ||
        this.discoveryGeneration[target] !== generation ||
        settings[target].endpoint !== endpoint ||
        JSON.stringify(settings.approvedOrigins) !== approvals
      )
        return;
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

  private renderOrigins(settings: SettingsDraft): void {
    const existing = this.containerEl.querySelector(".trama-approved-origins");
    existing?.remove();
    const rows = this.containerEl.createDiv({ cls: "trama-approved-origins" });
    if (!settings.approvedOrigins.length)
      rows.createEl("p", { text: "No private origins are approved." });
    for (const origin of settings.approvedOrigins) {
      new Setting(rows)
        .setName(`${origin.scheme}://${origin.host}:${origin.port}`)
        .addButton((button) =>
          button.setButtonText("Remove").onClick(() => void this.removeOrigin(origin, settings))
        );
    }
  }

  private async removeOrigin(origin: EndpointApproval, settings: SettingsDraft): Promise<void> {
    const saved = await this.persistDiscrete((current) => ({
      ...current,
      approvedOrigins: current.approvedOrigins.filter((item) => !sameOrigin(item, origin)),
    }));
    if (!saved) return;
    settings.approvedOrigins = saved.approvedOrigins.map((item) => ({ ...item }));
    this.renderOrigins(settings);
  }

  private async persist(update: (current: TramaSettings) => TramaSettings): Promise<TramaSettings> {
    await this.plugin.saveSettings(update);
    return this.plugin.getSettings();
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

function cloneSettings(settings: TramaSettings): SettingsDraft {
  return {
    chat: { ...settings.chat },
    embedding: { ...settings.embedding },
    approvedOrigins: settings.approvedOrigins.map((origin) => ({ ...origin })),
    excludedFolders: [...settings.excludedFolders],
  };
}

function sameOrigin(left: EndpointApproval, right: EndpointApproval): boolean {
  return (
    left.scheme === right.scheme &&
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.port === right.port
  );
}
