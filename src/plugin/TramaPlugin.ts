import { Platform, Plugin, TAbstractFile } from "obsidian";
import { ChatSession } from "@/chat/ChatSession";
import { TramaDiagnostics } from "@/diagnostics/TramaDiagnostics";
import { IndexManager, IndexVaultPort } from "@/index/IndexManager";
import { compareCodeUnits } from "@/index/corpus/CorpusManifest";
import { ObsidianIndexStorage } from "@/index/storage";
import { LmStudioChatModel } from "@/providers/lmStudio/LmStudioChatModel";
import { LmStudioEmbeddingModel } from "@/providers/lmStudio/LmStudioEmbeddingModel";
import { LmStudioTransport } from "@/providers/lmStudio/LmStudioTransport";
import { EndpointPolicy } from "@/security/EndpointPolicy";
import {
  DEFAULT_SETTINGS,
  isExcludedPath,
  SettingsStore,
  TramaSettings,
} from "@/settings/Settings";
import { ObsidianReadonlyVault } from "@/vault/readOnly/ObsidianReadonlyVault";
import { ObsidianIndexVault } from "@/vault/indexing/ObsidianIndexVault";
import {
  DiscoverLinksTool,
  FollowLinkTool,
  ReadNoteTool,
  ToolRegistry,
  VaultSearchTool,
} from "@/tools/ToolRegistry";
import { IndexStatusController } from "@/ui/index/IndexStatus";
import { RelatedNotes } from "@/index/RelatedNotes";
import { TRAMA_ICONS } from "@/ui/icons";
import { LenteBatch, LenteSearch, LenteSearchOptions } from "@/index/LenteSearch";
import { ObsidianLenteNoteStats } from "@/vault/readOnly/ObsidianLenteNoteStats";

interface LenteSearchPort {
  search(query: string, options?: LenteSearchOptions): Promise<LenteBatch>;
}

/** Composes the desktop-only assistant and owns its lifecycle and vault event boundary. */
export class TramaPlugin extends Plugin {
  private desktopLoaded = false;
  private readonly settingsStore = new SettingsStore();
  private session?: ChatSession;
  private chatModel?: LmStudioChatModel;
  private embeddingModel?: LmStudioEmbeddingModel;
  private index?: IndexManager;
  private indexStatus?: IndexStatusController;
  private relatedNotes?: RelatedNotes;
  private lenteSearch?: LenteSearchPort;
  private lifecycleAbort?: AbortController;
  private automaticAbort?: AbortController;
  private automaticReschedulePending = false;
  private suppressNextAutomaticLenteRefresh = false;
  private indexLoad?: Promise<boolean>;
  private indexLoaded = false;
  private indexReady = false;
  private compositionRevision = 0;
  private readonly pendingVaultChanges = new Set<string>();
  private eventTimer?: ReturnType<typeof setTimeout>;
  private reconcilePromise?: Promise<void>;
  private queuedWork = false;
  private readonly eventRefs: Array<{ unsubscribe?: () => void }> = [];
  private saveQueue: Promise<void> = Promise.resolve();
  private visibleMarkdownCatalog: () => readonly string[] = () => [];
  private contextNoteSuggestions: () => readonly string[] = () => [];
  private lastActiveMarkdownPath?: string;
  private readonly diagnostics: TramaDiagnostics = {
    emit: (record) => {
      if (this.settingsStore.get().detailedDebug) {
        // This opt-in sink intentionally writes complete diagnostic payloads to the developer console.
        try {
          // eslint-disable-next-line no-console
          console.info("[Trama]", record);
        } catch {
          // Console instrumentation is observational and must not break chat or indexing.
        }
      }
    },
  };

  override async onload(): Promise<void> {
    if (!Platform.isDesktopApp) return;
    this.desktopLoaded = true;
    if (typeof this.loadData === "function") this.settingsStore.load(await this.loadData());
    const app = (this as unknown as { app?: any }).app;
    if (!app?.vault || !app.workspace || !app.metadataCache) return;
    this.visibleMarkdownCatalog = () =>
      app.vault
        .getMarkdownFiles()
        .map((file: { path: string }) => file.path)
        .filter((path: string) => this.isVisibleMarkdown(path))
        .sort(compareCodeUnits);
    const rememberActiveMarkdown = (file: { path?: string } | null | undefined) => {
      if (file?.path && this.isVisibleMarkdown(file.path)) this.lastActiveMarkdownPath = file.path;
    };
    rememberActiveMarkdown(app.workspace.getActiveFile());
    this.contextNoteSuggestions = () =>
      this.lastActiveMarkdownPath ? [this.lastActiveMarkdownPath] : [];
    const fileOpenRef = app.workspace.on?.("file-open", rememberActiveMarkdown);
    if (fileOpenRef) this.registerEvent(fileOpenRef);
    const [
      { VoceView, VOCE_VIEW_TYPE },
      { FiloView, FILO_VIEW_TYPE },
      { LenteView, LENTE_VIEW_TYPE },
      { TramaSettingsTab },
    ] = await Promise.all([
      import("@/ui/voce/VoceView"),
      import("@/ui/filo/FiloView"),
      import("@/ui/lente/LenteView"),
      import("@/ui/settings/SettingsTab"),
    ]);
    this.lifecycleAbort = new AbortController();
    const settings = this.settingsStore.get();
    this.composeRuntime(app, settings);
    this.indexStatus = new IndexStatusController(
      this,
      {
        index: (signal) => this.runIndex(signal, false),
        reindex: (signal) => this.runFullIndex(signal),
        cancel: () => undefined,
      },
      this.diagnostics
    );
    this.indexStatus.register();
    this.addSettingTab(new TramaSettingsTab(app, this));
    this.registerView(
      VOCE_VIEW_TYPE,
      (leaf) =>
        new VoceView(
          leaf,
          this.session!,
          this.visibleMarkdownCatalog,
          this.contextNoteSuggestions,
          undefined,
          this.relatedNotes
        )
    );
    this.registerView(
      FILO_VIEW_TYPE,
      (leaf) =>
        new FiloView(
          leaf,
          this.indexStatus!,
          this.relatedNotes,
          (kind) => this.indexStatus!.run(kind),
          () => this.indexStatus!.cancel()
        )
    );
    this.registerView(
      LENTE_VIEW_TYPE,
      (leaf) =>
        new LenteView(
          leaf,
          this.lenteSearch ?? {
            search: async () => {
              throw new Error("Lente is not initialized.");
            },
          }
        )
    );
    this.addCommand({
      id: "open-voce",
      name: "Open Voce",
      icon: TRAMA_ICONS.voce,
      callback: () =>
        void app.workspace.getLeaf(true).setViewState({ type: VOCE_VIEW_TYPE, active: true }),
    });
    this.addCommand({
      id: "open-filo",
      name: "Open Filo",
      icon: TRAMA_ICONS.filo,
      callback: () =>
        void app.workspace.getLeaf(true).setViewState({ type: FILO_VIEW_TYPE, active: true }),
    });
    this.addCommand({
      id: "open-lente",
      name: "Open Lente",
      icon: TRAMA_ICONS.lente,
      callback: () =>
        void app.workspace.getLeaf(true).setViewState({ type: LENTE_VIEW_TYPE, active: true }),
    });
    this.registerVaultEvents(app.vault);
  }

  override onunload(): void {
    this.indexReady = false;
    this.indexStatus?.cancel();
    this.lifecycleAbort?.abort();
    this.stopAutomaticWork(false);
    this.relatedNotes?.cancel();
    this.relatedNotes = undefined;
    this.session?.cancel();
    for (const ref of this.eventRefs) ref.unsubscribe?.();
    this.eventRefs.length = 0;
    this.desktopLoaded = false;
  }
  isDesktopLoaded(): boolean {
    return this.desktopLoaded;
  }
  getSettings(): TramaSettings {
    return this.settingsStore.get() ?? DEFAULT_SETTINGS;
  }
  saveSettings(
    settings: TramaSettings | ((current: TramaSettings) => TramaSettings)
  ): Promise<void> {
    return this.enqueueSettingsUpdate(typeof settings === "function" ? settings : () => settings);
  }
  private enqueueSettingsUpdate(update: (current: TramaSettings) => TramaSettings): Promise<void> {
    const operation = this.saveQueue.then(() => this.performSave(update(this.settingsStore.get())));
    this.saveQueue = operation.catch(() => undefined);
    return operation;
  }
  private async performSave(settings: TramaSettings): Promise<void> {
    const before = this.settingsStore.get();
    const saved = this.settingsStore.stage(settings);
    if (typeof this.saveData === "function") await this.saveData(saved);
    this.settingsStore.commit(saved);
    const chatChanged =
      before.chat.endpoint !== saved.chat.endpoint ||
      before.chat.modelId !== saved.chat.modelId ||
      before.chat.temperature !== saved.chat.temperature ||
      before.chat.maxOutputTokens !== saved.chat.maxOutputTokens ||
      before.chat.reasoningEffort !== saved.chat.reasoningEffort;
    const embeddingChanged =
      before.embedding.endpoint !== saved.embedding.endpoint ||
      before.embedding.modelId !== saved.embedding.modelId ||
      before.embedding.dimensions !== saved.embedding.dimensions;
    const lenteChanged =
      before.lente.searchMethod !== saved.lente.searchMethod ||
      before.lente.maxResults !== saved.lente.maxResults;
    const addedExclusions = saved.filo.excludedPaths.filter(
      (path) => !before.filo.excludedPaths.includes(path)
    );
    const removedExclusions = before.filo.excludedPaths.filter(
      (path) => !saved.filo.excludedPaths.includes(path)
    );
    const app = (this as unknown as { app?: any }).app;

    if (!saved.filo.automaticUpdates)
      this.stopAutomaticWork(true, before.filo.automaticUpdates && !saved.filo.automaticUpdates);
    else if (!before.filo.automaticUpdates) this.armAutomaticWork();

    if (addedExclusions.length) {
      // A live eligibility change must stop an in-flight background operation
      // before the deletion-only prune examines the committed snapshot.
      this.stopAutomaticWork();
      this.cancelExplicitIndexForEligibilityChange();
      this.relatedNotes?.invalidateExcludedPaths(addedExclusions);
      this.invalidateOpenExcludedResults(app, addedExclusions);
    }
    if (embeddingChanged) {
      this.stopAutomaticWork(false);
      this.session?.cancel();
      this.relatedNotes?.cancel();
    }
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
      this.indexStatus?.markStale(false);
    }
    if (app?.vault && app.workspace && app.metadataCache && this.session) {
      if (chatChanged && !embeddingChanged) this.replaceChatModel(saved);
      else if (embeddingChanged) this.composeRuntime(app, saved);
    }

    if (lenteChanged && !embeddingChanged && this.index) {
      this.replaceLenteSearch(app, addedExclusions.length === 0);
    }
    const exclusionsPruned = addedExclusions.length ? await this.pruneAddedExclusions() : true;
    if (removedExclusions.length) this.queueRemovedExclusions(before.filo.excludedPaths);

    if (
      exclusionsPruned &&
      this.getSettings().filo.automaticUpdates &&
      this.queuedWork &&
      this.indexReady
    ) {
      if (addedExclusions.length) this.suppressNextAutomaticLenteRefresh = true;
      this.scheduleReconcile();
    } else if (addedExclusions.length) {
      this.suppressNextAutomaticLenteRefresh = false;
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

  private composeRuntime(app: any, settings: TramaSettings): void {
    const transport = new LmStudioTransport({
      policy: new EndpointPolicy({ approvals: settings.approvedOrigins }),
    });
    const readonlyVault = new ObsidianReadonlyVault(app.vault, app.workspace, app.metadataCache);
    const indexVault: IndexVaultPort = new ObsidianIndexVault(app.vault, {
      isBaseVisible: (path) => this.isVisibleMarkdown(path),
      isIndexEligible: (path) => this.isIndexEligible(path),
    });
    const embedding = new LmStudioEmbeddingModel({ ...settings.embedding, transport });
    this.embeddingModel = embedding;
    const manager = new IndexManager(
      indexVault,
      embedding,
      new ObsidianIndexStorage(app.vault.adapter),
      settings.embedding.endpoint,
      settings.embedding.modelId,
      {
        isIndexEligible: (path) => this.isIndexEligible(path),
        onProgress: (progress) => this.indexStatus?.reportProgress(progress),
      },
      this.diagnostics
    );
    this.index = manager;
    this.relatedNotes?.cancel();
    this.relatedNotes = new RelatedNotes(manager, this.diagnostics);
    this.lenteSearch = this.createLenteSearch(manager, app, settings);
    const compositionRevision = ++this.compositionRevision;
    const registry = new ToolRegistry([
      new ReadNoteTool(readonlyVault),
      new DiscoverLinksTool(readonlyVault),
      new FollowLinkTool(readonlyVault),
      new VaultSearchTool(this.index),
    ]);
    this.composeChatSession(app, settings, readonlyVault, registry, transport);
    this.indexLoaded = false;
    this.indexReady = false;
    const loadPromise = manager.load({ emitDiagnostics: false }).catch(() => false);
    this.indexLoad = loadPromise;
    void loadPromise.then((loaded) => {
      if (this.index !== manager || compositionRevision !== this.compositionRevision) return;
      this.indexLoaded = true;
      this.indexReady = loaded;
      const hadPendingChanges = this.pendingVaultChanges.size > 0;
      for (const path of this.pendingVaultChanges) manager.queueChange(path);
      this.pendingVaultChanges.clear();
      if (!loaded) {
        // The initial persisted-index decision is startup bookkeeping and must
        // stay silent even if debugging is enabled immediately after onload.
        this.indexStatus?.setIndexRequired(true);
        return;
      }
      if (this.visibleMarkdownCatalog().length === 0) this.indexStatus?.setEmpty(true, true);
      else this.indexStatus?.setReady(true);
      this.refreshOpenRelatedSuggestions(app);
      if (hadPendingChanges) {
        if (this.getSettings().filo.automaticUpdates) this.scheduleReconcile();
        else this.markQueuedWorkStale();
      }
    });
  }

  private createLenteSearch(
    manager: IndexManager,
    app: any,
    settings: TramaSettings
  ): LenteSearchPort {
    const search = new LenteSearch(
      manager,
      new ObsidianLenteNoteStats(app.vault),
      this.diagnostics
    );
    return {
      search: (query, options = {}) =>
        search.search(query, {
          ...options,
          searchMethod: settings.lente.searchMethod,
          maxResults: settings.lente.maxResults,
        }),
    };
  }

  private replaceLenteSearch(app: any, refreshSubmitted = true): void {
    const manager = this.index;
    if (!manager || !app?.vault) return;
    this.lenteSearch = this.createLenteSearch(manager, app, this.getSettings());
    this.composeLenteViews(app);
    if (refreshSubmitted) this.refreshOpenLente(app);
  }

  private replaceChatModel(settings: TramaSettings): void {
    const model = new LmStudioChatModel({
      ...settings.chat,
      transport: new LmStudioTransport({
        policy: new EndpointPolicy({ approvals: settings.approvedOrigins }),
      }),
      diagnostics: this.diagnostics,
    });
    this.chatModel = model;
    this.session?.replaceModel(model);
  }

  private refreshOpenRelatedSuggestions(app: any): void {
    for (const leaf of app.workspace.getLeavesOfType?.("trama-voce") ?? []) {
      const view = (leaf as { view?: { refreshRelatedSuggestions?: () => void } }).view;
      view?.refreshRelatedSuggestions?.();
    }
  }

  private refreshOpenFilo(app: any): void {
    for (const leaf of app.workspace.getLeavesOfType?.("trama-filo") ?? []) {
      const view = (leaf as { view?: { refreshRelatedSuggestions?: () => void } }).view;
      view?.refreshRelatedSuggestions?.();
    }
  }

  private invalidateOpenExcludedResults(app: any, paths: readonly string[]): void {
    if (!app?.workspace) return;
    this.refreshOpenRelatedSuggestions(app);
    for (const leaf of app.workspace.getLeavesOfType?.("trama-filo") ?? []) {
      const view = (
        leaf as { view?: { invalidateExcludedPaths?: (paths: readonly string[]) => void } }
      ).view;
      view?.invalidateExcludedPaths?.(paths);
    }
    for (const leaf of app.workspace.getLeavesOfType?.("trama-lente") ?? []) {
      const view = (
        leaf as { view?: { invalidateExcludedPaths?: (paths: readonly string[]) => void } }
      ).view;
      view?.invalidateExcludedPaths?.(paths);
    }
  }

  private refreshOpenLente(app: any): void {
    for (const leaf of app.workspace.getLeavesOfType?.("trama-lente") ?? []) {
      const view = (leaf as { view?: { refreshSubmitted?: () => void } }).view;
      view?.refreshSubmitted?.();
    }
  }

  private composeChatSession(
    app: any,
    settings: TramaSettings,
    readonlyVault: ObsidianReadonlyVault,
    existingRegistry?: ToolRegistry,
    existingTransport?: LmStudioTransport
  ): void {
    const transport =
      existingTransport ??
      new LmStudioTransport({
        policy: new EndpointPolicy({ approvals: settings.approvedOrigins }),
      });
    const registry =
      existingRegistry ??
      new ToolRegistry([
        new ReadNoteTool(readonlyVault),
        new DiscoverLinksTool(readonlyVault),
        new FollowLinkTool(readonlyVault),
        new VaultSearchTool(this.index!),
      ]);
    this.chatModel = new LmStudioChatModel({
      ...settings.chat,
      transport,
      diagnostics: this.diagnostics,
    });
    this.session = new ChatSession(this.chatModel, registry, readonlyVault, this.diagnostics);
    for (const leaf of app.workspace.getLeavesOfType?.("trama-voce") ?? []) {
      const view = (
        leaf as {
          view?: {
            setSession?: (session: ChatSession) => void;
            setRelatedNotes?: (relatedNotes?: RelatedNotes) => void;
          };
        }
      ).view;
      view?.setSession?.(this.session);
      view?.setRelatedNotes?.(this.relatedNotes);
    }
    for (const leaf of app.workspace.getLeavesOfType?.("trama-filo") ?? []) {
      const view = (leaf as { view?: { setDependencies?: (status: any, related: any) => void } })
        .view;
      view?.setDependencies?.(this.indexStatus, this.relatedNotes);
    }
    for (const leaf of app.workspace.getLeavesOfType?.("trama-lente") ?? []) {
      const view = (leaf as { view?: { setSearch?: (search: LenteSearchPort) => void } }).view;
      if (this.lenteSearch) view?.setSearch?.(this.lenteSearch);
    }
  }

  private composeLenteViews(app: any): void {
    for (const leaf of app.workspace.getLeavesOfType?.("trama-lente") ?? []) {
      const view = (leaf as { view?: { setSearch?: (search: LenteSearchPort) => void } }).view;
      if (this.lenteSearch) view?.setSearch?.(this.lenteSearch);
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

  getRelatedNotes(): RelatedNotes | undefined {
    return this.relatedNotes;
  }

  private armAutomaticWork(): void {
    if (this.getSettings().filo.automaticUpdates && this.queuedWork && this.indexReady)
      this.scheduleReconcile();
  }

  private stopAutomaticWork(markStale = true, rescheduleAfterAbort = false): void {
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = undefined;
    if (this.automaticAbort) {
      this.automaticAbort.abort();
      this.automaticAbort = undefined;
      if (rescheduleAfterAbort) this.automaticReschedulePending = true;
      this.queuedWork = true;
    }
    if (markStale && this.queuedWork) this.markQueuedWorkStale();
  }

  private cancelExplicitIndexForEligibilityChange(): void {
    const status = (
      this.indexStatus as { getStatus?: () => { kind?: string } } | undefined
    )?.getStatus?.();
    if (status?.kind === "building" || status?.kind === "cancelling") this.indexStatus?.cancel();
  }

  private markQueuedWorkStale(): void {
    if (!this.indexStatus) return;
    const manager = this.index as (IndexManager & { hasUsableIndex?: () => boolean }) | undefined;
    const hasLastGood = manager?.hasUsableIndex?.() ?? this.indexReady;
    this.indexStatus.markStale(hasLastGood);
  }

  private async pruneAddedExclusions(): Promise<boolean> {
    const manager = this.index;
    if (!manager) return true;
    const signal = this.lifecycleAbort?.signal ?? new AbortController().signal;
    let published = false;
    let failed = false;
    const wasBuilding = manager.isBuilding();
    try {
      published = await manager.pruneExcludedPaths(signal);
    } catch {
      // An automatic operation may have been cancelled immediately before the
      // prune call. Let that operation settle once, then retry this one local
      // deletion-only pass exactly once.
      if (wasBuilding) {
        try {
          await manager.waitForBuild().catch(() => undefined);
          published = await manager.pruneExcludedPaths(signal);
        } catch {
          published = false;
        }
      }
      failed = !published;
      if (failed && this.index === manager) {
        this.queuedWork = true;
        this.markQueuedWorkStale();
      }
    }
    if (this.index !== manager) return false;
    this.relatedNotes?.cancel();
    const app = (this as unknown as { app?: any }).app;
    if (!app?.workspace) return !failed;
    this.refreshOpenRelatedSuggestions(app);
    this.refreshOpenFilo(app);
    return !failed;
  }

  private queueRemovedExclusions(previousExcludedPaths: readonly string[]): void {
    const manager = this.index;
    const app = (this as unknown as { app?: any }).app;
    if (!manager || !app?.vault?.getMarkdownFiles) return;
    for (const file of app.vault.getMarkdownFiles()) {
      const path = file.path;
      if (
        !this.isVisibleMarkdown(path) ||
        !this.isIndexEligible(path) ||
        !isExcludedPath(path, previousExcludedPaths)
      )
        continue;
      manager.queueOperation({ kind: "create", path });
      if (!this.indexLoaded || !this.indexReady) this.pendingVaultChanges.add(path);
      this.queuedWork = true;
    }
    if (!this.queuedWork) return;
    if (this.getSettings().filo.automaticUpdates && this.indexReady) this.scheduleReconcile();
    else this.markQueuedWorkStale();
  }

  private async runFullIndex(signal: AbortSignal): Promise<void> {
    return this.runIndex(signal, true);
  }

  private async runIndex(signal: AbortSignal, force: boolean): Promise<void> {
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = undefined;
    this.stopAutomaticWork(false);
    const manager = this.index;
    if (!manager) throw new Error("Index is not initialized.");
    await this.indexLoad;
    if (this.index !== manager) throw new Error("Index was replaced during indexing.");
    const published = force
      ? (await manager.build(signal), true)
      : await manager.synchronizeWithPublication(signal);
    this.indexReady = true;
    const app = (this as unknown as { app?: any }).app;
    if (app?.workspace) this.refreshOpenRelatedSuggestions(app);
    if (published && app?.workspace) this.refreshOpenLente(app);
    this.pendingVaultChanges.clear();
    if (this.queuedWork) await this.reconcileNow("explicit", signal).catch(() => undefined);
    else if (this.visibleMarkdownCatalog().length === 0) this.indexStatus?.setEmpty(true);
    else this.indexStatus?.setReady();
  }

  private scheduleReconcile(): void {
    if (!this.getSettings().filo.automaticUpdates) return;
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.diagnostics.emit({
      area: "index",
      event: "index_operation",
      operation: "incremental",
      stage: "scheduled",
      durationMs: 1500,
      counts: { queued: this.queuedWork ? 1 : 0 },
    });
    this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined;
      void this.reconcileNow("automatic").catch(() => undefined);
    }, 1500);
  }

  private async reconcileNow(
    source: "automatic" | "explicit" = "explicit",
    explicitSignal?: AbortSignal
  ): Promise<void> {
    if (source === "automatic") {
      if (!this.getSettings().filo.automaticUpdates) return;
      if (!this.automaticAbort) this.automaticAbort = new AbortController();
    }
    const manager = this.index;
    if (!manager || !this.indexReady || !this.lifecycleAbort) return;
    // Explicit builds own the user-facing state. The queued work remains in
    // IndexManager and is picked up after the build commits or fails.
    if (manager.isBuilding()) return;
    if (this.reconcilePromise) return this.reconcilePromise;
    this.queuedWork = false;
    if (source === "automatic") this.indexStatus?.setUpdating();
    const operationSignal =
      source === "automatic"
        ? this.automaticAbort!.signal
        : (explicitSignal ?? this.lifecycleAbort.signal);
    let completed = false;
    this.reconcilePromise = manager
      .reconcileQueuedChanges(operationSignal)
      .then(() => {
        completed = true;
        const published = manager.getLastReconciliationPublished();
        const suppressLenteRefresh =
          source === "automatic" && this.suppressNextAutomaticLenteRefresh;
        if (suppressLenteRefresh) this.suppressNextAutomaticLenteRefresh = false;
        this.indexStatus?.setReady();
        const app = (this as unknown as { app?: any }).app;
        if (app?.workspace) this.refreshOpenRelatedSuggestions(app);
        if (published && !suppressLenteRefresh && app?.workspace) this.refreshOpenLente(app);
      })
      .catch((error) => {
        this.queuedWork = true;
        if (this.index === manager) this.indexStatus?.markStale(true);
        throw error;
      })
      .finally(() => {
        this.reconcilePromise = undefined;
        const shouldResumeAfterCancellation =
          source === "automatic" && this.automaticReschedulePending;
        if (
          source === "automatic" &&
          (completed || shouldResumeAfterCancellation) &&
          this.queuedWork &&
          this.indexReady &&
          this.getSettings().filo.automaticUpdates
        ) {
          this.automaticReschedulePending = false;
          this.scheduleReconcile();
        }
        if (source === "automatic" && this.automaticAbort?.signal === operationSignal)
          this.automaticAbort = undefined;
      });
    return this.reconcilePromise;
  }

  private registerVaultEvents(vault: any): void {
    this.registerVaultEvent(vault, "create", (file: TAbstractFile) =>
      this.queueVaultOperation({ kind: "create", path: file.path })
    );
    this.registerVaultEvent(vault, "modify", (file: TAbstractFile) =>
      this.queueVaultOperation({ kind: "modify", path: file.path })
    );
    this.registerVaultEvent(vault, "delete", (file: TAbstractFile) =>
      this.queueVaultOperation({ kind: "delete", path: file.path })
    );
    this.registerVaultEvent(vault, "rename", (file: TAbstractFile, oldPath: string) => {
      const oldEligible = this.isIndexEligible(oldPath);
      const newEligible = this.isIndexEligible(file.path);
      if (oldEligible && newEligible)
        this.queueVaultOperation({ kind: "rename", oldPath, path: file.path });
      else if (oldEligible) this.queueVaultOperation({ kind: "delete", path: oldPath });
      else if (newEligible) this.queueVaultOperation({ kind: "create", path: file.path });
    });
  }
  private registerVaultEvent(vault: any, event: string, callback: (...args: any[]) => void): void {
    const ref = vault.on(event, callback);
    this.eventRefs.push(ref);
    this.registerEvent(ref);
  }
  private queueVaultOperation(
    operation:
      | { kind: "create" | "modify" | "delete" | "empty" | "unchanged"; path: string }
      | { kind: "rename"; oldPath: string; path: string }
  ): void {
    const paths =
      operation.kind === "rename" ? [operation.oldPath, operation.path] : [operation.path];
    if (paths.every((path) => !this.isIndexEligible(path)) || !this.index) return;
    this.diagnostics.emit({
      area: "index",
      event: "index_operation",
      operation: "incremental",
      stage: "queued",
      path: operation.path,
      counts: { automatic: this.getSettings().filo.automaticUpdates ? 1 : 0 },
    });
    if (!this.indexLoaded || !this.indexReady) {
      if (operation.kind === "rename") this.index.queueRename(operation.oldPath, operation.path);
      else this.index.queueOperation(operation as any);
      for (const path of paths) this.pendingVaultChanges.add(path);
      this.queuedWork = true;
      return;
    }
    this.queuedWork = true;
    if (operation.kind === "rename") this.index.queueRename(operation.oldPath, operation.path);
    else this.index.queueOperation(operation as any);
    if (this.getSettings().filo.automaticUpdates) {
      if (!this.index.isBuilding()) this.indexStatus?.setUpdating();
      this.scheduleReconcile();
    } else {
      this.markQueuedWorkStale();
    }
  }

  private isIndexEligible(path: string): boolean {
    return (
      this.isVisibleMarkdown(path) && !isExcludedPath(path, this.getSettings().filo.excludedPaths)
    );
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
      !path.startsWith(".trama/")
    );
  }
}
