import { Notice, Plugin } from "obsidian";
import { readBenchmarkManifest } from "@/benchmark/Manifest";
import {
  runObsidianBenchmark,
  writeBenchmarkFailureReport,
  writeBenchmarkReport,
} from "@/benchmark/ObsidianBenchmark";
import { createTramaDiagnostics, formatDiagnosticLogLine } from "@/diagnostics/TramaDiagnostics";
import { compareCodeUnits } from "@/index/Identity";
import { IndexManager, type IndexPathMutation } from "@/index/IndexManager";
import type { MaintenanceSnapshot } from "@/index/MaintenanceScheduler";
import type { AdoptionResult, PublicationWarning } from "@/index/publications/PublicationManager";
import { PublicationManager } from "@/index/publications/PublicationManager";
import { RelatedNotes } from "@/index/RelatedNotes";
import type { SqliteWorkerLike } from "@/index/sqlite/client";
import { ModelRuntime } from "@/plugin/ModelRuntime";
import { loadPluginUi, registerPluginUi } from "@/plugin/PluginUi";
import {
  composeRuntime as composePluginRuntime,
  type ComposedRuntime,
} from "@/plugin/RuntimeComposition";
import { SqliteRuntime } from "@/plugin/SqliteRuntime";
import { VaultEventRouter } from "@/plugin/VaultEventRouter";
import { LmStudioEmbeddingModel } from "@/providers/lmStudio/LmStudioEmbeddingModel";
import { EndpointPolicy } from "@/security/EndpointPolicy";
import { DEFAULT_SETTINGS, SettingsStore, TramaSettings } from "@/settings/Settings";
import { IndexStatusController } from "@/ui/index/IndexStatus";

/** Composes the shared assistant and owns its lifecycle and vault-event boundary. */
export class TramaPlugin extends Plugin {
  private runtimeLoaded = false;
  private readonly settingsStore = new SettingsStore();
  private embeddingModel?: LmStudioEmbeddingModel;
  private index?: IndexManager;
  private indexStatus?: IndexStatusController;
  private relatedNotes?: RelatedNotes;
  private indexLoad?: Promise<boolean>;
  // Read by the host benchmark's synchronous readiness evaluation.
  indexLoadResult?: boolean;
  private maintenance?: ComposedRuntime["scheduler"];
  private publicationManager?: PublicationManager;
  private publicationEventCheck?: {
    readonly revision: number;
    readonly scheduler: ComposedRuntime["scheduler"];
    readonly manager: IndexManager;
    started: boolean;
    dirty: boolean;
  };
  private compositionRevision = 0;
  private compositionReplacement = false;
  private compositionDirty = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly publicationWarnings: Partial<Record<"publication" | "check", string>> = {};
  private projectedPublicationWarning?: string;
  private upgradeNoticeShown = false;
  private benchmarkRunning = false;
  private benchmarkResetting = false;
  private visibleMarkdownCatalog: () => readonly string[] = () => [];
  private contextNoteSuggestions: () => readonly string[] = () => [];
  private lastActiveMarkdownPath?: string;

  private readonly diagnostics = createTramaDiagnostics(
    () => this.settingsStore.get().diagnosticsMode,
    (record) => {
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
    },
    {
      sessionId:
        globalThis.crypto?.randomUUID?.() ?? `trama-${Math.random().toString(36).slice(2)}`,
    }
  );

  private readonly sqliteRuntime = new SqliteRuntime(() => this.manifest);
  private readonly modelRuntime = new ModelRuntime({
    diagnostics: this.diagnostics,
    getSettings: () => this.getSettings(),
    getIndex: () => this.index,
    getIndexStatus: () => this.indexStatus,
    getRelatedNotes: () => this.relatedNotes,
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

  override async onload(): Promise<void> {
    this.runtimeLoaded = true;
    if (typeof this.loadData === "function") {
      try {
        this.settingsStore.load(await this.loadData());
      } catch {
        this.settingsStore.load(undefined);
      }
    }
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

    const ui = await loadPluginUi();
    this.composeRuntime(app, this.settingsStore.get());
    this.indexStatus = new IndexStatusController(
      this,
      {
        update: () => this.updateIndex(),
        rebuild: () => this.rebuildIndex(),
        reset: () => this.resetIndexes(),
        clearShared: () => this.clearIndexesAndSharedCache(),
        share: () => this.publishIndex(),
        importShared: () => this.checkPublication(),
        stop: () => this.maintenance?.stop(),
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
      hasLocalSemanticProfile: () => this.index?.hasCompatibleSemanticVectors() ?? false,
      stopMaintenance: () => this.maintenance?.stop(),
    });
    this.registerVaultEvents(app.vault);
    // A marker adds a driver command, never an alternate startup/runtime path.
    const benchmarkManifest = await readBenchmarkManifest(
      app.vault.adapter,
      app.vault.getName?.() ?? ""
    );
    if (benchmarkManifest && app.vault.adapter.getBasePath?.() === benchmarkManifest.expectedPath) {
      this.addCommand({
        id: "run-obsidian-benchmark",
        name: "Run generated-vault benchmark",
        callback: () => {
          if (this.benchmarkRunning || this.benchmarkResetting) return;
          this.benchmarkRunning = true;
          void this.runGeneratedVaultBenchmark(app, benchmarkManifest)
            .then((report) => new Notice(`Trama benchmark ${report.status}: ${report.runId}`))
            .catch(async (error) => {
              await writeBenchmarkFailureReport(app, benchmarkManifest, error).catch(
                () => undefined
              );
              new Notice(
                `Trama benchmark refused: ${error instanceof Error ? error.message : String(error)}`
              );
            })
            .finally(() => {
              this.benchmarkRunning = false;
            });
        },
      });
    }
  }

  async resetIndexes(): Promise<void> {
    if (this.benchmarkRunning || this.benchmarkResetting) {
      new Notice("A benchmark or index reset is already running.");
      return;
    }
    const accepted = globalThis.confirm?.(
      "Reset local search data for this vault? Notes and settings will be preserved, and shared embeddings will remain available. Scheduled maintenance will rebuild local search data if enabled."
    );
    if (!accepted) return;
    this.benchmarkResetting = true;
    try {
      await this.resetAllIndexes();
    } finally {
      this.benchmarkResetting = false;
    }
  }

  async clearIndexesAndSharedCache(): Promise<void> {
    if (this.benchmarkRunning || this.benchmarkResetting) {
      new Notice("A benchmark or index reset is already running.");
      return;
    }
    const accepted = globalThis.confirm?.(
      "Clear local search data and shared embeddings for this vault? Notes and settings will be preserved."
    );
    if (!accepted) return;
    this.benchmarkResetting = true;
    try {
      await this.resetAllIndexes(true);
    } finally {
      this.benchmarkResetting = false;
    }
  }

  private async resetAllIndexes(clearGeneratedContributions = false): Promise<void> {
    await this.indexLoad;
    const manager = this.index;
    const scheduler = this.maintenance;
    const publication = this.publicationManager;
    if (!manager || !scheduler || !publication) throw new Error("Index is not initialized.");
    await scheduler.resetExclusive(async () => {
      await manager.resetLocalDatabase();
      if (clearGeneratedContributions) await publication.store.clearCacheShards();
      manager.requestFullRecovery();
    });
    if (
      !clearGeneratedContributions &&
      !scheduler.snapshot.suspended &&
      this.index === manager &&
      this.maintenance === scheduler
    ) {
      const result = await scheduler.checkPublication(true);
      this.applyAdoptionResult(manager, result);
    }
  }

  private async runGeneratedVaultBenchmark(
    app: any,
    manifest: import("@/benchmark/Manifest").BenchmarkManifest
  ) {
    await this.indexLoad;
    if (!this.index || !this.publicationManager || !this.relatedNotes)
      throw new Error("Trama runtime is not initialized.");
    const capturePerformance = this.diagnostics.capturePerformance;
    if (!capturePerformance) throw new Error("Performance capture is unavailable.");
    const records: import("@/diagnostics/TramaDiagnostics").TramaPerformanceRecord[] = [];
    let recordBytes = 0;
    let complete = true;
    let report!: import("@/benchmark/Manifest").BenchmarkReport;
    await capturePerformance(
      async () => undefined,
      async () => {
        report = await runObsidianBenchmark(app, manifest, {
          index: this.index!,
          publication: this.publicationManager!,
          related: this.relatedNotes!,
          getLenteSearch: () => this.modelRuntime.lenteSearch!,
          clearIndexesAndSharedCache: async () => {
            const current = await readBenchmarkManifest(app.vault.adapter, manifest.vaultName);
            if (
              !current ||
              app.vault.adapter.getBasePath?.() !== manifest.expectedPath ||
              current.corpusSha256 !== manifest.corpusSha256
            )
              throw new Error("Generated benchmark marker or path changed; refusing index clear.");
            await this.resetAllIndexes(true);
          },
          rebuild: () => this.rebuildIndex(),
          publish: () => this.publishIndex(),
          checkPublication: () => this.checkPublication(),
          hasPublicationCheckWarning: () => this.publicationWarnings.check !== undefined,
        });
      },
      (record) => {
        if (!complete) return;
        const bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength + 1;
        if (records.length >= 10_000 || recordBytes + bytes > 8 * 1024 * 1024) {
          complete = false;
          return;
        }
        records.push(record);
        recordBytes += bytes;
      }
    );
    report = {
      ...report,
      ...(complete
        ? {}
        : { status: "error" as const, error: "Performance capture exceeded its bound." }),
      performanceCapture: { complete, records },
    };
    await writeBenchmarkReport(app, manifest, report);
    return report;
  }

  override onunload(): void {
    const maintenance = this.maintenance;
    const index = this.index;
    this.compositionRevision++;
    this.publicationEventCheck = undefined;
    this.compositionReplacement = false;
    this.compositionDirty = false;
    this.vaultEvents.dispose();
    this.maintenance = undefined;
    this.indexLoad = undefined;
    this.indexLoadResult = undefined;
    this.index = undefined;
    this.publicationManager = undefined;
    this.indexStatus = undefined;
    delete this.publicationWarnings.publication;
    delete this.publicationWarnings.check;
    this.projectedPublicationWarning = undefined;
    this.relatedNotes?.cancel();
    this.relatedNotes = undefined;
    this.modelRuntime.session?.cancel();
    this.modelRuntime.session = undefined;
    this.modelRuntime.lenteSearch = undefined;
    this.embeddingModel = undefined;
    this.runtimeLoaded = false;
    const disposal = maintenance?.dispose();
    index?.disposeImmediately();
    void disposal?.catch(() => undefined);
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
    if (before.diagnosticsMode !== saved.diagnosticsMode) await this.index?.configureDiagnostics();

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
    const lenteChanged = before.lente.searchMethod !== saved.lente.searchMethod;
    const exclusionsChanged =
      before.filo.excludedPaths.length !== saved.filo.excludedPaths.length ||
      before.filo.excludedPaths.some((path, index) => path !== saved.filo.excludedPaths[index]);
    const definitionChanged =
      embeddingChanged ||
      exclusionsChanged ||
      before.publicationDirectory !== saved.publicationDirectory;
    const app = (this as unknown as { app?: any }).app;

    if (!definitionChanged && before.automaticMaintenance !== saved.automaticMaintenance)
      this.maintenance?.setAutomaticEnabled(saved.automaticMaintenance);

    if (definitionChanged) {
      const oldMaintenance = this.maintenance;
      const oldIndex = this.index;
      const oldLoad = this.indexLoad;
      this.compositionReplacement = true;
      this.compositionDirty ||= Boolean(
        oldMaintenance?.snapshot.pending || oldIndex?.hasPendingWork()
      );

      // Detach callbacks before awaiting any old asynchronous work.
      this.compositionRevision++;
      this.publicationEventCheck = undefined;
      this.maintenance = undefined;
      this.index = undefined;
      this.indexLoad = undefined;
      this.indexLoadResult = undefined;
      this.publicationManager = undefined;
      this.clearPublicationWarnings();
      this.relatedNotes?.cancel();
      this.relatedNotes = undefined;
      this.modelRuntime.session?.cancel();

      const maintenanceDisposal = oldMaintenance?.dispose() ?? Promise.resolve();
      await oldLoad?.catch(() => false);
      await maintenanceDisposal;
      oldIndex?.invalidate();
      await oldIndex?.dispose();
      this.indexStatus?.markStale(false);

      if (app?.vault && app.workspace && app.metadataCache) {
        try {
          this.composeRuntime(app, saved);
          this.compositionReplacement = false;
        } catch (error) {
          this.compositionDirty = true;
          throw error;
        }
      }
    } else {
      if (chatChanged) this.modelRuntime.replaceChatModel(saved);
      if (lenteChanged && this.index) this.modelRuntime.replaceLenteSearch(app);
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
    this.indexLoadResult = undefined;
    const compositionRevision = ++this.compositionRevision;
    const runtime = composePluginRuntime(
      {
        diagnostics: this.diagnostics,
        modelRuntime: this.modelRuntime,
        isVisibleMarkdown: (path) => this.isVisibleMarkdown(path),
        createWorker: (currentApp) => this.createSqliteWorker(currentApp),
        resolveIdentity: (adapter) => this.resolveSqliteIdentity(adapter),
        createClient: (storage) => this.sqliteRuntime.createClient(storage),
        isCurrent: (manager) => this.index === manager,
        getIndexStatus: () => this.indexStatus,
        isAutomaticMaintenanceEnabled: () => this.getSettings().automaticMaintenance,
        onComposed: ({ manager, publication, scheduler, relatedNotes, embedding }) => {
          this.index = manager;
          this.publicationManager = publication;
          this.maintenance = scheduler;
          this.relatedNotes = relatedNotes;
          this.embeddingModel = embedding;
          if (this.compositionReplacement && this.compositionDirty) {
            manager.requestFullRecovery();
            scheduler.invalidate();
            this.compositionDirty = false;
          }
        },
        onIndexOperation: (manager, changed) => this.afterIndexOperation(manager, changed),
        onMaintenanceSnapshot: (manager, snapshot) =>
          this.applyMaintenanceSnapshot(manager, snapshot),
        onPublicationWarning: (manager, warning, origin) => {
          if (this.index === manager) this.handlePublicationWarning(warning, origin);
        },
        onPublicationMetrics: (manager) => this.updateIndexCapabilities(manager),
        onPublicationSuccess: (manager) => {
          if (this.index === manager) this.clearPublicationWarning("publication");
        },
        onAdoptionResult: (manager, result) => this.applyAdoptionResult(manager, result),
        onInitialState: (manager, loaded) => {
          if (this.index !== manager || compositionRevision !== this.compositionRevision || !loaded)
            return;
          this.updateIndexCapabilities(manager);
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
    revision: number
  ): void {
    if (this.index !== manager || revision !== this.compositionRevision) return;
    this.indexLoadResult = loaded;
    this.updateIndexCapabilities(manager);
    const maintenance = this.maintenance?.snapshot;
    if (
      maintenance &&
      (maintenance.pending ||
        maintenance.lane !== "idle" ||
        maintenance.suspended ||
        maintenance.error !== undefined)
    ) {
      this.indexStatus?.setMaintenance(maintenance, manager.capabilities());
      return;
    }
    if (!loaded || !manager.isComplete()) {
      if (manager.hasUsableIndex()) this.indexStatus?.markStale(true);
      else this.indexStatus?.setIndexRequired(true);
      return;
    }
    if (this.visibleMarkdownCatalog().length === 0) this.indexStatus?.setEmpty(true, true);
    else this.indexStatus?.setReady(true);
    this.modelRuntime.refreshOpenRelatedSuggestions(app);
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

  async updateIndex(): Promise<void> {
    if (!this.maintenance) throw new Error("Index is not initialized.");
    await this.maintenance.update();
  }
  async rebuildIndex(): Promise<void> {
    if (!this.maintenance) throw new Error("Index is not initialized.");
    await this.maintenance.rebuild();
  }
  async publishIndex(): Promise<void> {
    if (!this.maintenance) throw new Error("Index is not initialized.");
    await this.maintenance.publishCurrent();
  }
  async stopIndex(): Promise<void> {
    this.maintenance?.stop();
  }

  getIndexStatus(): ReturnType<IndexStatusController["getStatus"]> | undefined {
    return this.indexStatus?.getStatus();
  }
  getPublicationMetrics(): { byteSize: number; durationMs: number } | undefined {
    const metrics = this.publicationManager?.metrics;
    return metrics ? { byteSize: metrics.byteSize, durationMs: metrics.durationMs } : undefined;
  }

  async checkPublication(manual = true): Promise<void> {
    const scheduler = this.maintenance;
    const manager = this.index;
    const result = await scheduler?.checkPublication(manual);
    if (!scheduler || scheduler !== this.maintenance || manager !== this.index || !result) return;
    this.applyAdoptionResult(manager!, result);
  }

  private applyAdoptionResult(manager: IndexManager, result: AdoptionResult): void {
    if (this.index !== manager) return;
    if (result.warning) {
      this.handlePublicationWarning(result.warning, "check");
      return;
    }
    this.clearPublicationWarning("check");
    if (!result.adopted) return;
    this.updateIndexCapabilities(manager);
    if (this.getSettings().automaticMaintenance && !this.maintenance?.snapshot.suspended)
      this.maintenance?.invalidate();
    const snapshot = this.maintenance?.snapshot;
    if (snapshot?.pending || snapshot?.lane !== "idle") return;
    if (!manager.isComplete()) this.indexStatus?.markStale(manager.hasUsableIndex());
    else if (this.visibleMarkdownCatalog().length === 0) this.indexStatus?.setEmpty(true, true);
    else this.indexStatus?.setReady(true);
    const app = (this as unknown as { app?: any }).app;
    this.modelRuntime.refreshOpenRelatedSuggestions(app);
    this.modelRuntime.refreshOpenLente(app);
  }

  private updateIndexCapabilities(manager: IndexManager): void {
    if (this.index === manager) this.indexStatus?.setCapabilities(manager.capabilities());
  }

  private afterIndexOperation(manager: IndexManager, changed: boolean): void {
    if (this.index !== manager) return;
    this.updateIndexCapabilities(manager);
    const app = (this as unknown as { app?: any }).app;
    this.modelRuntime.refreshOpenRelatedSuggestions(app);
    if (changed) this.modelRuntime.refreshOpenLente(app);
  }

  private applyMaintenanceSnapshot(manager: IndexManager, snapshot: MaintenanceSnapshot): void {
    if (this.index !== manager) return;
    if (snapshot.lane === "update" || snapshot.lane === "rebuild") this.relatedNotes?.cancel();
    this.indexStatus?.setMaintenance(snapshot, manager.capabilities());
  }

  private clearPublicationWarning(origin: "publication" | "check"): void {
    delete this.publicationWarnings[origin];
    this.projectPublicationWarning();
  }

  private handlePublicationWarning(
    warning: PublicationWarning,
    origin: "publication" | "check"
  ): void {
    if (warning.code === "upgrade_required" && !this.upgradeNoticeShown) {
      this.upgradeNoticeShown = true;
      new Notice(warning.message);
    }
    const message =
      origin === "check"
        ? `Shared embeddings check failed: ${warning.message}`
        : `Search data saved locally, but sharing embeddings failed: ${warning.message}`;
    this.publicationWarnings[origin] = message;
    this.projectPublicationWarning();
  }

  private clearPublicationWarnings(): void {
    delete this.publicationWarnings.publication;
    delete this.publicationWarnings.check;
    this.projectPublicationWarning();
  }

  private projectPublicationWarning(): void {
    const warning = this.publicationWarnings.check ?? this.publicationWarnings.publication;
    if (warning === this.projectedPublicationWarning) return;
    this.projectedPublicationWarning = warning;
    this.indexStatus?.setPublicationWarning(warning);
  }

  private notifyPublicationFileEvent(path: string): void {
    const store = this.publicationManager?.store;
    if (
      path.startsWith(`${store?.cacheDirectory}/cache-`) &&
      /^cache-[0-9a-f]{64}\.sqlite3$/.test(path.slice(path.lastIndexOf("/") + 1))
    )
      this.queuePublicationEventCheck();
  }

  private queuePublicationEventCheck(): void {
    const scheduler = this.maintenance;
    const manager = this.index;
    if (!scheduler || !manager || this.compositionReplacement) return;
    const current = this.publicationEventCheck;
    if (
      current &&
      current.revision === this.compositionRevision &&
      current.scheduler === scheduler &&
      current.manager === manager
    ) {
      if (current.started) current.dirty = true;
      return;
    }
    const check = {
      revision: this.compositionRevision,
      scheduler,
      manager,
      started: false,
      dirty: false,
    };
    this.publicationEventCheck = check;
    queueMicrotask(() => void this.runPublicationEventChecks(check));
  }

  private async runPublicationEventChecks(
    check: NonNullable<TramaPlugin["publicationEventCheck"]>
  ): Promise<void> {
    const isCurrent = () =>
      this.publicationEventCheck === check &&
      this.compositionRevision === check.revision &&
      this.maintenance === check.scheduler &&
      this.index === check.manager &&
      !this.compositionReplacement;
    try {
      if (!isCurrent()) return;
      check.started = true;
      do {
        check.dirty = false;
        try {
          await this.checkPublication(false);
        } catch {
          // A later event still gets one check, even when this check fails.
        }
      } while (check.dirty && isCurrent());
    } finally {
      if (this.publicationEventCheck === check) this.publicationEventCheck = undefined;
    }
  }

  private registerVaultEvents(vault: any): void {
    this.vaultEvents.register(vault);
  }

  private queueVaultMutation(mutation: IndexPathMutation): void {
    if (this.compositionReplacement) {
      this.compositionDirty = true;
      return;
    }
    const manager = this.index;
    const scheduler = this.maintenance;
    if (!manager || !scheduler) return;
    manager.recordPathMutation(mutation);
    scheduler.invalidate();
    if (!this.getSettings().automaticMaintenance) {
      this.updateIndexCapabilities(manager);
      if (scheduler.snapshot.lane === "idle") this.indexStatus?.markStale(manager.hasUsableIndex());
    }
  }

  private requestFullRecovery(path?: string): void {
    if (path && this.isPublicationPath(path)) return;
    if (this.compositionReplacement) {
      this.compositionDirty = true;
      return;
    }
    const manager = this.index;
    const scheduler = this.maintenance;
    if (!manager || !scheduler) return;
    manager.requestFullRecovery();
    scheduler.invalidate();
  }

  private isPublicationPath(path: string): boolean {
    return this.vaultEvents.isPublicationPath(path);
  }
  private isVisibleMarkdown(path: string): boolean {
    return this.vaultEvents.isVisibleMarkdown(path);
  }
  private resolveSqliteIdentity(
    adapter: import("@/index/IndexManager").SnapshotDataAdapter
  ): Promise<string> {
    return this.sqliteRuntime.resolveIdentity(adapter);
  }
  private createSqliteWorker(app: any): SqliteWorkerLike {
    return this.sqliteRuntime.createWorker(app);
  }
}
