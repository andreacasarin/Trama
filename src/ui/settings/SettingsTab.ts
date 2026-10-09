import { Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { EndpointPolicy, type EndpointApproval } from "@/security/EndpointPolicy";
import type { TramaPlugin } from "@/plugin/TramaPlugin";
import type { ChatSettings, EmbeddingSettings, TramaSettings } from "@/settings/Settings";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
interface SettingsDraft {
  chat: Mutable<ChatSettings>;
  embedding: Mutable<EmbeddingSettings>;
  approvedOrigins: EndpointApproval[];
}

export class TramaSettingsTab extends PluginSettingTab {
  private draft?: SettingsDraft;
  private readonly discovered: Record<"chat" | "embedding", readonly string[]> = {
    chat: [],
    embedding: [],
  };
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
    const { containerEl } = this;
    containerEl.empty();
    const settings = (this.draft ??= cloneSettings(this.plugin.getSettings()));
    containerEl.createEl("h2", { text: "Trama" });

    this.heading("Voce");
    this.text(
      "Chat endpoint",
      settings.chat.endpoint,
      (value) => {
        settings.chat.endpoint = value;
      },
      "Local OpenAI-compatible /v1 endpoint."
    );
    this.approval("chat", settings);
    this.text("Chat model", settings.chat.modelId, (value) => {
      settings.chat.modelId = value;
    });
    this.discover("chat", settings);
    this.text("Temperature", String(settings.chat.temperature), (value) => {
      const temperature = Number(value);
      if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 1)
        settings.chat.temperature = temperature;
    });
    this.text(
      "Maximum output tokens",
      String(settings.chat.maxOutputTokens ?? ""),
      (value) => {
        const count = Number(value);
        if (!value.trim()) delete settings.chat.maxOutputTokens;
        else if (Number.isSafeInteger(count) && count >= 1024)
          settings.chat.maxOutputTokens = count;
      },
      "Leave blank for the model default."
    );
    new Setting(containerEl).setName("Reasoning effort").addDropdown((dropdown) => {
      dropdown.addOption("auto", "Auto");
      for (const value of ["none", "low", "medium", "high"] as const)
        dropdown.addOption(value, value[0].toUpperCase() + value.slice(1));
      dropdown.setValue(settings.chat.reasoningEffort ?? "auto");
      dropdown.onChange((value) => {
        if (value === "auto") delete settings.chat.reasoningEffort;
        else
          settings.chat.reasoningEffort = value as NonNullable<
            typeof settings.chat.reasoningEffort
          >;
      });
    });

    this.heading("Index and search");
    this.text(
      "Embedding endpoint",
      settings.embedding.endpoint,
      (value) => {
        settings.embedding.endpoint = value;
      },
      "Local OpenAI-compatible /v1 endpoint."
    );
    this.approval("embedding", settings);
    this.text("Embedding model", settings.embedding.modelId, (value) => {
      settings.embedding.modelId = value;
    });
    this.discover("embedding", settings);
    this.text("Embedding dimensions", String(settings.embedding.dimensions), (value) => {
      const dimensions = Number(value);
      if (Number.isSafeInteger(dimensions) && dimensions > 0)
        settings.embedding.dimensions = dimensions;
    });
    new Setting(containerEl)
      .setName("Update index")
      .setDesc("Index current Markdown notes and remove deleted notes.")
      .addButton((button) =>
        button.setButtonText("Update").onClick(() => void this.plugin.updateIndex())
      );
    new Setting(containerEl)
      .setName("Rebuild index")
      .addButton((button) =>
        button.setButtonText("Rebuild").onClick(() => void this.plugin.rebuildIndex())
      );
    new Setting(containerEl)
      .setName("Stop indexing")
      .addButton((button) => button.setButtonText("Stop").onClick(() => this.plugin.stopIndex()));

    this.heading("Approved private origins");
    if (!settings.approvedOrigins.length)
      containerEl.createEl("p", { text: "No private origins are approved." });
    for (const origin of settings.approvedOrigins) {
      new Setting(containerEl)
        .setName(`${origin.scheme}://${origin.host}:${origin.port}`)
        .addButton((button) =>
          button.setButtonText("Remove").onClick(() => {
            settings.approvedOrigins = settings.approvedOrigins.filter(
              (item) => !sameOrigin(item, origin)
            );
            this.display();
          })
        );
    }
    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText("Save")
        .setCta()
        .onClick(() => void this.save())
    );
  }

  private heading(title: string): void {
    new Setting(this.containerEl).setName(title).setHeading();
  }

  private text(
    name: string,
    value: string,
    update: (value: string) => void,
    description?: string
  ): void {
    const setting = new Setting(this.containerEl).setName(name);
    if (description) setting.setDesc(description);
    setting.addText((input) => input.setValue(value).onChange(update));
  }

  private approval(target: "chat" | "embedding", settings: SettingsDraft): void {
    new Setting(this.containerEl)
      .setName("Endpoint trust")
      .setDesc(
        "Loopback is allowed automatically. Add a private LAN endpoint explicitly before saving or discovering models."
      )
      .addButton((button) =>
        button.setButtonText("Approve private origin").onClick(() => {
          try {
            const approval = new EndpointPolicy().approvalFor(settings[target].endpoint);
            if (!settings.approvedOrigins.some((item) => sameOrigin(item, approval)))
              settings.approvedOrigins = [...settings.approvedOrigins, approval];
            new Notice(`Approved ${approval.host}:${approval.port} for this vault.`);
            this.display();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "This origin cannot be approved.");
          }
        })
      );
  }

  private discover(target: "chat" | "embedding", settings: SettingsDraft): void {
    const label = target === "chat" ? "Chat model" : "Embedding model";
    new Setting(this.containerEl)
      .setName(`${label} discovery`)
      .setDesc("Contact the configured endpoint only when Discover is pressed.")
      .addButton((button) =>
        button.setButtonText("Discover").onClick(() => void this.discoverFor(target, settings))
      );
    const models = this.discovered[target];
    if (!models.length) return;
    new Setting(this.containerEl).setName(`Choose ${target} model`).addDropdown((dropdown) => {
      dropdown.addOption("", "Select a discovered model");
      for (const model of models) dropdown.addOption(model, model);
      dropdown.setValue(settings[target].modelId);
      dropdown.onChange((value) => {
        if (value) settings[target].modelId = value;
      });
    });
  }

  private async discoverFor(target: "chat" | "embedding", settings: SettingsDraft): Promise<void> {
    try {
      this.discovered[target] = await this.plugin.discoverModels(
        target,
        settings[target].endpoint,
        settings.approvedOrigins
      );
      if (!this.discovered[target].length)
        new Notice("No models were returned by the local endpoint.");
      this.display();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Model discovery failed.");
    }
  }

  private async save(): Promise<void> {
    if (!this.draft) return;
    try {
      await this.plugin.saveSettings(this.draft);
      this.draft = undefined;
      this.display();
      new Notice("Trama settings saved.");
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Settings could not be saved.");
    }
  }
}

function cloneSettings(settings: TramaSettings): SettingsDraft {
  return {
    chat: { ...settings.chat },
    embedding: { ...settings.embedding },
    approvedOrigins: settings.approvedOrigins.map((origin) => ({ ...origin })),
  };
}

function sameOrigin(left: EndpointApproval, right: EndpointApproval): boolean {
  return (
    left.scheme === right.scheme &&
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.port === right.port
  );
}
