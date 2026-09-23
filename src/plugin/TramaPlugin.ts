import { Platform, Plugin, TAbstractFile } from "obsidian";
import { ChatSession } from "@/chat/ChatSession";
import {
  formatDiagnosticLogLine,
  projectDiagnosticError,
  TramaDiagnostics,
} from "@/diagnostics/TramaDiagnostics";
import {
  IndexManager,
  IndexVaultPort,
  type IndexPathMutation,
  type IndexOperationResult,
  type IndexSyncResult,
  type SnapshotDataAdapter,
} from "@/index/IndexManager";
import { bytesToHex, compareCodeUnits } from "@/index/Identity";
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
import { IndexOperationLease, IndexStatusController } from "@/ui/index/IndexStatus";
import { RelatedNotes } from "@/index/RelatedNotes";
import { TRAMA_ICONS } from "@/ui/icons";
import { LenteBatch, LenteSearch, LenteSearchOptions } from "@/index/LenteSearch";
import { ObsidianLenteNoteStats } from "@/vault/readOnly/ObsidianLenteNoteStats";
import { LenteSearchModal } from "@/ui/lente/LenteSearchModal";
import type { SqliteWorkerClient, SqliteWorkerLike } from "@/index/sqlite/client";
import { SQLITE_PROTOCOL_VERSION } from "@/index/sqlite/protocol";
import {
  PublicationManager,
  type PublicationWarning,
} from "@/index/publications/PublicationManager";
import { PublicationStore } from "@/index/publications/PublicationStore";

interface LenteSearchPort {
  search(query: string, options?: LenteSearchOptions): Promise<LenteBatch>;
}

function coalescePathMutation(changes: IndexPathMutation[], mutation: IndexPathMutation): void {
  const previous = changes[changes.length - 1];
  if (mutation.type === "rename") {
    if (previous?.type === "rename" && previous.to === mutation.from) {
      changes[changes.length - 1] = { type: "rename", from: previous.from, to: mutation.to };
      return;
    }
    if (previous?.type === "upsert" && previous.path === mutation.from) {
      changes[changes.length - 1] = { type: "delete", path: mutation.from };
      changes.push({ type: "upsert", path: mutation.to });
      return;
    }
    if (previous?.type === "delete" && previous.path === mutation.from) {
      changes.push({ type: "upsert", path: mutation.to });
      return;
    }
    changes.push(mutation);
    return;
  }
  const path = mutation.path;
  if (mutation.type === "upsert") {
    if (previous?.type === "upsert" && previous.path === path) return;
    if (previous?.type === "delete" && previous.path === path) {
      changes[changes.length - 1] = mutation;
      return;
    }
    changes.push(mutation);
    return;
  }
  if (previous?.type === "delete" && previous.path === path) return;
  if (previous?.type === "rename" && previous.to === path) {
    changes[changes.length - 1] = { type: "delete", path: previous.from };
    return;
  }
  if (previous?.type === "upsert" && previous.path === path) {
    changes[changes.length - 1] = mutation;
    return;
  }
  changes.push(mutation);
}

function isRetryableError(error: unknown): boolean {
  if (projectDiagnosticError(error).retryable === true) return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { retryable?: unknown; error?: { retryable?: unknown } };
  return value.retryable === true || value.error?.retryable === true;
}

interface AutomaticPublicationIntent {
  readonly revision: number;
  readonly changeCounter: number;
  readonly eventRevision: number;
}

type SchedulerChannel = "lexical" | "semantic" | "publication";
type SchedulerSource = "startup" | "event" | "explicit" | "retry" | "quit";

interface SchedulerTransition {
  readonly channel: SchedulerChannel;
  readonly stage: string;
  readonly source: SchedulerSource;
  readonly delayMs?: number;
  readonly retryAttempt?: number;
  readonly durationMs?: number;
  readonly counts?: Readonly<Record<string, number>>;
  readonly publicationSizeBytes?: number;
  readonly error?: ReturnType<typeof projectDiagnosticError>;
}

/** Composes the shared assistant and owns its lifecycle and vault event boundary. */
export class TramaPlugin extends Plugin {
  private runtimeLoaded = false;
  private readonly workerCacheNonce =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
  private automaticLexicalLease?: IndexOperationLease;
  private automaticReschedulePending = false;
  private indexLoad?: Promise<boolean>;
  private indexLoaded = false;
  private indexReady = false;
  private combinedRebuildLexicalPhase = false;
  private compositionRevision = 0;
  private readonly pendingVaultChanges: IndexPathMutation[] = [];
  private vaultEventRevision = 0;
  /** Compatibility mirror used only by older injected manager doubles. */
  private fullRecoveryPending = false;
  private startupRecoveryStarted = false;
  private automaticSemanticTimer?: ReturnType<typeof setTimeout>;
  private automaticSemanticRetryTimer?: ReturnType<typeof setTimeout>;
  private automaticSemanticAbort?: AbortController;
  private automaticSemanticLease?: IndexOperationLease;
  private automaticSemanticPromise?: Promise<void>;
  private automaticSemanticRetryAttempt = 0;
  private automaticSemanticRetryPaused = false;
  private automaticSemanticEligible = false;
  private layoutReady = false;
  private eventTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private automaticRetryAttempt = 0;
  private automaticRetryPaused = false;
  private automaticStopPaused = false;
  private automaticSemanticStopPaused = false;
  private reconcilePromise?: Promise<void>;
  private queuedWork = false;
  private readonly eventRefs: Array<{ unsubscribe?: () => void }> = [];
  private saveQueue: Promise<void> = Promise.resolve();
  private sqliteIdentity?: string;
  private sqliteIdentityAdapter?: SnapshotDataAdapter;
  private publicationManager?: PublicationManager;
  private automaticPublicationTimer?: ReturnType<typeof setTimeout>;
  private automaticPublicationRetryTimer?: ReturnType<typeof setTimeout>;
  private automaticPublicationRetryAttempt = 0;
  private automaticPublicationRetryPaused = false;
  private automaticPublicationRevision = 0;
  private latestPublicationChangeCounter = 0;
  private pendingAutomaticPublication?: AutomaticPublicationIntent;
  private automaticPublicationPromise?: Promise<void>;
  private activePublicationPromise?: ReturnType<PublicationManager["publish"]>;
  private quitPublicationPromise?: Promise<void>;
  private currentSchedulerSource: SchedulerSource = "explicit";
  private semanticAbort?: AbortController;
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
    const layoutReady = () => {
      this.layoutReady = true;
      this.maybeScheduleStartupRecovery();
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
    this.addCommand({
      id: "search-with-lente",
      name: "Search with Lente",
      icon: TRAMA_ICONS.lente,
      callback: () => {
        const searchSource: LenteSearchPort = {
          search: (query, options = {}) =>
            this.lenteSearch?.search(query, options) ??
            Promise.reject({ code: "unavailable", message: "Lente is unavailable." }),
        };
        new LenteSearchModal(
          app,
          searchSource,
          this.getSettings().lente.automaticSearchDelayMs
        ).open();
      },
    });
    this.registerVaultEvents(app.vault);
  }

  override onunload(): void {
    this.indexReady = false;
    this.stopAutomaticSemanticWork();
    this.stopAutomaticPublication();
    this.semanticAbort?.abort();
    this.semanticAbort = undefined;
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
    this.session?.cancel();
    for (const ref of this.eventRefs) ref.unsubscribe?.();
    this.eventRefs.length = 0;
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
        counts: { queued: this.index?.pendingChangeCount?.() ?? this.pendingVaultChanges.length },
      });
    } else if (before.filo.automaticLexicalDelayMs !== saved.filo.automaticLexicalDelayMs)
      this.armAutomaticWork();

    if (indexDefinitionChanged || publicationDirectoryChanged) {
      this.stopAutomaticWork(false);
      this.stopAutomaticPublication();
      this.publicationManager?.dispose();
      this.session?.cancel();
      this.semanticAbort?.abort();
      this.semanticAbort = undefined;
      this.stopAutomaticSemanticWork();
      this.automaticSemanticEligible = false;
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
    if (app?.vault && app.workspace && app.metadataCache && this.session) {
      if (chatChanged && !indexDefinitionChanged && !publicationDirectoryChanged)
        this.replaceChatModel(saved);
      else if (indexDefinitionChanged || publicationDirectoryChanged)
        this.composeRuntime(app, saved);
    }

    if (lenteChanged && !indexDefinitionChanged && this.index) this.replaceLenteSearch(app);
    if (automaticSemanticDelayChanged) {
      if (saved.filo.automaticSemanticDelayMs <= 0) {
        this.stopAutomaticSemanticWork();
        this.emitSchedulerTransition({
          channel: "semantic",
          stage: "disabled",
          source: "explicit",
        });
      } else {
        this.automaticSemanticRetryAttempt = 0;
        this.automaticSemanticRetryPaused = false;
        if (this.hasAutomaticSemanticWork(this.index)) this.automaticSemanticEligible = true;
        this.scheduleAutomaticSemantic("event");
      }
    }
    if (automaticPublicationDelayChanged) {
      this.clearAutomaticPublicationRetry();
      this.automaticPublicationRetryAttempt = 0;
      this.automaticPublicationRetryPaused = false;
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
    const transport = new LmStudioTransport({
      policy: new EndpointPolicy({ approvals: settings.approvedOrigins }),
    });
    const readonlyVault = new ObsidianReadonlyVault(app.vault, app.workspace, app.metadataCache);
    const excludedPaths = [...settings.filo.excludedPaths];
    const isIndexEligible = (path: string) =>
      this.isVisibleMarkdown(path) &&
      !isExcludedPath(path, [...excludedPaths, settings.publicationDirectory]);
    const indexVault: IndexVaultPort = new ObsidianIndexVault(app.vault, {
      isBaseVisible: (path) => this.isVisibleMarkdown(path),
      isIndexEligible,
    });
    const embedding = new LmStudioEmbeddingModel({ ...settings.embedding, transport });
    this.embeddingModel = embedding;
    // The callback is installed before the manager can be constructed.
    // eslint-disable-next-line prefer-const
    let composedPublication: PublicationManager | undefined;
    const manager = new IndexManager(
      indexVault,
      embedding,
      settings.embedding.endpoint,
      settings.embedding.modelId,
      {
        excludedPaths,
        publicationDirectory: settings.publicationDirectory,
        isIndexEligible,
        workerFactory: () => this.createSqliteWorker(app),
        sqliteIdentity: this.resolveSqliteIdentity(app.vault.adapter),
        sqliteClient: this.sqliteClientFactory?.(app.vault),
        onSuccessfulOperation: (result) => {
          if (this.combinedRebuildLexicalPhase && result.operation === "rebuild") return;
          this.recordAutomaticPublicationIntent(manager, composedPublication, result);
        },
        onProgress: (progress) => this.indexStatus?.reportProgress(progress),
      },
      this.diagnostics
    );
    this.index = manager;
    composedPublication = new PublicationManager(
      manager,
      new PublicationStore(app.vault.adapter, { directory: settings.publicationDirectory }),
      {
        onWarning: (warning) => {
          if (this.index === manager) this.handlePublicationWarning(warning);
        },
        onMetrics: () => this.updateIndexCapabilities(manager),
        onEventAdopted: (result) => {
          if (!result.adopted || this.publicationManager !== composedPublication) return;
          this.applyPublicationAdoption(manager);
        },
      }
    );
    this.publicationManager = composedPublication;
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
    this.startupRecoveryStarted = false;
    const publication = composedPublication;
    const loadPromise = manager
      .load({ emitDiagnostics: false })
      .then(async (loaded) => {
        const available = manager.capabilities().availability !== "unavailable";
        const usable = loaded && available;
        if (usable && this.index === manager && compositionRevision === this.compositionRevision) {
          this.indexLoaded = true;
          this.indexReady = true;
          this.updateIndexCapabilities(manager);
          if (manager.isComplete()) {
            if (this.visibleMarkdownCatalog().length === 0) this.indexStatus?.setEmpty(true, true);
            else this.indexStatus?.setReady(true);
          } else if (manager.hasUsableIndex()) this.indexStatus?.markStale(true);
          else this.indexStatus?.setIndexRequired(true);
        }
        if (usable && this.index === manager) {
          const adoption = await publication!.adoptCurrent();
          if (adoption.warning) this.handlePublicationWarning(adoption.warning);
          else if (adoption.adopted) this.clearPublicationIntentAfterAdoption();
        }
        return loaded;
      })
      .catch(() => false);
    this.indexLoad = loadPromise;
    this.fullRecoveryPending = false;
    void loadPromise.then((loaded) => {
      if (this.index !== manager || compositionRevision !== this.compositionRevision) return;
      const available = manager.capabilities().availability !== "unavailable";
      const usable = loaded && available;
      this.indexLoaded = usable;
      this.indexReady = usable;
      this.updateIndexCapabilities(manager);
      if (this.hasAutomaticSemanticWork(manager)) this.automaticSemanticEligible = true;
      if (!usable || !manager.isComplete()) {
        // The initial persisted-index decision is startup bookkeeping and must
        // stay silent even if debugging is enabled immediately after onload.
        if (manager.hasUsableIndex()) this.indexStatus?.markStale(true);
        else this.indexStatus?.setIndexRequired(true);
        if (usable) this.maybeScheduleStartupRecovery();
        return;
      }
      if (this.visibleMarkdownCatalog().length === 0) this.indexStatus?.setEmpty(true, true);
      else this.indexStatus?.setReady(true);
      this.refreshOpenRelatedSuggestions(app);
      this.maybeScheduleStartupRecovery();
      this.automaticSemanticEligible = this.hasAutomaticSemanticWork(manager);
      if (!(manager.hasPendingWork?.() ?? (this.fullRecoveryPending || this.queuedWork)))
        this.scheduleAutomaticSemantic("startup");
      if (this.queuedWork && this.getSettings().filo.automaticLexicalDelayMs > 0) {
        this.scheduleReconcile(
          manager.hasPendingWork?.() || this.fullRecoveryPending ? "startup" : "event"
        );
      } else if (this.queuedWork) {
        this.queuedWork = true;
        this.markQueuedWorkStale();
      }
    });
  }

  private async resolveSqliteIdentity(adapter: SnapshotDataAdapter): Promise<string> {
    const path = ".trama/sqlite/v1/identity.json";
    if (this.sqliteIdentity && this.sqliteIdentityAdapter === adapter) return this.sqliteIdentity;
    if (typeof adapter.read !== "function" || typeof adapter.write !== "function")
      throw new Error("SQLite identity storage is unavailable.");
    let identity: string | undefined;
    try {
      const raw = await adapter.read.call(adapter, path);
      const parsed = JSON.parse(raw) as { readonly version?: unknown; readonly identity?: unknown };
      if (
        parsed.version === 1 &&
        typeof parsed.identity === "string" &&
        /^[0-9a-f]{64}$/i.test(parsed.identity)
      )
        identity = parsed.identity.toLowerCase();
    } catch {
      // A missing or malformed identity is replaced with a new opaque token.
    }
    if (!identity) {
      const bytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(bytes);
      identity = bytesToHex(bytes);
      if (typeof adapter.mkdir !== "function")
        throw new Error("SQLite identity storage is unavailable.");
      await adapter.mkdir.call(adapter, ".trama");
      await adapter.mkdir.call(adapter, ".trama/sqlite");
      await adapter.mkdir.call(adapter, ".trama/sqlite/v1");
      await adapter.write.call(adapter, path, JSON.stringify({ version: 1, identity }));
    }
    this.sqliteIdentity = identity;
    this.sqliteIdentityAdapter = adapter;
    return identity;
  }

  private sqliteAssetUrl(app: any, fileName: string): string {
    const adapter = app?.vault?.adapter;
    if (!adapter || typeof adapter.getResourcePath !== "function")
      throw new Error("SQLite Worker resource path is unavailable.");
    const configDir =
      typeof app?.vault?.configDir === "string" && app.vault.configDir
        ? app.vault.configDir
        : ".obsidian";
    const pluginId = this.manifest?.id || "trama";
    const pluginDir = this.manifest?.dir || `${configDir}/plugins/${pluginId}`;
    return adapter.getResourcePath.call(adapter, `${pluginDir}/${fileName}`);
  }

  private sqliteWorkerUrl(app: any): string {
    const url = this.sqliteAssetUrl(app, "sqlite-worker.mjs");
    const version = this.manifest?.version || SQLITE_PROTOCOL_VERSION;
    return `${url}?v=${encodeURIComponent(String(version))}&nonce=${encodeURIComponent(this.workerCacheNonce)}`;
  }

  private createSqliteWorker(app: any): SqliteWorkerLike {
    if (typeof Worker !== "function") throw new Error("SQLite Worker APIs are unavailable.");
    const workerUrl = this.sqliteWorkerUrl(app);
    if (!Platform.isDesktopApp)
      return new Worker(workerUrl, { type: "module" }) as unknown as SqliteWorkerLike;
    if (
      typeof Blob !== "function" ||
      typeof URL?.createObjectURL !== "function" ||
      typeof URL?.revokeObjectURL !== "function"
    )
      throw new Error("SQLite Worker APIs are unavailable.");
    const assets = {
      moduleUrl: this.sqliteAssetUrl(app, "sqlite3.mjs"),
      wasmUrl: this.sqliteAssetUrl(app, "sqlite3.wasm"),
    };
    const bootstrap = `globalThis.__TRAMA_SQLITE_ASSETS__=${JSON.stringify(assets)};const __tramaWorkerUrl=${JSON.stringify(workerUrl)};let __tramaStartupError;try{await import(__tramaWorkerUrl)}catch{__tramaStartupError={code:"storage_unavailable",message:"SQLite Worker could not be started. Ensure the bundled SQLite assets are installed.",retryable:true}}URL.revokeObjectURL(globalThis.location.href);if(__tramaStartupError)self.onmessage=({data})=>self.postMessage({v:${SQLITE_PROTOCOL_VERSION},id:Number.isSafeInteger(data?.id)?data.id:0,ok:false,error:__tramaStartupError});`;
    const bootstrapUrl = URL.createObjectURL(new Blob([bootstrap], { type: "text/javascript" }));
    try {
      return new Worker(bootstrapUrl, { type: "module" }) as unknown as SqliteWorkerLike;
    } catch (error) {
      URL.revokeObjectURL(bootstrapUrl);
      throw error;
    }
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
    if (!app?.workspace) return;
    for (const leaf of app.workspace.getLeavesOfType?.("trama-voce") ?? []) {
      const view = (leaf as { view?: { refreshRelatedSuggestions?: () => void } }).view;
      view?.refreshRelatedSuggestions?.();
    }
  }

  private refreshOpenLente(app: any): void {
    if (!app?.workspace) return;
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

  /** Retries the last staged publication without rerunning local indexing. */
  async retryPublication(): Promise<void> {
    const publication = this.publicationManager;
    if (!publication) return;
    this.clearAutomaticPublicationTimer();
    this.clearAutomaticPublicationRetry();
    this.automaticPublicationRetryAttempt = 0;
    this.automaticPublicationRetryPaused = false;
    const pending = this.pendingAutomaticPublication;
    const startedAt = Date.now();
    this.emitSchedulerTransition({ channel: "publication", stage: "running", source: "explicit" });
    try {
      const result = await this.publishOnce(publication);
      if (result.warning) {
        this.handlePublicationWarning(result.warning);
        this.emitSchedulerTransition({
          channel: "publication",
          stage: "failed",
          source: "explicit",
          durationMs: Date.now() - startedAt,
        });
        this.scheduleAutomaticPublicationRetry(pending, result.warning.retryable);
      } else if (result.published) {
        this.indexStatus?.setPublicationWarning(undefined);
        if (
          pending &&
          this.pendingAutomaticPublication === pending &&
          this.isCurrentPublicationIntent(pending)
        )
          this.pendingAutomaticPublication = undefined;
        this.emitSchedulerTransition({
          channel: "publication",
          stage: "completed",
          source: "explicit",
          durationMs: Date.now() - startedAt,
          publicationSizeBytes: publication.metrics?.byteSize,
        });
      }
    } catch (error) {
      this.emitSchedulerTransition({
        channel: "publication",
        stage: "failed",
        source: "explicit",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      this.refreshSchedulerMessage();
    }
  }

  async prepareSemantic(): Promise<void> {
    if (!this.index) throw new Error("Index is not initialized.");
    if (this.indexStatus) return this.indexStatus.prepare();
    const controller = new AbortController();
    this.semanticAbort?.abort();
    this.semanticAbort = controller;
    try {
      await this.runSemanticPreparation(controller.signal);
    } finally {
      if (this.semanticAbort === controller) this.semanticAbort = undefined;
    }
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

  private async runForceUpdate(signal: AbortSignal): Promise<void> {
    const app = (this as unknown as { app?: any }).app;
    if (!app?.workspace) throw new Error("Workspace is not initialized.");

    this.pauseAutomaticPublicationForIndexing();
    this.stopAutomaticWork(false);
    this.pauseAutomaticSemanticForLexicalWork();
    const pendingSemantic = this.automaticSemanticPromise;
    const pendingLexical = this.reconcilePromise;
    await Promise.all([
      pendingSemantic?.catch(() => undefined),
      pendingLexical?.catch(() => undefined),
    ]);
    if (signal.aborted) throw new Error("Index update cancelled.");

    await this.saveOpenMarkdownBuffers(app.workspace);
    if (signal.aborted) throw new Error("Index update cancelled.");
    await this.indexLoad;
    const manager = this.index;
    if (!manager) throw new Error("Index is not initialized.");

    await this.runIndex(signal, false);
    if (!manager.isComplete() || this.queuedWork)
      throw new Error("Lexical index did not converge; semantic update was not started.");

    this.indexStatus?.beginSemanticPreparation();
    await this.runSemanticPreparation(signal);
  }

  private async saveOpenMarkdownBuffers(workspace: any): Promise<void> {
    const leaves = workspace.getLeavesOfType?.("markdown") ?? [];
    const savedPaths = new Set<string>();
    for (const leaf of leaves) {
      const view = leaf?.view;
      const path = view?.file?.path;
      if (
        typeof path !== "string" ||
        !/\.md$/i.test(path) ||
        typeof view.save !== "function" ||
        savedPaths.has(path)
      )
        continue;
      savedPaths.add(path);
      await view.save();
    }
  }

  private async runSemanticPreparation(signal: AbortSignal, rebuild = false): Promise<void> {
    if (!this.index) throw new Error("Index is not initialized.");
    const eventRevision = this.vaultEventRevision;
    this.pauseAutomaticPublicationForIndexing();
    this.stopAutomaticSemanticWork();
    this.automaticSemanticStopPaused = false;
    const startedAt = Date.now();
    const previousSource = this.currentSchedulerSource;
    this.currentSchedulerSource = "explicit";
    this.emitSchedulerTransition({ channel: "semantic", stage: "running", source: "explicit" });
    try {
      if (rebuild) await this.index.rebuildSemantic(signal);
      else await this.index.prepareSemantic(signal);
      this.indexReady = true;
      this.updateIndexCapabilities(this.index);
      this.emitSchedulerTransition({
        channel: "semantic",
        stage: "completed",
        source: "explicit",
        durationMs: Date.now() - startedAt,
      });
      if (this.queuedWork || eventRevision !== this.vaultEventRevision)
        this.indexStatus?.markStale(
          this.index.hasUsableIndex(),
          "Changes arrived during semantic indexing. The index is not current; update the lexical index, then update missing semantic vectors."
        );
    } catch (error) {
      this.emitSchedulerTransition({
        channel: "semantic",
        stage: signal.aborted ? "cancelled" : "failed",
        source: "explicit",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      if (this.queuedWork && this.getSettings().filo.automaticLexicalDelayMs > 0)
        this.scheduleReconcile();
      this.currentSchedulerSource = previousSource;
    }
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
    this.refreshOpenRelatedSuggestions(app);
    this.refreshOpenLente(app);
  }

  getRelatedNotes(): RelatedNotes | undefined {
    return this.relatedNotes;
  }

  private updateIndexCapabilities(manager: IndexManager): void {
    if (this.index !== manager || !this.indexStatus) return;
    this.indexStatus.setCapabilities(manager.capabilities());
  }

  private hasAutomaticSemanticWork(manager?: IndexManager): boolean {
    if (!manager) return false;
    const pending = (
      manager as IndexManager & {
        hasPendingSemanticWork?: () => boolean;
      }
    ).hasPendingSemanticWork;
    return typeof pending === "function"
      ? pending.call(manager)
      : manager.hasCompatibleSemanticVectors();
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
      ...(transition.error === undefined ? {} : { error: transition.error }),
    });
    this.refreshSchedulerMessage();
  }

  private refreshSchedulerMessage(): void {
    if (!this.indexStatus) return;
    const settings = this.getSettings().filo;
    const lexical =
      settings.automaticLexicalDelayMs <= 0
        ? this.queuedWork
          ? "paused"
          : "Off"
        : this.reconcilePromise
          ? "running"
          : this.automaticRetryPaused
            ? "failed"
            : this.retryTimer
              ? `retrying (attempt ${this.automaticRetryAttempt})`
              : this.eventTimer
                ? `scheduled (${settings.automaticLexicalDelayMs / 1000} sec)`
                : this.queuedWork
                  ? "queued"
                  : "idle";
    const semantic =
      settings.automaticSemanticDelayMs <= 0
        ? "Off"
        : this.automaticSemanticPromise
          ? "running"
          : this.automaticSemanticRetryTimer
            ? `retrying (attempt ${this.automaticSemanticRetryAttempt})`
            : this.automaticSemanticTimer
              ? `scheduled (${settings.automaticSemanticDelayMs / 1000} sec)`
              : this.index?.isComplete() && !this.automaticSemanticEligible
                ? this.index.capabilities().semantic.searchable
                  ? "up to date"
                  : "incomplete"
                : "idle";
    const publication =
      settings.automaticPublicationDelayMs <= 0
        ? "Off"
        : this.automaticPublicationPromise
          ? "running"
          : this.automaticPublicationRetryTimer
            ? `retrying (attempt ${this.automaticPublicationRetryAttempt})`
            : this.automaticPublicationRetryPaused
              ? "failed"
              : this.automaticPublicationTimer
                ? `scheduled (${settings.automaticPublicationDelayMs / 1000} sec)`
                : this.pendingAutomaticPublication
                  ? "pending"
                  : "idle";
    const message = `Automatic updates — lexical ${lexical}; semantic ${semantic}; publication ${publication}.`;
    if (this.indexStatus.getStatus?.().schedulerMessage !== message)
      this.indexStatus.setSchedulerMessage(message);
  }

  private recordAutomaticPublicationIntent(
    manager: IndexManager,
    publication: PublicationManager | undefined,
    result: IndexOperationResult
  ): void {
    if (
      !publication ||
      this.index !== manager ||
      !result.converged ||
      !result.changed ||
      result.state.incomplete
    )
      return;
    if (this.getSettings().filo.automaticPublicationDelayMs <= 0) {
      this.emitSchedulerTransition({
        channel: "publication",
        stage: "disabled",
        source: this.currentSchedulerSource,
      });
      return;
    }
    this.clearAutomaticPublicationTimer();
    this.clearAutomaticPublicationRetry();
    this.automaticPublicationRetryAttempt = 0;
    this.automaticPublicationRetryPaused = false;
    this.pendingAutomaticPublication = {
      revision: ++this.automaticPublicationRevision,
      changeCounter: result.state.changeCounter,
      eventRevision: this.vaultEventRevision,
    };
    this.latestPublicationChangeCounter = result.state.changeCounter;
    this.emitSchedulerTransition({
      channel: "publication",
      stage: "pending",
      source: this.currentSchedulerSource,
      delayMs: this.getSettings().filo.automaticPublicationDelayMs,
    });
    this.scheduleAutomaticPublication();
  }

  private scheduleAutomaticPublication(
    delay = this.getSettings().filo.automaticPublicationDelayMs,
    source: SchedulerSource = this.currentSchedulerSource
  ): void {
    this.clearAutomaticPublicationTimer();
    const pending = this.pendingAutomaticPublication;
    if (!pending || delay <= 0 || this.automaticPublicationRetryPaused) return;
    this.emitSchedulerTransition({
      channel: "publication",
      stage: "delayed",
      source,
      delayMs: delay,
    });
    this.automaticPublicationTimer = setTimeout(() => {
      this.automaticPublicationTimer = undefined;
      void this.publishAutomatically(pending, source);
    }, delay);
    this.refreshSchedulerMessage();
  }

  private async publishAutomatically(
    pending: AutomaticPublicationIntent,
    source: SchedulerSource = "event"
  ): Promise<void> {
    if (this.automaticPublicationPromise) return;
    const manager = this.index;
    const publication = this.publicationManager;
    if (
      !manager ||
      !publication ||
      this.pendingAutomaticPublication !== pending ||
      this.getSettings().filo.automaticPublicationDelayMs <= 0
    )
      return;
    if (this.queuedWork || !this.isCurrentPublicationIntent(pending) || !manager.isComplete())
      return;
    if (
      manager.isBuilding() ||
      manager.isInMaintenance() ||
      manager.capabilities().semantic.activity === "updating" ||
      publication.isBusy
    ) {
      this.emitSchedulerTransition({
        channel: "publication",
        stage: "delayed",
        source,
        delayMs: 1_000,
      });
      this.scheduleAutomaticPublication(1_000, source);
      return;
    }
    const attempt = this.publishOnce(publication);
    const startedAt = Date.now();
    this.emitSchedulerTransition({ channel: "publication", stage: "running", source });
    this.automaticPublicationPromise = (async () => {
      const result = await attempt;
      if (this.index !== manager || this.publicationManager !== publication) return;
      if (result.published) {
        if (
          this.pendingAutomaticPublication === pending &&
          this.isCurrentPublicationIntent(pending)
        ) {
          this.pendingAutomaticPublication = undefined;
          this.clearAutomaticPublicationRetry();
          this.automaticPublicationRetryAttempt = 0;
          this.automaticPublicationRetryPaused = false;
        }
        this.indexStatus?.setPublicationWarning(undefined);
        this.emitSchedulerTransition({
          channel: "publication",
          stage: "completed",
          source,
          durationMs: Date.now() - startedAt,
          publicationSizeBytes: publication.metrics?.byteSize,
        });
        return;
      }
      if (result.warning) {
        this.handlePublicationWarning(result.warning);
        this.emitSchedulerTransition({
          channel: "publication",
          stage: "failed",
          source,
          durationMs: Date.now() - startedAt,
        });
        this.scheduleAutomaticPublicationRetry(pending, result.warning.retryable);
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.automaticPublicationPromise = undefined;
        this.refreshSchedulerMessage();
      });
    this.refreshSchedulerMessage();
    return this.automaticPublicationPromise;
  }

  private publishOnQuit(): Promise<void> | undefined {
    const manager = this.index;
    const publication = this.publicationManager;
    const pending = this.pendingAutomaticPublication;
    if (
      !manager ||
      !publication ||
      !pending ||
      this.getSettings().filo.automaticPublicationDelayMs <= 0 ||
      !this.indexReady ||
      this.queuedWork ||
      this.reconcilePromise ||
      !this.isCurrentPublicationIntent(pending) ||
      !manager.isComplete() ||
      manager.isBuilding() ||
      manager.isInMaintenance()
    )
      return undefined;
    this.clearAutomaticPublicationTimer();
    this.clearAutomaticPublicationRetry();
    const task =
      this.automaticPublicationPromise ??
      (async () => {
        const startedAt = Date.now();
        this.emitSchedulerTransition({ channel: "publication", stage: "running", source: "quit" });
        const result = await this.publishOnce(publication);
        if (this.index !== manager || this.publicationManager !== publication) return;
        if (result.published) {
          if (
            this.pendingAutomaticPublication === pending &&
            this.isCurrentPublicationIntent(pending)
          )
            this.pendingAutomaticPublication = undefined;
          this.indexStatus?.setPublicationWarning(undefined);
          this.emitSchedulerTransition({
            channel: "publication",
            stage: "completed",
            source: "quit",
            durationMs: Date.now() - startedAt,
            publicationSizeBytes: publication.metrics?.byteSize,
          });
        } else if (result.warning) {
          this.handlePublicationWarning(result.warning);
          this.emitSchedulerTransition({
            channel: "publication",
            stage: "failed",
            source: "quit",
            durationMs: Date.now() - startedAt,
          });
          this.scheduleAutomaticPublicationRetry(pending, result.warning.retryable);
        }
      })();
    return task;
  }

  private publishOnce(publication: PublicationManager): ReturnType<PublicationManager["publish"]> {
    if (this.activePublicationPromise) return this.activePublicationPromise;
    const wrapped = publication.publish().finally(() => {
      if (this.activePublicationPromise === wrapped) this.activePublicationPromise = undefined;
    });
    this.activePublicationPromise = wrapped;
    return wrapped;
  }

  private isCurrentPublicationIntent(pending: AutomaticPublicationIntent): boolean {
    return (
      this.pendingAutomaticPublication === pending &&
      pending.revision === this.automaticPublicationRevision &&
      pending.eventRevision === this.vaultEventRevision &&
      pending.changeCounter === this.latestPublicationChangeCounter
    );
  }

  private scheduleAutomaticPublicationRetry(
    pending: AutomaticPublicationIntent | undefined,
    retryable: boolean
  ): void {
    this.clearAutomaticPublicationRetry();
    if (
      !retryable ||
      this.getSettings().filo.automaticPublicationDelayMs <= 0 ||
      !pending ||
      this.pendingAutomaticPublication !== pending ||
      !this.isCurrentPublicationIntent(pending)
    ) {
      if (!retryable) this.automaticPublicationRetryPaused = true;
      return;
    }
    const delays = [5_000, 15_000, 60_000];
    if (this.automaticPublicationRetryAttempt >= delays.length) {
      this.automaticPublicationRetryPaused = true;
      return;
    }
    const delay = delays[this.automaticPublicationRetryAttempt++];
    this.emitSchedulerTransition({
      channel: "publication",
      stage: "retrying",
      source: "retry",
      delayMs: delay,
      retryAttempt: this.automaticPublicationRetryAttempt,
    });
    this.automaticPublicationRetryTimer = setTimeout(() => {
      this.automaticPublicationRetryTimer = undefined;
      void this.publishAutomatically(pending, "retry");
    }, delay);
    this.refreshSchedulerMessage();
  }

  private clearAutomaticPublicationTimer(): void {
    if (this.automaticPublicationTimer) clearTimeout(this.automaticPublicationTimer);
    this.automaticPublicationTimer = undefined;
  }

  private clearAutomaticPublicationRetry(): void {
    if (this.automaticPublicationRetryTimer) clearTimeout(this.automaticPublicationRetryTimer);
    this.automaticPublicationRetryTimer = undefined;
  }

  private pauseAutomaticPublicationForIndexing(): void {
    this.clearAutomaticPublicationTimer();
    this.clearAutomaticPublicationRetry();
  }

  private stopAutomaticPublication(): void {
    this.clearAutomaticPublicationTimer();
    this.clearAutomaticPublicationRetry();
    this.pendingAutomaticPublication = undefined;
    this.automaticPublicationRetryAttempt = 0;
    this.automaticPublicationRetryPaused = false;
  }

  private clearPublicationIntentAfterAdoption(): void {
    this.automaticPublicationRevision++;
    this.stopAutomaticPublication();
    this.refreshSchedulerMessage();
  }

  private handlePublicationWarning(warning: PublicationWarning): void {
    if (this.indexStatus)
      this.indexStatus.setPublicationWarning(
        `Index saved locally, but publication failed: ${warning.message}`
      );
  }

  private notifyPublicationFileEvent(path: string): void {
    const manager = this.publicationManager;
    if (!manager || path !== manager.store.path) return;
    manager.notifyFileEvent(path);
  }

  private armAutomaticWork(): void {
    if (this.getSettings().filo.automaticLexicalDelayMs <= 0) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.automaticRetryAttempt = 0;
    this.automaticRetryPaused = false;
    this.automaticStopPaused = false;
    this.maybeScheduleStartupRecovery();
    if (this.queuedWork && this.indexReady) this.scheduleReconcile();
  }

  private maybeScheduleStartupRecovery(): void {
    if (
      !this.layoutReady ||
      !this.indexLoaded ||
      !this.index ||
      this.startupRecoveryStarted ||
      this.getSettings().filo.automaticLexicalDelayMs <= 0
    )
      return;
    this.startupRecoveryStarted = true;
    if (this.index.requestFullRecovery) this.index.requestFullRecovery();
    else {
      this.fullRecoveryPending = true;
      this.index.queueChange();
    }
    this.queuedWork = true;
    if (this.indexReady) this.scheduleReconcile("startup");
  }

  private stopAutomaticSemanticWork(): void {
    if (this.automaticSemanticTimer) clearTimeout(this.automaticSemanticTimer);
    this.automaticSemanticTimer = undefined;
    if (this.automaticSemanticRetryTimer) clearTimeout(this.automaticSemanticRetryTimer);
    this.automaticSemanticRetryTimer = undefined;
    this.automaticSemanticAbort?.abort();
    this.automaticSemanticAbort = undefined;
  }

  /** Cancels the operation currently shown by Filo and suppresses automatic rescheduling. */
  private cancelActiveIndexOperation(): void {
    const lexical = this.automaticLexicalLease;
    const semantic = this.automaticSemanticLease;
    if (lexical) {
      this.automaticStopPaused = true;
      this.automaticReschedulePending = false;
      if (this.eventTimer) clearTimeout(this.eventTimer);
      this.eventTimer = undefined;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      lexical.abort();
    }
    if (semantic) {
      this.automaticSemanticStopPaused = true;
      if (this.automaticSemanticTimer) clearTimeout(this.automaticSemanticTimer);
      this.automaticSemanticTimer = undefined;
      if (this.automaticSemanticRetryTimer) clearTimeout(this.automaticSemanticRetryTimer);
      this.automaticSemanticRetryTimer = undefined;
      semantic.abort();
    }
    // Explicit semantic work is owned by the same status lease, while this
    // controller remains a compatibility path for callers outside Filo.
    this.semanticAbort?.abort();
  }

  private pauseAutomaticSemanticForLexicalWork(): void {
    this.stopAutomaticSemanticWork();
    this.automaticSemanticStopPaused = false;
    this.automaticSemanticRetryAttempt = 0;
    this.automaticSemanticRetryPaused = false;
  }

  private scheduleAutomaticSemantic(source: SchedulerSource = "event"): void {
    const delay = this.getSettings().filo.automaticSemanticDelayMs;
    const manager = this.index;
    if (delay <= 0) {
      this.emitSchedulerTransition({ channel: "semantic", stage: "disabled", source });
      return;
    }
    if (
      !manager ||
      !this.indexReady ||
      !manager.isComplete() ||
      this.queuedWork ||
      !this.automaticSemanticEligible ||
      this.automaticSemanticRetryPaused ||
      this.automaticSemanticStopPaused ||
      this.reconcilePromise ||
      this.indexStatus?.hasActiveOperation("lexical")
    ) {
      if (manager?.isComplete() && !this.automaticSemanticEligible)
        this.emitSchedulerTransition({
          channel: "semantic",
          stage: "incomplete",
          source,
          delayMs: delay,
        });
      return;
    }
    if (this.automaticSemanticTimer) clearTimeout(this.automaticSemanticTimer);
    this.emitSchedulerTransition({ channel: "semantic", stage: "delayed", source, delayMs: delay });
    this.automaticSemanticTimer = setTimeout(() => {
      this.automaticSemanticTimer = undefined;
      void this.runAutomaticSemanticBatch(source === "retry" ? "retry" : source);
    }, delay);
    this.refreshSchedulerMessage();
  }

  private scheduleAutomaticSemanticRetry(error: unknown): void {
    if (
      !isRetryableError(error) ||
      this.getSettings().filo.automaticSemanticDelayMs <= 0 ||
      this.queuedWork ||
      this.automaticSemanticStopPaused
    )
      return;
    const delays = [5_000, 15_000, 60_000];
    if (this.automaticSemanticRetryAttempt >= delays.length) {
      this.automaticSemanticRetryPaused = true;
      return;
    }
    const delay = delays[this.automaticSemanticRetryAttempt++];
    this.emitSchedulerTransition({
      channel: "semantic",
      stage: "retrying",
      source: "retry",
      delayMs: delay,
      retryAttempt: this.automaticSemanticRetryAttempt,
    });
    this.automaticSemanticRetryTimer = setTimeout(() => {
      this.automaticSemanticRetryTimer = undefined;
      void this.runAutomaticSemanticBatch("retry");
    }, delay);
    this.refreshSchedulerMessage();
  }

  private runAutomaticSemanticBatch(source: SchedulerSource = "event"): Promise<void> {
    if (this.automaticSemanticPromise)
      return this.automaticSemanticPromise.then(() => {
        if (this.automaticSemanticEligible && !this.queuedWork) this.scheduleAutomaticSemantic();
      });
    const manager = this.index;
    if (
      !manager ||
      this.getSettings().filo.automaticSemanticDelayMs <= 0 ||
      !this.indexReady ||
      !manager.isComplete() ||
      manager.isBuilding() ||
      this.queuedWork ||
      !this.automaticSemanticEligible ||
      this.automaticSemanticRetryPaused ||
      this.automaticSemanticStopPaused ||
      this.reconcilePromise ||
      this.indexStatus?.hasActiveOperation("lexical")
    )
      return Promise.resolve();

    const acquireLease = this.indexStatus?.acquireExternalLease;
    const lease = acquireLease
      ? acquireLease.call(this.indexStatus, "semantic")
      : new IndexOperationLease("semantic");
    if (!lease) return Promise.resolve();
    this.automaticSemanticLease = lease;
    const controller = lease.controller;
    this.automaticSemanticAbort = controller;
    const startedAt = Date.now();
    const previousSource = this.currentSchedulerSource;
    this.currentSchedulerSource = source;
    this.emitSchedulerTransition({ channel: "semantic", stage: "running", source });
    this.automaticSemanticPromise = (async () => {
      let continueCatchup = false;
      try {
        const result = await manager.prepareSemanticCacheBatch(controller.signal);
        if (controller.signal.aborted) throw new Error("Semantic indexing cancelled.");
        if (this.index !== manager) return;
        this.emitSchedulerTransition({
          channel: "semantic",
          stage: result.converged ? "completed" : "incomplete",
          source,
          durationMs: Date.now() - startedAt,
          counts: { stored: result.stored, skipped: result.skipped },
        });
        if (result.converged) {
          this.automaticSemanticEligible = false;
          this.automaticSemanticRetryAttempt = 0;
          this.automaticSemanticRetryPaused = false;
        } else if (
          !controller.signal.aborted &&
          !this.automaticSemanticStopPaused &&
          !this.queuedWork &&
          manager.isComplete()
        ) {
          continueCatchup = true;
        }
      } catch (error) {
        this.emitSchedulerTransition({
          channel: "semantic",
          stage: controller.signal.aborted ? "cancelled" : "failed",
          source,
          durationMs: Date.now() - startedAt,
          error: projectDiagnosticError(error),
        });
        if (controller.signal.aborted) {
          if (this.automaticSemanticStopPaused) {
            if (this.automaticSemanticRetryTimer) clearTimeout(this.automaticSemanticRetryTimer);
            this.automaticSemanticRetryTimer = undefined;
          }
        } else if (isRetryableError(error)) this.scheduleAutomaticSemanticRetry(error);
        else {
          this.automaticSemanticEligible = false;
          this.automaticSemanticRetryPaused = true;
          this.indexStatus?.markError(error);
        }
      } finally {
        if (this.index === manager && !continueCatchup) this.updateIndexCapabilities(manager);
        if (this.automaticSemanticAbort === controller) this.automaticSemanticAbort = undefined;
        this.automaticSemanticPromise = undefined;
        lease.release();
        if (this.automaticSemanticLease === lease) this.automaticSemanticLease = undefined;
        if (this.automaticSemanticAbort === controller) this.automaticSemanticAbort = undefined;
        this.currentSchedulerSource = previousSource;
        if (continueCatchup && !this.automaticSemanticStopPaused) {
          this.automaticSemanticTimer = setTimeout(() => {
            this.automaticSemanticTimer = undefined;
            void this.runAutomaticSemanticBatch();
          }, 100);
        }
      }
    })();
    this.refreshSchedulerMessage();
    return this.automaticSemanticPromise;
  }

  private stopAutomaticWork(markStale = true, rescheduleAfterAbort = false): void {
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.automaticAbort) {
      this.automaticAbort.abort();
      this.automaticAbort = undefined;
      if (rescheduleAfterAbort) this.automaticReschedulePending = true;
      this.queuedWork = true;
    }
    if (markStale && this.queuedWork) this.markQueuedWorkStale();
  }

  private markQueuedWorkStale(): void {
    if (!this.indexStatus) return;
    const manager = this.index as (IndexManager & { hasUsableIndex?: () => boolean }) | undefined;
    const hasLastGood = manager?.hasUsableIndex?.() ?? this.indexReady;
    this.indexStatus.markStale(hasLastGood);
  }

  private async runFullIndex(signal: AbortSignal): Promise<void> {
    return this.runIndex(signal, true);
  }

  private async runBothIndexes(signal: AbortSignal): Promise<void> {
    this.combinedRebuildLexicalPhase = true;
    try {
      await this.runIndex(signal, true, false);
    } finally {
      this.combinedRebuildLexicalPhase = false;
    }
    if (!this.index?.isComplete())
      throw new Error("Lexical index did not converge; semantic index was not rebuilt.");
    this.indexStatus?.beginSemanticRebuild();
    await this.runSemanticPreparation(signal, true);
  }

  private async runIndex(signal: AbortSignal, force: boolean, settleStatus = true): Promise<void> {
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = undefined;
    this.pauseAutomaticPublicationForIndexing();
    this.stopAutomaticWork(false);
    this.automaticRetryAttempt = 0;
    this.automaticRetryPaused = false;
    this.automaticSemanticStopPaused = false;
    this.automaticStopPaused = false;
    const manager = this.index;
    if (!manager) throw new Error("Index is not initialized.");
    this.stopAutomaticSemanticWork();
    await this.indexLoad;
    if (this.index !== manager) throw new Error("Index was replaced during indexing.");
    this.automaticSemanticEligible ||= this.hasAutomaticSemanticWork(manager);
    const eventRevision = this.vaultEventRevision;
    const startedAt = Date.now();
    this.currentSchedulerSource = "explicit";
    this.emitSchedulerTransition({ channel: "lexical", stage: "running", source: "explicit" });
    let result: IndexSyncResult;
    try {
      result = force
        ? (await manager.build(signal), { changed: true, converged: manager.isComplete() })
        : await manager.synchronize(signal);
    } catch (error) {
      this.emitSchedulerTransition({
        channel: "lexical",
        stage: signal.aborted ? "cancelled" : "failed",
        source: "explicit",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
    this.emitSchedulerTransition({
      channel: "lexical",
      stage: result.converged ? "completed" : "incomplete",
      source: "explicit",
      durationMs: Date.now() - startedAt,
    });
    this.indexReady = true;
    this.updateIndexCapabilities(manager);
    const app = (this as unknown as { app?: any }).app;
    if (app?.workspace) this.refreshOpenRelatedSuggestions(app);
    if (result.changed && app?.workspace) this.refreshOpenLente(app);
    if (result.converged && eventRevision === this.vaultEventRevision) {
      const journalRevision = this.index?.journalSnapshot?.().revision;
      if (journalRevision !== undefined) this.index?.clearJournalIfCurrent?.(journalRevision);
      this.queuedWork = false;
      this.automaticSemanticEligible ||= this.hasAutomaticSemanticWork(manager);
      this.scheduleAutomaticSemantic();
    }
    if (this.queuedWork) await this.reconcileNow("explicit", signal).catch(() => undefined);
    else if (settleStatus) {
      if (!manager.isComplete() || eventRevision !== this.vaultEventRevision)
        this.indexStatus?.markStale(manager.hasUsableIndex());
      else if (this.visibleMarkdownCatalog().length === 0) this.indexStatus?.setEmpty(true);
      else this.indexStatus?.setReady();
    }
  }

  private scheduleReconcile(source: SchedulerSource = "event"): void {
    const delay = this.getSettings().filo.automaticLexicalDelayMs;
    if (delay <= 0 || !this.queuedWork || this.automaticStopPaused) return;
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.emitSchedulerTransition({
      channel: "lexical",
      stage: "delayed",
      source,
      delayMs: delay,
      counts: { queued: this.index?.pendingChangeCount?.() ?? this.pendingVaultChanges.length },
    });
    this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined;
      void this.reconcileNow("automatic", undefined, source).catch(() => undefined);
    }, delay);
    this.refreshSchedulerMessage();
  }

  private scheduleAutomaticRetry(error: unknown): void {
    if (
      !isRetryableError(error) ||
      this.getSettings().filo.automaticLexicalDelayMs <= 0 ||
      this.automaticStopPaused
    )
      return;
    const delays = [5_000, 15_000, 60_000];
    if (this.automaticRetryAttempt >= delays.length) {
      this.automaticRetryPaused = true;
      this.emitSchedulerTransition({
        channel: "lexical",
        stage: "failed",
        source: "retry",
        retryAttempt: this.automaticRetryAttempt,
        counts: { queued: this.index?.pendingChangeCount?.() ?? this.pendingVaultChanges.length },
      });
      this.refreshSchedulerMessage();
      return;
    }
    const delay = delays[this.automaticRetryAttempt];
    this.automaticRetryAttempt++;
    this.emitSchedulerTransition({
      channel: "lexical",
      stage: "retrying",
      source: "retry",
      delayMs: delay,
      retryAttempt: this.automaticRetryAttempt,
      counts: { queued: this.index?.pendingChangeCount?.() ?? this.pendingVaultChanges.length },
    });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.queuedWork || this.getSettings().filo.automaticLexicalDelayMs <= 0) return;
      if (this.eventTimer) clearTimeout(this.eventTimer);
      this.eventTimer = undefined;
      void this.reconcileNow("automatic", undefined, "retry").catch(() => undefined);
    }, delay);
    this.refreshSchedulerMessage();
  }

  private async reconcileNow(
    source: "automatic" | "explicit" = "explicit",
    explicitSignal?: AbortSignal,
    trigger: SchedulerSource = source === "automatic" ? "event" : "explicit"
  ): Promise<void> {
    if (source === "automatic" && this.getSettings().filo.automaticLexicalDelayMs <= 0) return;
    const manager = this.index;
    if (!manager || !this.indexReady || !this.lifecycleAbort) return;
    // Explicit builds own the user-facing state. The queued work remains in
    // IndexManager and is picked up after the build commits or fails.
    if (manager.isBuilding()) return;
    if (manager.capabilities().semantic.activity === "updating") {
      this.queuedWork = true;
      return;
    }
    if (this.reconcilePromise) {
      this.queuedWork = true;
      return this.reconcilePromise;
    }
    const eventRevision = this.vaultEventRevision;
    const journal = manager.journalSnapshot?.();
    const changes = journal?.changes ?? this.pendingVaultChanges;
    const queuedCount = manager.pendingChangeCount?.() ?? changes.length;
    this.queuedWork = false;
    this.pauseAutomaticPublicationForIndexing();
    const acquireLease = this.indexStatus?.acquireExternalLease;
    const automaticLease =
      source === "automatic"
        ? acquireLease
          ? acquireLease.call(this.indexStatus, "lexical")
          : new IndexOperationLease("lexical")
        : undefined;
    if (source === "automatic" && !automaticLease) {
      this.queuedWork = true;
      return;
    }
    if (source === "automatic") {
      this.automaticLexicalLease = automaticLease;
      this.automaticAbort = automaticLease!.controller;
    }
    const operationSignal =
      source === "automatic"
        ? automaticLease!.signal
        : (explicitSignal ?? this.lifecycleAbort.signal);
    let completed = false;
    const startedAt = Date.now();
    const previousSource = this.currentSchedulerSource;
    this.currentSchedulerSource = trigger;
    if (source === "automatic")
      this.emitSchedulerTransition({
        channel: "lexical",
        stage: "running",
        source: trigger,
        counts: { queued: queuedCount },
      });
    this.reconcilePromise = (async () => {
      try {
        const fullRecovery =
          this.fullRecoveryPending ||
          journal?.fullRecovery === true ||
          changes.length === 0 ||
          !manager.isComplete();
        const result = fullRecovery
          ? await manager.synchronize(operationSignal)
          : await manager.reconcileChanges(changes, operationSignal);
        if (operationSignal.aborted) throw new Error("Lexical indexing cancelled.");
        if (journal) {
          if (result.converged) manager.clearJournalIfCurrent?.(journal.revision);
        } else {
          this.pendingVaultChanges.length = 0;
          this.fullRecoveryPending = false;
        }
        const current =
          result.converged &&
          manager.isComplete() &&
          eventRevision === this.vaultEventRevision &&
          !(manager.hasPendingWork?.() ?? false);
        if (current) {
          this.queuedWork = false;
          this.automaticRetryAttempt = 0;
          this.automaticRetryPaused = false;
          if (this.retryTimer) clearTimeout(this.retryTimer);
          this.retryTimer = undefined;
        } else if (
          !result.converged ||
          !manager.isComplete() ||
          eventRevision !== this.vaultEventRevision ||
          (manager.hasPendingWork?.() ?? false)
        ) {
          this.queuedWork = true;
        }
        completed = true;
        if (source === "automatic")
          this.emitSchedulerTransition({
            channel: "lexical",
            stage: result.converged ? "completed" : "incomplete",
            source: trigger,
            durationMs: Date.now() - startedAt,
            counts: { queued: queuedCount },
          });
        this.updateIndexCapabilities(manager);
        if (current) this.indexStatus?.setReady();
        else this.indexStatus?.markStale(manager.hasUsableIndex?.() ?? this.indexReady);
        const app = (this as unknown as { app?: any }).app;
        if (app?.workspace) this.refreshOpenRelatedSuggestions(app);
        if (result.changed && app?.workspace) this.refreshOpenLente(app);
        if (result.converged && manager.isComplete()) {
          this.automaticSemanticEligible ||= this.hasAutomaticSemanticWork(manager);
          this.scheduleAutomaticSemantic();
        }
      } catch (error) {
        if (source === "automatic")
          this.emitSchedulerTransition({
            channel: "lexical",
            stage: operationSignal.aborted ? "cancelled" : "failed",
            source: trigger,
            durationMs: Date.now() - startedAt,
            counts: { queued: queuedCount },
            error: projectDiagnosticError(error),
          });
        this.queuedWork = true;
        if (this.index === manager) this.indexStatus?.markStale(true);
        if (operationSignal.aborted) {
          // A user Stop preserves the dirty journal and waits for this lease to
          // settle. It must not turn cancellation into an immediate retry.
          if (this.automaticStopPaused) {
            this.automaticReschedulePending = false;
            if (this.retryTimer) clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
          }
        } else this.scheduleAutomaticRetry(error);
        throw error;
      } finally {
        this.reconcilePromise = undefined;
        automaticLease?.release();
        if (this.automaticLexicalLease === automaticLease) this.automaticLexicalLease = undefined;
        const shouldResumeAfterCancellation =
          source === "automatic" && this.automaticReschedulePending;
        if (
          source === "automatic" &&
          (completed || shouldResumeAfterCancellation) &&
          !this.automaticStopPaused &&
          this.queuedWork &&
          this.indexReady &&
          this.getSettings().filo.automaticLexicalDelayMs > 0
        ) {
          this.automaticReschedulePending = false;
          this.scheduleReconcile();
        }
        if (source === "automatic" && this.automaticAbort?.signal === operationSignal)
          this.automaticAbort = undefined;
        this.currentSchedulerSource = previousSource;
        this.refreshSchedulerMessage();
      }
    })();
    this.refreshSchedulerMessage();
    return this.reconcilePromise;
  }

  private registerVaultEvents(vault: any): void {
    this.registerVaultEvent(vault, "create", (file: TAbstractFile) =>
      this.handleVaultPathEvent(file, "upsert")
    );
    this.registerVaultEvent(vault, "modify", (file: TAbstractFile) =>
      this.handleVaultPathEvent(file, "upsert")
    );
    this.registerVaultEvent(vault, "delete", (file: TAbstractFile) =>
      this.handleVaultPathEvent(file, "delete")
    );
    this.registerVaultEvent(vault, "rename", (file: TAbstractFile, oldPath: string) => {
      if (typeof oldPath === "string") this.notifyPublicationFileEvent(oldPath);
      if (typeof file?.path === "string") this.notifyPublicationFileEvent(file.path);
      if (
        (typeof oldPath === "string" && this.isPublicationPath(oldPath)) ||
        (typeof file?.path === "string" && this.isPublicationPath(file.path))
      )
        return;
      if (
        !file ||
        typeof file.path !== "string" ||
        this.isFolder(file) ||
        typeof oldPath !== "string"
      ) {
        this.requestFullRecovery(file?.path);
        return;
      }
      const oldMarkdown = this.isMarkdownPath(oldPath);
      const newMarkdown = this.isMarkdownPath(file.path);
      const oldEligible = oldMarkdown && this.isIndexEligible(oldPath);
      const newEligible = newMarkdown && this.isIndexEligible(file.path);
      if (oldEligible && newEligible)
        this.queueVaultMutation({ type: "rename", from: oldPath, to: file.path });
      else if (oldEligible) this.queueVaultMutation({ type: "delete", path: oldPath });
      else if (newEligible) this.queueVaultMutation({ type: "upsert", path: file.path });
    });
  }
  private registerVaultEvent(vault: any, event: string, callback: (...args: any[]) => void): void {
    const ref = vault.on(event, callback);
    this.eventRefs.push(ref);
    this.registerEvent(ref);
  }
  private handleVaultPathEvent(file: TAbstractFile | undefined, type: "upsert" | "delete"): void {
    if (!file || typeof file.path !== "string") {
      this.requestFullRecovery();
      return;
    }
    this.notifyPublicationFileEvent(file.path);
    if (this.isPublicationPath(file.path)) return;
    if (this.isFolder(file)) {
      this.requestFullRecovery(file.path);
      return;
    }
    if (!this.isMarkdownPath(file.path) || !this.isIndexEligible(file.path)) return;
    this.queueVaultMutation({ type, path: file.path });
  }

  private queueVaultMutation(mutation: IndexPathMutation): void {
    if (!this.index) return;
    this.pauseAutomaticPublicationForIndexing();
    this.automaticSemanticEligible ||= this.hasAutomaticSemanticWork(this.index);
    this.pauseAutomaticSemanticForLexicalWork();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.automaticRetryAttempt = 0;
    this.automaticRetryPaused = false;
    this.automaticStopPaused = false;
    this.vaultEventRevision++;
    if (this.index.recordPathMutation) this.index.recordPathMutation(mutation);
    else {
      this.index.queueChange();
      coalescePathMutation(this.pendingVaultChanges, mutation);
    }
    this.emitSchedulerTransition({
      channel: "lexical",
      stage: "queued",
      source: "event",
      delayMs: this.getSettings().filo.automaticLexicalDelayMs,
      counts: {
        events: 1,
        queued: this.index.pendingChangeCount?.() ?? this.pendingVaultChanges.length,
      },
    });
    this.queuedWork = true;
    if (this.indexReady && this.getSettings().filo.automaticLexicalDelayMs > 0) {
      if (!this.index.isBuilding() && this.index.capabilities().semantic.activity !== "updating")
        this.indexStatus?.setUpdating();
      this.scheduleReconcile();
    } else {
      if (this.indexReady && this.index.capabilities().semantic.activity !== "updating")
        this.markQueuedWorkStale();
    }
    this.refreshSchedulerMessage();
  }

  private requestFullRecovery(path?: string): void {
    if (path && this.isPublicationPath(path)) return;
    if (!this.index) return;
    this.pauseAutomaticPublicationForIndexing();
    this.automaticSemanticEligible ||= this.hasAutomaticSemanticWork(this.index);
    this.pauseAutomaticSemanticForLexicalWork();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.automaticRetryAttempt = 0;
    this.automaticRetryPaused = false;
    this.automaticStopPaused = false;
    this.vaultEventRevision++;
    if (this.index.requestFullRecovery) this.index.requestFullRecovery();
    else {
      this.fullRecoveryPending = true;
      this.index.queueChange();
    }
    this.queuedWork = true;
    this.emitSchedulerTransition({
      channel: "lexical",
      stage: "queued",
      source: "event",
      delayMs: this.getSettings().filo.automaticLexicalDelayMs,
      counts: {
        events: 1,
        queued: this.index.pendingChangeCount?.() ?? this.pendingVaultChanges.length,
        fullRecovery: 1,
      },
    });
    if (this.indexReady && this.getSettings().filo.automaticLexicalDelayMs > 0)
      this.scheduleReconcile();
    else if (this.indexReady) this.markQueuedWorkStale();
    this.refreshSchedulerMessage();
  }

  private isFolder(file: unknown): boolean {
    return Boolean(file && typeof file === "object" && Array.isArray((file as any).children));
  }

  private isMarkdownPath(path: string): boolean {
    return /\.md$/i.test(path);
  }

  private isPublicationPath(path: string): boolean {
    const directory = this.getSettings().publicationDirectory.replace(/\/$/, "");
    return path === directory || path.startsWith(`${directory}/`);
  }

  private isIndexEligible(path: string): boolean {
    return (
      this.isVisibleMarkdown(path) &&
      !isExcludedPath(path, [
        ...this.getSettings().filo.excludedPaths,
        this.getSettings().publicationDirectory,
      ])
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
