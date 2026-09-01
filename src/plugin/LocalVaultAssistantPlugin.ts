import { Platform, Plugin, TAbstractFile } from "obsidian";
import { ChatSession } from "@/chat/ChatSession";
import { IndexManager, IndexVaultPort } from "@/index/IndexManager";
import { ObsidianIndexStorage } from "@/index/storage";
import { LmStudioChatModel } from "@/providers/lmStudio/LmStudioChatModel";
import { LmStudioEmbeddingModel } from "@/providers/lmStudio/LmStudioEmbeddingModel";
import { LmStudioTransport } from "@/providers/lmStudio/LmStudioTransport";
import { EndpointPolicy } from "@/security/EndpointPolicy";
import { DEFAULT_SETTINGS, LocalVaultAssistantSettings, SettingsStore } from "@/settings/Settings";
import { ObsidianReadonlyVault } from "@/vault/readOnly/ObsidianReadonlyVault";
import { ObsidianIndexVault } from "@/vault/indexing/ObsidianIndexVault";
import {
  CurrentNoteTool,
  DiscoverLinksTool,
  FollowLinkTool,
  ReadNoteTool,
  ToolRegistry,
  VaultSearchTool,
} from "@/tools/ToolRegistry";
import { IndexStatusController } from "@/ui/index/IndexStatus";

/** Composes the desktop-only assistant and owns its lifecycle and vault event boundary. */
export class LocalVaultAssistantPlugin extends Plugin {
  private desktopLoaded = false;
  private readonly settingsStore = new SettingsStore();
  private session?: ChatSession;
  private chatModel?: LmStudioChatModel;
  private embeddingModel?: LmStudioEmbeddingModel;
  private index?: IndexManager;
  private indexStatus?: IndexStatusController;
  private lifecycleAbort?: AbortController;
  private indexLoad?: Promise<boolean>;
  private indexLoaded = false;
  private indexReady = false;
  private compositionRevision = 0;
  private readonly pendingVaultChanges = new Set<string>();
  private eventTimer?: ReturnType<typeof setTimeout>;
  private readonly eventRefs: Array<{ unsubscribe?: () => void }> = [];
  private saveQueue: Promise<void> = Promise.resolve();

  override async onload(): Promise<void> {
    if (!Platform.isDesktopApp) return;
    this.desktopLoaded = true;
    if (typeof this.loadData === "function") this.settingsStore.load(await this.loadData());
    const app = (this as unknown as { app?: any }).app;
    if (!app?.vault || !app.workspace || !app.metadataCache) return;
    const [{ ChatView, CHAT_VIEW_TYPE }, { LocalVaultAssistantSettingsTab }] = await Promise.all([
      import("@/ui/chat/ChatView"),
      import("@/ui/settings/SettingsTab"),
    ]);
    this.lifecycleAbort = new AbortController();
    const settings = this.settingsStore.get();
    this.composeRuntime(app, settings);
    this.indexStatus = new IndexStatusController(this, async (signal) => {
      const manager = this.index;
      const pendingAtStart = new Set(this.pendingVaultChanges);
      for (const path of pendingAtStart) manager?.queueChange(path);
      await this.indexLoad;
      if (this.index !== manager || !manager) throw new Error("Index was replaced during rebuild.");
      try {
        await manager.build(signal);
      } catch (error) {
        this.handleIndexFailure(manager, error);
        throw error;
      }
      if (this.index === manager) {
        for (const path of pendingAtStart) this.pendingVaultChanges.delete(path);
        this.indexReady = true;
        const late = [...this.pendingVaultChanges];
        for (const path of late) manager.queueChange(path);
        if (late.length) {
          try {
            await manager.reconcileQueuedChanges(signal);
            for (const path of late) this.pendingVaultChanges.delete(path);
          } catch (error) {
            this.handleIndexFailure(manager, error);
            throw error;
          }
        }
      }
    });
    this.indexStatus.register();
    this.addSettingTab(new LocalVaultAssistantSettingsTab(app, this));
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this.session!));
    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () =>
        void app.workspace.getLeaf(true).setViewState({ type: CHAT_VIEW_TYPE, active: true }),
    });
    this.registerVaultEvents(app.vault);
  }

  override onunload(): void {
    this.indexStatus?.cancel();
    this.lifecycleAbort?.abort();
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = undefined;
    this.session?.cancel();
    for (const ref of this.eventRefs) ref.unsubscribe?.();
    this.eventRefs.length = 0;
    this.desktopLoaded = false;
  }
  isDesktopLoaded(): boolean {
    return this.desktopLoaded;
  }
  getSettings(): LocalVaultAssistantSettings {
    return this.settingsStore.get() ?? DEFAULT_SETTINGS;
  }
  getIndexStatusMessage(): string {
    return (
      this.indexStatus?.getStatus().message ??
      this.indexStatus?.getStatus().kind ??
      "Not initialized"
    );
  }
  saveSettings(
    settings:
      | LocalVaultAssistantSettings
      | ((current: LocalVaultAssistantSettings) => LocalVaultAssistantSettings)
  ): Promise<void> {
    return this.enqueueSettingsUpdate(typeof settings === "function" ? settings : () => settings);
  }
  private enqueueSettingsUpdate(
    update: (current: LocalVaultAssistantSettings) => LocalVaultAssistantSettings
  ): Promise<void> {
    const operation = this.saveQueue.then(() => this.performSave(update(this.settingsStore.get())));
    this.saveQueue = operation.catch(() => undefined);
    return operation;
  }
  private async performSave(settings: LocalVaultAssistantSettings): Promise<void> {
    const before = this.settingsStore.get();
    const saved = this.settingsStore.stage(settings);
    if (typeof this.saveData === "function") await this.saveData(saved);
    this.settingsStore.commit(saved);
    const chatChanged =
      before.chat.endpoint !== saved.chat.endpoint || before.chat.modelId !== saved.chat.modelId;
    const embeddingChanged =
      before.embedding.endpoint !== saved.embedding.endpoint ||
      before.embedding.modelId !== saved.embedding.modelId ||
      before.embedding.dimensions !== saved.embedding.dimensions;
    if (chatChanged || embeddingChanged) this.session?.cancel();
    if (embeddingChanged) {
      this.indexStatus?.cancel();
      const oldIndex = this.index;
      oldIndex?.invalidate();
      this.lifecycleAbort?.abort();
      try {
        await oldIndex?.waitForBuild();
      } catch {
        // The old build is intentionally cancelled before composing its replacement.
      }
      this.lifecycleAbort = new AbortController();
      this.indexStatus?.markStale();
    }
    const app = (this as unknown as { app?: any }).app;
    if (app?.vault && app.workspace && app.metadataCache && this.session) {
      if (chatChanged && !embeddingChanged) this.composeChatSession(app, saved);
      else if (embeddingChanged) this.composeRuntime(app, saved);
    }
  }
  updateChatEndpoint(value: string): Promise<void> {
    return this.enqueueSettingsUpdate((current) => ({
      ...current,
      chat: { ...current.chat, endpoint: value },
    }));
  }
  updateChatModel(value: string): Promise<void> {
    return this.enqueueSettingsUpdate((current) => ({
      ...current,
      chat: { ...current.chat, modelId: value },
    }));
  }
  updateEmbeddingEndpoint(value: string): Promise<void> {
    return this.enqueueSettingsUpdate((current) => ({
      ...current,
      embedding: { ...current.embedding, endpoint: value },
    }));
  }
  updateEmbeddingModel(value: string): Promise<void> {
    return this.enqueueSettingsUpdate((current) => ({
      ...current,
      embedding: { ...current.embedding, modelId: value },
    }));
  }

  private composeRuntime(app: any, settings: LocalVaultAssistantSettings): void {
    const transport = new LmStudioTransport({
      policy: new EndpointPolicy({ approvals: settings.approvedOrigins }),
    });
    const readonlyVault = new ObsidianReadonlyVault(app.vault, app.workspace, app.metadataCache);
    const indexVault: IndexVaultPort = new ObsidianIndexVault(app.vault, (path) =>
      this.isVisibleMarkdown(path)
    );
    const embedding = new LmStudioEmbeddingModel({ ...settings.embedding, transport });
    this.embeddingModel = embedding;
    const manager = new IndexManager(
      indexVault,
      embedding,
      new ObsidianIndexStorage(app.vault.adapter),
      settings.embedding.endpoint,
      settings.embedding.modelId,
      {},
      (error) => this.handleIndexFailure(manager, error)
    );
    this.index = manager;
    const compositionRevision = ++this.compositionRevision;
    const registry = new ToolRegistry([
      new CurrentNoteTool(readonlyVault),
      new ReadNoteTool(readonlyVault),
      new DiscoverLinksTool(readonlyVault),
      new FollowLinkTool(readonlyVault),
      new VaultSearchTool(this.index),
    ]);
    this.composeChatSession(app, settings, registry, transport);
    this.indexLoaded = false;
    this.indexReady = false;
    const loadPromise = manager.load().catch(() => false);
    this.indexLoad = loadPromise;
    void loadPromise.then((loaded) => {
      if (this.index !== manager || compositionRevision !== this.compositionRevision) return;
      this.indexLoaded = true;
      this.indexReady = loaded;
      if (!loaded) return;
      const hadPendingChanges = this.pendingVaultChanges.size > 0;
      for (const path of this.pendingVaultChanges) this.index?.queueChange(path);
      this.pendingVaultChanges.clear();
      const index = manager;
      if (hadPendingChanges && index && this.lifecycleAbort)
        void index.reconcileQueuedChanges(this.lifecycleAbort.signal).catch((error) => {
          this.handleIndexFailure(index, error);
        });
    });
  }

  private handleIndexFailure(manager: IndexManager, error: unknown): void {
    if (this.index !== manager) return;
    manager.markUnavailable();
    this.indexReady = false;
    this.indexStatus?.markError(error);
  }

  private composeChatSession(
    app: any,
    settings: LocalVaultAssistantSettings,
    existingRegistry?: ToolRegistry,
    existingTransport?: LmStudioTransport
  ): void {
    const transport =
      existingTransport ??
      new LmStudioTransport({
        policy: new EndpointPolicy({ approvals: settings.approvedOrigins }),
      });
    const readonlyVault = new ObsidianReadonlyVault(app.vault, app.workspace, app.metadataCache);
    const registry =
      existingRegistry ??
      new ToolRegistry([
        new CurrentNoteTool(readonlyVault),
        new ReadNoteTool(readonlyVault),
        new DiscoverLinksTool(readonlyVault),
        new FollowLinkTool(readonlyVault),
        new VaultSearchTool(this.index!),
      ]);
    this.chatModel = new LmStudioChatModel({ ...settings.chat, transport });
    this.session = new ChatSession(this.chatModel, registry);
    for (const leaf of app.workspace.getLeavesOfType?.("local-vault-assistant-chat") ?? []) {
      const view = (leaf as { view?: { setSession?: (session: ChatSession) => void } }).view;
      view?.setSession?.(this.session);
    }
  }

  async addApprovedOrigin(endpoint: string): Promise<void> {
    await this.enqueueSettingsUpdate((current) => {
      const approval = new EndpointPolicy().approvalFor(endpoint);
      new EndpointPolicy({ approvals: [...current.approvedOrigins, approval] }).normalize(endpoint);
      const approvals = current.approvedOrigins.filter(
        (item) =>
          item.scheme !== approval.scheme ||
          item.host !== approval.host ||
          item.port !== approval.port
      );
      return { ...current, approvedOrigins: [...approvals, approval] };
    });
  }
  async removeApprovedOrigin(origin: {
    scheme: "http" | "https";
    host: string;
    port: number;
  }): Promise<void> {
    await this.enqueueSettingsUpdate((current) => ({
      ...current,
      approvedOrigins: current.approvedOrigins.filter(
        (item) =>
          item.scheme !== origin.scheme || item.host !== origin.host || item.port !== origin.port
      ),
    }));
  }
  async discoverModels(target: "chat" | "embedding"): Promise<readonly string[]> {
    const signal = new AbortController().signal;
    if (target === "chat") {
      if (!this.chatModel) throw new Error("Assistant is not initialized.");
      return this.chatModel.discoverModels(signal);
    }
    if (!this.embeddingModel) throw new Error("Assistant is not initialized.");
    return this.embeddingModel.discoverModels(signal);
  }

  private registerVaultEvents(vault: any): void {
    for (const event of ["create", "modify", "delete"])
      this.registerVaultEvent(vault, event, (file: TAbstractFile) =>
        this.queueVaultChange(file.path)
      );
    this.registerVaultEvent(vault, "rename", (file: TAbstractFile, oldPath: string) => {
      this.queueVaultChange(oldPath);
      this.queueVaultChange(file.path);
    });
  }
  private registerVaultEvent(vault: any, event: string, callback: (...args: any[]) => void): void {
    const ref = vault.on(event, callback);
    this.eventRefs.push(ref);
    this.registerEvent(ref);
  }
  private queueVaultChange(path: string): void {
    if (!this.isVisibleMarkdown(path) || !this.index) return;
    if (!this.indexLoaded || !this.indexReady) {
      this.pendingVaultChanges.add(path);
      return;
    }
    this.index.queueChange(path);
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined;
      const index = this.index;
      if (this.indexReady && index && this.lifecycleAbort)
        void index.reconcileQueuedChanges(this.lifecycleAbort.signal).catch((error) => {
          this.handleIndexFailure(index, error);
        });
    }, 150);
  }
  private isVisibleMarkdown(path: string): boolean {
    const configDir = (
      (this as unknown as { app?: { vault?: { configDir?: string } } }).app?.vault?.configDir ??
      ".obsidian"
    ).replace(/\/$/, "");
    return (
      /\.md$/i.test(path) &&
      !path.split("/").some((part) => part.startsWith(".")) &&
      !path.startsWith(`${configDir}/`) &&
      !path.startsWith(".local-vault-assistant/")
    );
  }
}
