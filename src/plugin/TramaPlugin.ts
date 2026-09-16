import { Platform, Plugin, TAbstractFile } from "obsidian";
import { ChatSession } from "@/chat/ChatSession";
import { TramaDiagnostics } from "@/diagnostics/TramaDiagnostics";
import {
  IndexManager,
  IndexVaultPort,
  type IndexOperationResult,
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
import { IndexStatusController } from "@/ui/index/IndexStatus";
import { RelatedNotes } from "@/index/RelatedNotes";
import { TRAMA_ICONS } from "@/ui/icons";
import { LenteBatch, LenteSearch, LenteSearchOptions } from "@/index/LenteSearch";
import { ObsidianLenteNoteStats } from "@/vault/readOnly/ObsidianLenteNoteStats";
import { LenteSearchModal } from "@/ui/lente/LenteSearchModal";
import type { SqliteWorkerClient, SqliteWorkerLike } from "@/index/sqlite/client";
import {
  PublicationManager,
  type PublicationWarning,
} from "@/index/publications/PublicationManager";
import { PublicationStore } from "@/index/publications/PublicationStore";

interface LenteSearchPort {
  search(query: string, options?: LenteSearchOptions): Promise<LenteBatch>;
}

/** Composes the shared assistant and owns its lifecycle and vault event boundary. */
export class TramaPlugin extends Plugin {
  private runtimeLoaded = false;
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
  private sqliteIdentity?: string;
  private sqliteIdentityAdapter?: SnapshotDataAdapter;
  private publicationManager?: PublicationManager;
  private publicationCheckTimer?: ReturnType<typeof setTimeout>;
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
        prepare: (signal) => this.runSemanticPreparation(signal),
        cancel: () => this.semanticAbort?.abort(),
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
    this.semanticAbort?.abort();
    this.semanticAbort = undefined;
    this.index?.disposeImmediately();
    this.index = undefined;
    this.indexStatus?.cancel();
    this.lifecycleAbort?.abort();
    this.stopAutomaticWork(false);
    if (this.publicationCheckTimer) clearTimeout(this.publicationCheckTimer);
    this.publicationCheckTimer = undefined;
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
    const app = (this as unknown as { app?: any }).app;

    if (!saved.filo.automaticUpdates)
      this.stopAutomaticWork(true, before.filo.automaticUpdates && !saved.filo.automaticUpdates);
    else if (!before.filo.automaticUpdates) this.armAutomaticWork();

    if (indexDefinitionChanged || publicationDirectoryChanged) {
      this.stopAutomaticWork(false);
      this.session?.cancel();
      this.semanticAbort?.abort();
      this.semanticAbort = undefined;
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
      app.vault,
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
          void this.publishAfterIndexOperation(manager, composedPublication, result);
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
    const publication = composedPublication;
    const loadPromise = manager
      .load({ emitDiagnostics: false })
      .then(async (loaded) => {
        if (loaded && this.index === manager) {
          const adoption = await publication!.adoptOnStartup();
          if (adoption.warning) this.handlePublicationWarning(adoption.warning);
        }
        return loaded;
      })
      .catch(() => false);
    this.indexLoad = loadPromise;
    void loadPromise.then((loaded) => {
      if (this.index !== manager || compositionRevision !== this.compositionRevision) return;
      this.indexLoaded = true;
      this.indexReady = loaded;
      this.updateIndexCapabilities(manager);
      const hadPendingChanges = this.pendingVaultChanges.size > 0;
      if (this.pendingVaultChanges.size) manager.queueChange();
      this.pendingVaultChanges.clear();
      if (!loaded || !manager.isComplete()) {
        // The initial persisted-index decision is startup bookkeeping and must
        // stay silent even if debugging is enabled immediately after onload.
        if (manager.hasUsableIndex()) this.indexStatus?.markStale(true);
        else this.indexStatus?.setIndexRequired(true);
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
    return this.sqliteAssetUrl(app, "sqlite-worker.mjs");
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
    const bootstrap = `globalThis.__TRAMA_SQLITE_ASSETS__=${JSON.stringify(assets)};const __tramaWorkerUrl=${JSON.stringify(workerUrl)};let __tramaStartupError;try{await import(__tramaWorkerUrl)}catch{__tramaStartupError={code:"storage_unavailable",message:"SQLite Worker could not be started. Ensure the bundled SQLite assets are installed.",retryable:true}}URL.revokeObjectURL(globalThis.location.href);if(__tramaStartupError)self.onmessage=({data})=>self.postMessage({v:1,id:Number.isSafeInteger(data?.id)?data.id:0,ok:false,error:__tramaStartupError});`;
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
    const result = await this.publicationManager?.retryPublication();
    if (result?.warning) this.handlePublicationWarning(result.warning);
    else if (result?.published) this.indexStatus?.setPublicationWarning(undefined);
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

  private async runSemanticPreparation(signal: AbortSignal): Promise<void> {
    if (!this.index) throw new Error("Index is not initialized.");
    await this.index.prepareSemantic(signal);
    this.indexReady = true;
    this.updateIndexCapabilities(this.index);
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
    const result = await this.publicationManager?.adoptCurrent();
    if (result?.warning) this.handlePublicationWarning(result.warning);
    else if (result?.adopted && this.index) {
      this.updateIndexCapabilities(this.index);
      this.indexReady = true;
      this.indexStatus?.setPublicationWarning(undefined);
      this.refreshOpenRelatedSuggestions((this as unknown as { app?: any }).app);
      this.refreshOpenLente((this as unknown as { app?: any }).app);
    }
  }

  getRelatedNotes(): RelatedNotes | undefined {
    return this.relatedNotes;
  }

  private updateIndexCapabilities(manager: IndexManager): void {
    if (this.index !== manager || !this.indexStatus) return;
    const candidate = manager as unknown as {
      capabilities?: () => ReturnType<IndexManager["getCapabilities"]>;
      getCapabilities?: () => ReturnType<IndexManager["getCapabilities"]>;
    };
    const capabilities = candidate.capabilities?.() ?? candidate.getCapabilities?.();
    if (!capabilities) return;
    this.indexStatus.setCapabilities(capabilities);
  }

  private async publishAfterIndexOperation(
    manager: IndexManager,
    publication: PublicationManager | undefined,
    result: IndexOperationResult
  ): Promise<void> {
    if (!publication) return;
    // IndexManager invokes its hook before its operation's finally block clears
    // its maintenance flag. Defer publication until the live database is idle.
    while (
      this.index === manager &&
      (manager.isBuilding() ||
        manager.isInMaintenance() ||
        manager.capabilities().semantic.activity === "updating")
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (this.index === manager) await publication.autoPublish(result);
  }

  private handlePublicationWarning(warning: PublicationWarning): void {
    if (this.indexStatus)
      this.indexStatus.setPublicationWarning(
        `Index saved locally, but publication failed: ${warning.message}`
      );
  }

  private notifyPublicationFileEvent(path: string): void {
    const manager = this.publicationManager;
    if (!manager) return;
    manager.notifyFileEvent(path);
    if (this.publicationCheckTimer) clearTimeout(this.publicationCheckTimer);
    this.publicationCheckTimer = setTimeout(() => {
      this.publicationCheckTimer = undefined;
      if (this.index?.isBuilding() || this.index?.isInMaintenance()) {
        this.notifyPublicationFileEvent(manager.store.path);
        return;
      }
      void manager.flushPendingEvents().then((result) => {
        if (this.publicationManager !== manager || !result?.adopted) return;
        this.indexReady = true;
        this.updateIndexCapabilities(this.index!);
        this.indexStatus?.setPublicationWarning(undefined);
        const app = (this as unknown as { app?: any }).app;
        this.refreshOpenRelatedSuggestions(app);
        this.refreshOpenLente(app);
      });
    }, 0);
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

  private markQueuedWorkStale(): void {
    if (!this.indexStatus) return;
    const manager = this.index as (IndexManager & { hasUsableIndex?: () => boolean }) | undefined;
    const hasLastGood = manager?.hasUsableIndex?.() ?? this.indexReady;
    this.indexStatus.markStale(hasLastGood);
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
    const result = force
      ? (await manager.build(signal), { changed: true, converged: manager.isComplete() })
      : await manager.synchronize(signal);
    this.indexReady = true;
    this.updateIndexCapabilities(manager);
    const app = (this as unknown as { app?: any }).app;
    if (app?.workspace) this.refreshOpenRelatedSuggestions(app);
    if (result.changed && app?.workspace) this.refreshOpenLente(app);
    this.pendingVaultChanges.clear();
    if (this.queuedWork) await this.reconcileNow("explicit", signal).catch(() => undefined);
    else if (!manager.isComplete()) this.indexStatus?.markStale(manager.hasUsableIndex());
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
      .then((result) => {
        completed = true;
        this.updateIndexCapabilities(manager);
        if (result.converged && manager.isComplete()) this.indexStatus?.setReady();
        else this.indexStatus?.markStale(manager.hasUsableIndex?.() ?? this.indexReady);
        const app = (this as unknown as { app?: any }).app;
        if (app?.workspace) this.refreshOpenRelatedSuggestions(app);
        if (result.changed && app?.workspace) this.refreshOpenLente(app);
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
    this.registerVaultEvent(vault, "create", (file: TAbstractFile) => {
      this.notifyPublicationFileEvent(file.path);
      this.queueVaultOperation({ kind: "create", path: file.path });
    });
    this.registerVaultEvent(vault, "modify", (file: TAbstractFile) => {
      this.notifyPublicationFileEvent(file.path);
      this.queueVaultOperation({ kind: "modify", path: file.path });
    });
    this.registerVaultEvent(vault, "delete", (file: TAbstractFile) => {
      this.notifyPublicationFileEvent(file.path);
      this.queueVaultOperation({ kind: "delete", path: file.path });
    });
    this.registerVaultEvent(vault, "rename", (file: TAbstractFile, oldPath: string) => {
      this.notifyPublicationFileEvent(oldPath);
      this.notifyPublicationFileEvent(file.path);
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
      this.index.queueChange();
      for (const path of paths) this.pendingVaultChanges.add(path);
      this.queuedWork = true;
      return;
    }
    this.queuedWork = true;
    this.index.queueChange();
    if (this.getSettings().filo.automaticUpdates) {
      if (!this.index.isBuilding()) this.indexStatus?.setUpdating();
      this.scheduleReconcile();
    } else {
      this.markQueuedWorkStale();
    }
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
