import { Platform, Plugin } from "obsidian";
import { composeRuntime as composePluginRuntime } from "@/plugin/RuntimeComposition";
import { formatDiagnosticLogLine, TramaDiagnostics } from "@/diagnostics/TramaDiagnostics";
import {
  IndexManager,
  type IndexPathMutation,
  type IndexOperationResult,
} from "@/index/IndexManager";
import { compareCodeUnits } from "@/index/Identity";
import { LmStudioEmbeddingModel } from "@/providers/lmStudio/LmStudioEmbeddingModel";
import { EndpointPolicy } from "@/security/EndpointPolicy";
import { DEFAULT_SETTINGS, SettingsStore, TramaSettings } from "@/settings/Settings";
import { IndexStatusController } from "@/ui/index/IndexStatus";
import { RelatedNotes } from "@/index/RelatedNotes";
import { ModelRuntime } from "@/plugin/ModelRuntime";
import { loadPluginUi, registerPluginUi } from "@/plugin/PluginUi";
import { ExplicitIndexOperations } from "@/plugin/ExplicitIndexOperations";
import type { SqliteWorkerClient, SqliteWorkerLike } from "@/index/sqlite/client";
import {
  PublicationManager,
  type PublicationWarning,
} from "@/index/publications/PublicationManager";
import { AutomaticLexicalController } from "@/plugin/AutomaticLexicalController";
import { AutomaticPublicationController } from "@/plugin/AutomaticPublicationController";
import { AutomaticSemanticController } from "@/plugin/AutomaticSemanticController";
import type { SchedulerSource, SchedulerTransition } from "@/plugin/scheduler";
import { VaultEventRouter } from "@/plugin/VaultEventRouter";
import { SqliteRuntime } from "@/plugin/SqliteRuntime";
import { schedulerStatusMessage } from "@/plugin/SchedulerStatus";

/** Composes the shared assistant and owns its lifecycle and vault event boundary. */
export class TramaPlugin extends Plugin {
  private runtimeLoaded = false;
  private readonly settingsStore = new SettingsStore();
  private embeddingModel?: LmStudioEmbeddingModel;
  private index?: IndexManager;
  private indexStatus?: IndexStatusController;
  private relatedNotes?: RelatedNotes;
  private lifecycleAbort?: AbortController;
  private indexLoad?: Promise<boolean>;
  private indexLoaded = false;
  private indexReady = false;
  private compositionRevision = 0;
  private vaultEventRevision = 0;
  private layoutReady = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private publicationManager?: PublicationManager;
  private quitPublicationPromise?: Promise<void>;
  private currentSchedulerSource: SchedulerSource = "explicit";
  /** Test-only explicit backend injection; production composition leaves this unset. */
  sqliteClientFactory?: (storage: object) => SqliteWorkerClient;
  private visibleMarkdownCatalog: () => readonly string[] = () => [];
  private contextNoteSuggestions: () => readonly string[] = () => [];
  private lastActiveMarkdownPath?: string;
  private readonly diagnostics: TramaDiagnostics = {
    emit: (record) => {
      if (this.settingsStore.get().detailedDebug) {
        // This opt-in sink intentionally writes complete diagnostic payloads to the developer console.
        try {
          const operation =
            record.event === "index_operation"
              ? ` ${record.operation}${record.phase ? `/${record.phase}` : ""}`
              : "";
          const stage = "stage" in record ? ` ${record.stage}` : "";
          const duration =
            "durationMs" in record && typeof record.durationMs === "number"
              ? ` ${Math.round(record.durationMs)} ms`
              : "";
          // eslint-disable-next-line no-console
          console.info(
            formatDiagnosticLogLine(record) ??
              `[Trama] ${record.area}:${record.event}${operation}${stage}${duration}`,
            record
          );
        } catch {
          // Console instrumentation is observational and must not break chat or indexing.
        }
      }
    },
  };
  private readonly sqliteRuntime = new SqliteRuntime(() => this.manifest);
  private readonly modelRuntime = new ModelRuntime({
    diagnostics: this.diagnostics,
    getSettings: () => this.getSettings(),
    getIndex: () => this.index,
    getIndexStatus: () => this.indexStatus,
    getRelatedNotes: () => this.relatedNotes,
  });
  private readonly semanticScheduler = new AutomaticSemanticController({
    diagnostics: this.diagnostics,
    getSettings: () => this.getSettings(),
    getIndex: () => this.index,
    getIndexStatus: () => this.indexStatus,
    isIndexReady: () => this.indexReady,
    getVaultEventRevision: () => this.vaultEventRevision,
    hasQueuedLexicalWork: () => this.lexicalScheduler.hasQueuedWork(),
    hasActiveLexicalReconciliation: () => this.lexicalScheduler.hasActiveReconciliation(),
    getSchedulerSource: () => this.currentSchedulerSource,
    setSchedulerSource: (source) => (this.currentSchedulerSource = source),
    emitSchedulerTransition: (transition) => this.emitSchedulerTransition(transition),
    refreshSchedulerMessage: () => this.refreshSchedulerMessage(),
    updateIndexCapabilities: (manager) => this.updateIndexCapabilities(manager),
  });
  private readonly publicationScheduler = new AutomaticPublicationController({
    diagnostics: this.diagnostics,
    getSettings: () => this.getSettings(),
    getIndex: () => this.index,
    getIndexStatus: () => this.indexStatus,
    getPublicationManager: () => this.publicationManager,
    isIndexReady: () => this.indexReady,
    getVaultEventRevision: () => this.vaultEventRevision,
    hasQueuedLexicalWork: () => this.lexicalScheduler.hasQueuedWork(),
    hasActiveLexicalReconciliation: () => this.lexicalScheduler.hasActiveReconciliation(),
    getSchedulerSource: () => this.currentSchedulerSource,
    setPublicationWarning: (warning) => {
      if (warning) this.handlePublicationWarning(warning);
      else this.indexStatus?.setPublicationWarning(undefined);
    },
    emitSchedulerTransition: (transition) => this.emitSchedulerTransition(transition),
    refreshSchedulerMessage: () => this.refreshSchedulerMessage(),
    updateIndexCapabilities: (manager) => this.updateIndexCapabilities(manager),
  });
  private readonly lexicalScheduler = new AutomaticLexicalController({
    diagnostics: this.diagnostics,
    getSettings: () => this.getSettings(),
    getIndex: () => this.index,
    getIndexStatus: () => this.indexStatus,
    isIndexReady: () => this.indexReady,
    getIndexLoaded: () => this.indexLoaded,
    getLayoutReady: () => this.layoutReady,
    getLifecycleSignal: () => this.lifecycleAbort?.signal,
    getVaultEventRevision: () => this.vaultEventRevision,
    getSchedulerSource: () => this.currentSchedulerSource,
    setSchedulerSource: (source) => (this.currentSchedulerSource = source),
    incrementVaultEventRevision: () => {
      this.vaultEventRevision++;
    },
    pausePublication: () => this.publicationScheduler.pauseForIndexing(),
    pauseSemantic: () => this.semanticScheduler.pauseForLexicalWork(),
    markSemanticEligible: () => this.semanticScheduler.markEligibleIfPending(this.index),
    scheduleSemantic: () => this.semanticScheduler.schedule(),
    refreshViews: (changed) => {
      const app = (this as unknown as { app?: any }).app;
      if (app?.workspace) this.modelRuntime.refreshOpenRelatedSuggestions(app);
      if (changed && app?.workspace) this.modelRuntime.refreshOpenLente(app);
    },
    emitSchedulerTransition: (transition) => this.emitSchedulerTransition(transition),
    refreshSchedulerMessage: () => this.refreshSchedulerMessage(),
    updateIndexCapabilities: (manager) => this.updateIndexCapabilities(manager),
  });
  private readonly vaultEvents = new VaultEventRouter({
    getSettings: () => this.getSettings(),
    getConfigDirectory: () =>
      (this as unknown as { app?: { vault?: { configDir?: string } } }).app?.vault?.configDir ??
      ".obsidian",
    registerEvent: (ref) => this.registerEvent(ref),
    notifyPublicationFileEvent: (path) => this.notifyPublicationFileEvent(path),
    queueMutation: (mutation) => this.queueVaultMutation(mutation),
    requestFullRecovery: (path) => this.requestFullRecovery(path),
  });
  private readonly explicitIndex = new ExplicitIndexOperations({
    getApp: () => (this as unknown as { app?: any }).app,
    getSettings: () => this.getSettings(),
    getIndex: () => this.index,
    getIndexStatus: () => this.indexStatus,
    getIndexLoad: () => this.indexLoad,
    isIndexReady: () => this.indexReady,
    setIndexReady: (ready) => (this.indexReady = ready),
    getVaultEventRevision: () => this.vaultEventRevision,
    getSchedulerSource: () => this.currentSchedulerSource,
    setSchedulerSource: (source) => (this.currentSchedulerSource = source),
    getVisibleMarkdownCount: () => this.visibleMarkdownCatalog().length,
    isQueued: () => this.lexicalScheduler.hasQueuedWork(),
    clearQueued: () => this.lexicalScheduler.clearQueuedWork(),
    getLexicalPromise: () => this.lexicalScheduler.activeReconciliation(),
    getSemanticPromise: () => this.semanticScheduler.activeWork(),
    pausePublication: () => this.publicationScheduler.pauseForIndexing(),
    stopLexical: (markStale) => this.lexicalScheduler.stop(markStale),
    pauseSemantic: () => this.semanticScheduler.pauseForLexicalWork(),
    stopSemantic: () => this.semanticScheduler.stop(),
    resetManualSchedulerState: () => {
      this.lexicalScheduler.resetForManualOperation();
      this.semanticScheduler.resetForManualOperation();
    },
    markSemanticEligible: () => this.semanticScheduler.markEligibleIfPending(this.index),
    clearSemanticEligibility: () => this.semanticScheduler.clearEligibility(),
    scheduleSemantic: () => this.semanticScheduler.schedule(),
    scheduleLexical: () => this.lexicalScheduler.schedule(),
    reconcile: (signal) => this.lexicalScheduler.reconcile("explicit", signal),
    updateCapabilities: (manager) => this.updateIndexCapabilities(manager),
    refreshViews: (changed) => {
      const app = (this as unknown as { app?: any }).app;
      if (app?.workspace) this.modelRuntime.refreshOpenRelatedSuggestions(app);
      if (changed && app?.workspace) this.modelRuntime.refreshOpenLente(app);
    },
    emit: (transition) => this.emitSchedulerTransition(transition),
  });

  override async onload(): Promise<void> {
    this.runtimeLoaded = true;
    if (typeof this.loadData === "function") {
      try {
        this.settingsStore.load(await this.loadData());
      } catch {
        // A settings read failure must not prevent the offline shell from loading.
        this.settingsStore.load(undefined);
      }
    }
    const app = (this as unknown as { app?: any }).app;
    if (!app?.vault || !app.workspace || !app.metadataCache) return;
    if (Platform.isDesktopApp) {
      const quitRef = app.workspace.on?.(
        "quit",
        (tasks: { addPromise(promise: Promise<any>): void }) => {
          this.publicationManager?.stopInboundEvents();
          const task = this.publishOnQuit();
          if (task) {
            this.quitPublicationPromise = task;
            tasks.addPromise(task);
          }
        }
      );
      if (quitRef) this.registerEvent(quitRef);
    }
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
    const ui = await loadPluginUi();
    this.lifecycleAbort = new AbortController();
    const settings = this.settingsStore.get();
    this.composeRuntime(app, settings);
    const layoutReady = () => {
      this.layoutReady = true;
      this.lexicalScheduler.maybeScheduleStartupRecovery();
    };
    if (typeof app.workspace.onLayoutReady === "function") app.workspace.onLayoutReady(layoutReady);
    else layoutReady();
    this.indexStatus = new IndexStatusController(
      this,
      {
        index: (signal) => this.runIndex(signal, false),
        reindex: (signal) => this.runFullIndex(signal),
        prepare: (signal) => this.runSemanticPreparation(signal),
        rebuildSemantic: (signal) => this.runSemanticPreparation(signal, true),
        rebuildBoth: (signal) => this.runBothIndexes(signal),
        forceUpdate: (signal) => this.runForceUpdate(signal),
        publishNow: () => this.retryPublication(),
        cancel: () => this.cancelActiveIndexOperation(),
        onOperationReleased: () => {
          // Let the operation and its shared lease settle before handing the
          // sticky semantic request back to the automatic scheduler.
          void Promise.resolve().then(() => this.semanticScheduler.notifyBlockerCleared("event"));
        },
      },
      this.diagnostics
    );
    this.indexStatus.register();
    registerPluginUi(this, app, ui, {
      session: this.modelRuntime.session!,
      status: this.indexStatus,
      relatedNotes: this.relatedNotes,
      visibleMarkdownCatalog: this.visibleMarkdownCatalog,
      contextNoteSuggestions: this.contextNoteSuggestions,
      getLenteSearch: () => this.modelRuntime.lenteSearch,
      getSettings: () => this.getSettings(),
    });
    this.registerVaultEvents(app.vault);
  }

  override onunload(): void {
    this.indexReady = false;
    this.stopAutomaticSemanticWork();
    this.stopAutomaticPublication();
    this.explicitIndex.semanticAbort?.abort();
    this.explicitIndex.semanticAbort = undefined;
    this.publicationManager?.dispose();
    const index = this.index;
    if (index && this.quitPublicationPromise) {
      void this.quitPublicationPromise.finally(() => index.disposeImmediately());
    } else {
      index?.disposeImmediately();
    }
    this.index = undefined;
    this.indexStatus?.cancel();
    this.lifecycleAbort?.abort();
    this.stopAutomaticWork(false);
    this.relatedNotes?.cancel();
    this.relatedNotes = undefined;
    this.modelRuntime.session?.cancel();
    this.vaultEvents.dispose();
    this.publicationManager = undefined;
    this.runtimeLoaded = false;
  }
  isDesktopLoaded(): boolean {
    return this.runtimeLoaded;
  }
  isRuntimeLoaded(): boolean {
    return this.runtimeLoaded;
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
    const exclusionsChanged =
      before.filo.excludedPaths.length !== saved.filo.excludedPaths.length ||
      before.filo.excludedPaths.some((path, index) => path !== saved.filo.excludedPaths[index]);
    const indexDefinitionChanged = embeddingChanged || exclusionsChanged;
    const publicationDirectoryChanged = before.publicationDirectory !== saved.publicationDirectory;
    const automaticSemanticDelayChanged =
      before.filo.automaticSemanticDelayMs !== saved.filo.automaticSemanticDelayMs;
    const automaticPublicationDelayChanged =
      before.filo.automaticPublicationDelayMs !== saved.filo.automaticPublicationDelayMs;
    const app = (this as unknown as { app?: any }).app;

    if (!saved.filo.automaticLexicalDelayMs) {
      this.stopAutomaticWork(true, before.filo.automaticLexicalDelayMs > 0);
      this.emitSchedulerTransition({
        channel: "lexical",
        stage: "disabled",
        source: "explicit",
        counts: { queued: this.index?.pendingChangeCount() ?? 0 },
      });
    } else if (before.filo.automaticLexicalDelayMs !== saved.filo.automaticLexicalDelayMs)
      this.lexicalScheduler.arm();

    if (indexDefinitionChanged || publicationDirectoryChanged) {
      this.stopAutomaticWork(false);
      this.stopAutomaticPublication();
      this.publicationManager?.dispose();
      this.modelRuntime.session?.cancel();
      this.explicitIndex.semanticAbort?.abort();
      this.explicitIndex.semanticAbort = undefined;
      this.stopAutomaticSemanticWork();
      this.semanticScheduler.clearEligibility();
      this.relatedNotes?.cancel();
      this.indexStatus?.cancel();
      const oldIndex = this.index;
      oldIndex?.invalidate();
      this.lifecycleAbort?.abort();
      try {
        await oldIndex?.waitForBuild();
      } catch {
        // The old build is intentionally cancelled before composing its replacement.
      }
      await oldIndex?.dispose();
      this.lifecycleAbort = new AbortController();
      this.indexStatus?.markStale(false);
    }
    if (app?.vault && app.workspace && app.metadataCache && this.modelRuntime.session) {
      if (chatChanged && !indexDefinitionChanged && !publicationDirectoryChanged)
        this.modelRuntime.replaceChatModel(saved);
      else if (indexDefinitionChanged || publicationDirectoryChanged)
        this.composeRuntime(app, saved);
    }

    if (lenteChanged && !indexDefinitionChanged && this.index)
      this.modelRuntime.replaceLenteSearch(app);
    if (automaticSemanticDelayChanged) {
      if (saved.filo.automaticSemanticDelayMs <= 0) {
        this.stopAutomaticSemanticWork();
        this.emitSchedulerTransition({
          channel: "semantic",
          stage: "disabled",
          source: "explicit",
        });
      } else {
        this.semanticScheduler.resetForSettings();
        this.semanticScheduler.markEligibleIfPending(this.index);
        this.scheduleAutomaticSemantic("event");
      }
    }
    if (automaticPublicationDelayChanged) {
      this.publicationScheduler.resetForSettings();
      if (saved.filo.automaticPublicationDelayMs <= 0) {
        this.stopAutomaticPublication();
        this.emitSchedulerTransition({
          channel: "publication",
          stage: "disabled",
          source: "explicit",
        });
      } else this.scheduleAutomaticPublication();
    }
    this.refreshSchedulerMessage();
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
    const compositionRevision = ++this.compositionRevision;
    this.indexLoaded = false;
    this.indexReady = false;
    this.lexicalScheduler.resetForRuntimeComposition();
    const runtime = composePluginRuntime(
      {
        diagnostics: this.diagnostics,
        modelRuntime: this.modelRuntime,
        isVisibleMarkdown: (path) => this.isVisibleMarkdown(path),
        createWorker: (currentApp) => this.createSqliteWorker(currentApp),
        resolveIdentity: (adapter) => this.resolveSqliteIdentity(adapter),
        createClient: (storage) => this.sqliteClientFactory?.(storage),
        getIndexStatus: () => this.indexStatus,
        getVisibleMarkdownCount: () => this.visibleMarkdownCatalog().length,
        suppressRebuildPublication: () => this.explicitIndex.combinedRebuildLexicalPhase,
        onComposed: ({ manager, publication, relatedNotes, embedding }) => {
          this.index = manager;
          this.publicationManager = publication;
          this.relatedNotes?.cancel();
          this.relatedNotes = relatedNotes;
          this.embeddingModel = embedding;
        },
        onSuccessfulOperation: (manager, publication, result) =>
          this.recordAutomaticPublicationIntent(manager, publication, result),
        onPublicationWarning: (manager, warning) => {
          if (this.index === manager) this.handlePublicationWarning(warning);
        },
        onPublicationMetrics: (manager) => this.updateIndexCapabilities(manager),
        onPublicationSettled: (manager) => {
          if (this.index === manager) this.semanticScheduler.notifyBlockerCleared("event");
        },
        onPublicationAdopted: (manager, publication, adopted) => {
          if (adopted && this.publicationManager === publication)
            this.applyPublicationAdoption(manager);
        },
        onInitialState: (manager, loaded) => {
          const usable = loaded && manager.capabilities().availability !== "unavailable";
          if (!usable || this.index !== manager || compositionRevision !== this.compositionRevision)
            return;
          this.indexLoaded = true;
          this.indexReady = true;
          this.updateIndexCapabilities(manager);
          if (manager.isComplete()) {
            if (this.visibleMarkdownCatalog().length === 0) this.indexStatus?.setEmpty(true, true);
            else this.indexStatus?.setReady(true);
          } else if (manager.hasUsableIndex()) this.indexStatus?.markStale(true);
          else this.indexStatus?.setIndexRequired(true);
        },
        onLoadSettled: (manager, loaded, currentApp) =>
          this.finishRuntimeLoad(manager, loaded, currentApp, compositionRevision),
      },
      app,
      settings
    );
    this.indexLoad = runtime.load;
  }

  private finishRuntimeLoad(
    manager: IndexManager,
    loaded: boolean,
    app: any,
    compositionRevision: number
  ): void {
    if (this.index !== manager || compositionRevision !== this.compositionRevision) return;
    const usable = loaded && manager.capabilities().availability !== "unavailable";
    this.indexLoaded = usable;
    this.indexReady = usable;
    this.updateIndexCapabilities(manager);
    this.semanticScheduler.markEligibleIfPending(manager);
    if (!usable || !manager.isComplete()) {
      if (manager.hasUsableIndex()) this.indexStatus?.markStale(true);
      else this.indexStatus?.setIndexRequired(true);
      if (usable) this.lexicalScheduler.maybeScheduleStartupRecovery();
      return;
    }
    if (this.visibleMarkdownCatalog().length === 0) this.indexStatus?.setEmpty(true, true);
    else this.indexStatus?.setReady(true);
    this.modelRuntime.refreshOpenRelatedSuggestions(app);
    this.lexicalScheduler.maybeScheduleStartupRecovery();
    this.semanticScheduler.replaceEligibility(manager);
    if (!manager.hasPendingWork()) this.scheduleAutomaticSemantic("startup");
    if (
      this.lexicalScheduler.hasQueuedWork() &&
      this.getSettings().filo.automaticLexicalDelayMs > 0
    )
      this.scheduleReconcile(manager.hasPendingWork() ? "startup" : "event");
    else if (this.lexicalScheduler.hasQueuedWork()) this.markQueuedWorkStale();
  }

  private resolveSqliteIdentity(
    adapter: import("@/index/IndexManager").SnapshotDataAdapter
  ): Promise<string> {
    return this.sqliteRuntime.resolveIdentity(adapter);
  }

  private createSqliteWorker(app: any): SqliteWorkerLike {
    return this.sqliteRuntime.createWorker(app);
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
      if (!this.modelRuntime.chatModel) throw new Error("Assistant is not initialized.");
      return this.modelRuntime.chatModel.discoverModels(signal);
    }
    if (!this.embeddingModel) throw new Error("Assistant is not initialized.");
    return this.embeddingModel.discoverModels(signal);
  }

  /** Retries the last staged publication without rerunning local indexing. */
  async retryPublication(): Promise<void> {
    await this.publicationScheduler.retryExplicit(this.publicationManager);
  }

  async prepareSemantic(): Promise<void> {
    await this.explicitIndex.prepareSemantic();
  }

  async updateLexical(): Promise<void> {
    await this.indexStatus?.run("index");
  }

  async rebuildLexical(): Promise<void> {
    await this.indexStatus?.run("reindex");
  }

  async rebuildSemantic(): Promise<void> {
    await this.indexStatus?.run("rebuild-semantic");
  }

  async rebuildBothIndexes(): Promise<void> {
    await this.indexStatus?.run("rebuild-both");
  }

  async forceUpdateIndexes(): Promise<void> {
    await this.indexStatus?.run("force-update");
  }

  private runForceUpdate(signal: AbortSignal): Promise<void> {
    return this.explicitIndex.forceUpdate(signal);
  }

  private runSemanticPreparation(signal: AbortSignal, rebuild = false): Promise<void> {
    return this.explicitIndex.runSemanticPreparation(signal, rebuild);
  }

  getIndexStatus(): ReturnType<IndexStatusController["getStatus"]> | undefined {
    return this.indexStatus?.getStatus();
  }

  getPublicationMetrics(): { byteSize: number; durationMs: number } | undefined {
    const metrics = this.publicationManager?.metrics;
    return metrics ? { byteSize: metrics.byteSize, durationMs: metrics.durationMs } : undefined;
  }

  /** Checks the exact configured synchronized file and adopts it when its ID differs. */
  async checkPublication(): Promise<void> {
    const manager = this.publicationManager;
    const result = await manager?.adoptCurrent();
    if (result?.warning) this.handlePublicationWarning(result.warning);
    else if (result?.adopted && manager && this.index) this.applyPublicationAdoption(this.index);
  }

  private applyPublicationAdoption(manager: IndexManager): void {
    if (this.index !== manager) return;
    this.clearPublicationIntentAfterAdoption();
    this.updateIndexCapabilities(manager);
    this.indexReady = true;
    this.indexStatus?.setPublicationWarning(undefined);
    const app = (this as unknown as { app?: any }).app;
    this.modelRuntime.refreshOpenRelatedSuggestions(app);
    this.modelRuntime.refreshOpenLente(app);
  }

  getRelatedNotes(): RelatedNotes | undefined {
    return this.relatedNotes;
  }

  private updateIndexCapabilities(manager: IndexManager): void {
    if (this.index !== manager || !this.indexStatus) return;
    this.indexStatus.setCapabilities(manager.capabilities());
    this.semanticScheduler.notifyBlockerCleared("event");
  }

  private emitSchedulerTransition(transition: SchedulerTransition): void {
    this.diagnostics.emit({
      area: "index",
      event: "index_operation",
      operation: transition.channel === "publication" ? "publication" : "status",
      stage: transition.stage,
      channel: transition.channel,
      source: transition.source,
      ...(transition.delayMs === undefined ? {} : { delayMs: transition.delayMs }),
      ...(transition.retryAttempt === undefined ? {} : { retryAttempt: transition.retryAttempt }),
      ...(transition.durationMs === undefined ? {} : { durationMs: transition.durationMs }),
      ...(transition.counts === undefined ? {} : { counts: transition.counts }),
      ...(transition.publicationSizeBytes === undefined
        ? {}
        : { publicationSizeBytes: transition.publicationSizeBytes }),
      ...(transition.phase === undefined ? {} : { phase: transition.phase }),
      ...(transition.deferredReason === undefined
        ? {}
        : { deferredReason: transition.deferredReason }),
      ...(transition.error === undefined ? {} : { error: transition.error }),
    });
    this.refreshSchedulerMessage();
  }

  private refreshSchedulerMessage(): void {
    if (!this.indexStatus) return;
    const message = schedulerStatusMessage({
      settings: this.getSettings().filo,
      lexical: this.lexicalScheduler.snapshot(),
      semantic: {
        ...this.semanticScheduler.snapshot(),
        indexComplete: this.index?.isComplete() ?? false,
        searchable: this.index?.capabilities().semantic.searchable ?? false,
      },
      publication: this.publicationScheduler.snapshot(),
    });
    if (this.indexStatus.getStatus().schedulerMessage !== message)
      this.indexStatus.setSchedulerMessage(message);
  }

  private recordAutomaticPublicationIntent(
    manager: IndexManager,
    publication: PublicationManager | undefined,
    result: IndexOperationResult
  ): void {
    if (this.index === manager && this.publicationManager === publication)
      this.publicationScheduler.recordIntent(publication, result);
  }

  private scheduleAutomaticPublication(
    delay = this.getSettings().filo.automaticPublicationDelayMs,
    source: SchedulerSource = this.currentSchedulerSource
  ): void {
    this.publicationScheduler.schedule(delay, source);
  }

  private publishOnQuit(): Promise<void> | undefined {
    return this.publicationScheduler.publishOnQuit(this.publicationManager);
  }

  private stopAutomaticPublication(): void {
    this.publicationScheduler.stop();
  }

  private clearPublicationIntentAfterAdoption(): void {
    this.publicationScheduler.stop();
    this.refreshSchedulerMessage();
  }

  private handlePublicationWarning(_warning: PublicationWarning): void {
    if (this.indexStatus)
      this.indexStatus.setPublicationWarning("Index saved locally, but publication failed.");
  }

  private notifyPublicationFileEvent(path: string): void {
    const manager = this.publicationManager;
    if (!manager || path !== manager.store.path) return;
    manager.notifyFileEvent(path);
  }

  private stopAutomaticSemanticWork(): void {
    this.semanticScheduler.stop();
  }

  /** Cancels the operation currently shown by Filo and suppresses automatic rescheduling. */
  private cancelActiveIndexOperation(): void {
    this.lexicalScheduler.cancelActive();
    this.semanticScheduler.cancelActive();
    // Explicit semantic work is owned by the same status lease, while this
    // controller remains a compatibility path for callers outside Filo.
    this.explicitIndex.semanticAbort?.abort();
  }

  private scheduleAutomaticSemantic(source: SchedulerSource = "event"): void {
    this.semanticScheduler.schedule(source);
  }

  private stopAutomaticWork(markStale = true, rescheduleAfterAbort = false): void {
    this.lexicalScheduler.stop(markStale, rescheduleAfterAbort);
  }

  private markQueuedWorkStale(): void {
    this.lexicalScheduler.markStale();
  }

  private runFullIndex(signal: AbortSignal): Promise<void> {
    return this.explicitIndex.runFullIndex(signal);
  }

  private runBothIndexes(signal: AbortSignal): Promise<void> {
    return this.explicitIndex.runBothIndexes(signal);
  }

  private runIndex(signal: AbortSignal, force: boolean, settleStatus = true): Promise<void> {
    return this.explicitIndex.runIndex(signal, force, settleStatus);
  }

  private scheduleReconcile(source: SchedulerSource = "event"): void {
    this.lexicalScheduler.schedule(source);
  }

  private registerVaultEvents(vault: any): void {
    this.vaultEvents.register(vault);
  }

  private queueVaultMutation(mutation: IndexPathMutation): void {
    this.lexicalScheduler.queueMutation(mutation);
  }

  private requestFullRecovery(path?: string): void {
    if (!path || !this.isPublicationPath(path)) this.lexicalScheduler.requestFullRecovery();
  }

  private isPublicationPath(path: string): boolean {
    return this.vaultEvents.isPublicationPath(path);
  }

  private isVisibleMarkdown(path: string): boolean {
    return this.vaultEvents.isVisibleMarkdown(path);
  }
}
