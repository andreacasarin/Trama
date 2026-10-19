import { Notice, Plugin } from "obsidian";
import { ChatSession } from "@/chat/ChatSession";
import { ManualIndex } from "@/index/ManualIndex";
import { SqliteNoteRecordManager } from "@/index/SqliteNoteRecordManager";
import { embeddingCacheIdentity, SqliteEmbeddingCache } from "@/index/SqliteEmbeddingCache";
import { noteEmbeddingProfile, SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { VaultRetrieval } from "@/index/VaultRetrieval";
import { NoteStoreClient } from "@/index/note-sqlite/client";
import {
  createLocalChatModel,
  createLocalEmbeddings,
  discoverLocalModels,
  EmbeddingProviderError,
} from "@/model/LocalModels";
import { createVaultTools } from "@/tools/VaultTools";
import { NoteSqliteRuntime } from "@/plugin/NoteSqliteRuntime";
import { VaultEmbeddingCache } from "@/plugin/VaultEmbeddingCache";
import { ConsoleDebug } from "@/plugin/ConsoleDebug";
import { loadPluginUi, registerPluginUi } from "@/plugin/PluginUi";
import { EndpointPolicy } from "@/security/EndpointPolicy";
import {
  DEFAULT_SETTINGS,
  normalizeExcludedFolders,
  SettingsStore,
  type TramaSettings,
} from "@/settings/Settings";
import { IndexStatusController } from "@/ui/index/IndexStatus";
import { ObsidianIndexVault } from "@/vault/indexing/ObsidianIndexVault";
import { ObsidianReadonlyVault } from "@/vault/readOnly/ObsidianReadonlyVault";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export class TramaPlugin extends Plugin {
  private readonly settingsStore = new SettingsStore();
  private readonly consoleDebug = new ConsoleDebug(() => this.getSettings().consoleDebug);
  private readonly sqliteRuntime = new NoteSqliteRuntime(() => this.manifest);
  private lifecycle = Promise.resolve();
  private disposed = false;
  private indexedNotes = false;
  private automaticReady = false;
  private automaticPending = false;
  private automaticTimer?: ReturnType<typeof setTimeout>;
  private client?: NoteStoreClient;
  private manualIndex?: ManualIndex;
  private retrieval?: VaultRetrieval;
  private session?: ChatSession;
  private status?: IndexStatusController;
  private indexRun?: {
    readonly manualIndex: ManualIndex;
    readonly excludedFolders: readonly string[];
    readonly label: string;
    promise: Promise<void>;
  };
  private clearRun?: {
    client: NoteStoreClient;
    controller: AbortController;
    promise: Promise<void>;
  };
  private operationNotice?: Notice;
  private activeNote?: string;
  private ui?: Awaited<ReturnType<typeof loadPluginUi>>;
  private settingsTab?: { refreshExternalSettings(): void };
  private readonly catalog = () =>
    (this.app as any).vault
      .getMarkdownFiles()
      .map((file: { path: string }) => file.path)
      .filter((path: string) => this.isVisibleMarkdown(path));

  onload(): Promise<void> {
    return this.enqueue(async () => {
      this.settingsStore.load(await this.loadData().catch(() => undefined));
      if (this.disposed) return;
      const app = this.app as any;
      if (!app?.vault || !app.workspace || !app.metadataCache) return;
      this.status = new IndexStatusController();
      this.activeNote = app.workspace.getActiveFile()?.path;
      this.registerEvent(
        app.workspace.on("file-open", (file: { path?: string } | null) => {
          const next = file?.path && this.isVisibleMarkdown(file.path) ? file.path : undefined;
          if (next !== this.activeNote) {
            this.activeNote = next;
            this.retrieval?.invalidateRelated();
            this.refreshFiloResults(next);
            this.refreshVoceSuggestions();
          }
        })
      );
      try {
        await this.configureServices(app);
        if (this.disposed) return;
        const ui = await loadPluginUi();
        if (this.disposed) return;
        this.ui = ui;
        this.settingsTab = registerPluginUi(this, app, ui, {
          session: () => this.session!,
          status: this.status!,
          retrieval: () => this.retrieval!,
          noteCatalog: this.catalog,
          currentNote: () => (this.activeNote ? [this.activeNote] : []),
          consoleDebug: this.consoleDebug,
        });
        app.workspace.onLayoutReady?.(() => this.startAutomaticIndexing(app));
      } catch (error) {
        this.consoleDebug.error("Plugin initialization failed", error);
        if (!this.disposed)
          new Notice(error instanceof Error ? error.message : "Trama could not start.");
        throw error;
      }
    });
  }

  private async configureServices(app: any): Promise<void> {
    if (this.disposed) return;
    const settings = this.getSettings();
    const wasConfigured = Boolean(this.client);
    const previousRun = this.indexRun;
    const previousClear = this.clearRun;
    const previousClient = this.client;
    this.automaticPending = false;
    this.manualIndex?.cancel();
    previousClear?.controller.abort();
    this.retrieval?.invalidateRelated();
    this.session?.reset();
    this.manualIndex = undefined;
    this.client = undefined;
    if (previousRun) {
      await previousRun.promise;
      this.finishOperationNotice("Index operation stopped because settings changed.");
    }
    if (previousClear) await previousClear.promise;
    await previousClient?.close();
    if (this.disposed) return;
    const namespace = await this.sqliteRuntime.resolveNamespace(app);
    if (this.disposed) return;
    const worker = this.sqliteRuntime.createWorker(app);
    const candidate = new NoteStoreClient(worker, namespace);
    try {
      await candidate.initialize();
    } catch (error) {
      await candidate.close();
      throw error;
    }
    if (this.disposed) {
      await candidate.close();
      return;
    }
    this.client = candidate;
    this.indexedNotes = Boolean(await candidate.call("noteStoreHasNotes", {}));
    const policy = new EndpointPolicy({ approvals: settings.approvedOrigins });
    const profile = {
      endpoint: settings.embedding.endpoint,
      modelId: settings.embedding.modelId,
      dimensions: settings.embedding.dimensions,
    };
    const providerEmbeddings = settings.embedding.modelId
      ? createLocalEmbeddings({ ...profile, policy })
      : undefined;
    const embeddings = providerEmbeddings
      ? new SqliteEmbeddingCache(
          providerEmbeddings,
          candidate.call,
          embeddingCacheIdentity(profile.modelId, profile.dimensions),
          profile.dimensions
        )
      : unavailableEmbeddings();
    const sharedEmbeddingCache = providerEmbeddings
      ? new VaultEmbeddingCache(
          app.vault.adapter,
          embeddings as SqliteEmbeddingCache,
          profile.dimensions,
          this.consoleDebug
        )
      : undefined;
    const readonlyVault = new ObsidianReadonlyVault(app.vault, app.metadataCache);
    const noteVault = new ObsidianIndexVault(app.vault, (path) => this.isIndexableMarkdown(path));
    const store = new SqliteNoteVectorStore(
      embeddings,
      candidate.call,
      async (path) => {
        const note = await readonlyVault.readNote(path, new AbortController().signal);
        return note.content;
      },
      profile
    );
    this.manualIndex = new ManualIndex(
      noteVault,
      store,
      new SqliteNoteRecordManager(candidate.call),
      sharedEmbeddingCache,
      this.consoleDebug
    );
    this.retrieval = new VaultRetrieval(
      candidate.call,
      settings.embedding.modelId ? embeddings : undefined,
      settings.embedding.modelId ? noteEmbeddingProfile(profile) : undefined,
      async (path, signal) => {
        try {
          const note = await readonlyVault.readNote(path, signal ?? new AbortController().signal);
          return { path: note.path, content: note.content };
        } catch {
          return null;
        }
      },
      this.consoleDebug
    );
    const chatModel: BaseChatModel = createLocalChatModel(settings.chat, policy);
    this.session = new ChatSession(
      chatModel,
      (observer) => createVaultTools(readonlyVault, this.retrieval!, observer),
      readonlyVault,
      () => {
        if (!settings.chat.modelId.trim())
          throw new Error("Set a local chat model in Trama settings before sending a message.");
      },
      this.consoleDebug
    );
    if (wasConfigured && this.ui) {
      for (const leaf of app.workspace.getLeavesOfType("trama-voce"))
        leaf.view?.setSession?.(this.session);
      for (const leaf of app.workspace.getLeavesOfType("trama-filo"))
        leaf.view?.setRelated?.(this.retrieval);
      for (const leaf of app.workspace.getLeavesOfType("trama-lente"))
        leaf.view?.setSearch?.(this.retrieval.runnable);
    }
    this.refreshVoceSuggestions();
  }

  onunload(): void {
    this.disposed = true;
    this.cancelAutomaticDebounce();
    this.automaticPending = false;
    this.manualIndex?.cancel();
    const activeClear = this.clearRun;
    activeClear?.controller.abort();
    this.operationNotice?.hide();
    this.operationNotice = undefined;
    this.session?.reset();
    const client = this.client;
    if (activeClear) void activeClear.promise.finally(() => client?.close().catch(() => undefined));
    else void client?.close().catch(() => undefined);
    this.manualIndex = undefined;
    this.retrieval = undefined;
    this.session = undefined;
    this.client = undefined;
  }

  getSettings(): TramaSettings {
    return this.settingsStore.get() ?? DEFAULT_SETTINGS;
  }
  get hasIndexedNotes(): boolean {
    return this.indexedNotes;
  }

  get hasIndexedOrActiveIndex(): boolean {
    return this.indexedNotes || Boolean(this.indexRun);
  }
  async saveSettings(
    update: TramaSettings | ((current: TramaSettings) => TramaSettings)
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return;
      const current = this.getSettings();
      const next = typeof update === "function" ? update(current) : update;
      const policy = new EndpointPolicy({ approvals: next.approvedOrigins });
      const validated = {
        ...next,
        chat: { ...next.chat, endpoint: policy.normalize(next.chat.endpoint) },
        embedding: { ...next.embedding, endpoint: policy.normalize(next.embedding.endpoint) },
        excludedFolders: normalizeExcludedFolders(next.excludedFolders),
      };
      const runtimeChanged =
        JSON.stringify(current.chat) !== JSON.stringify(validated.chat) ||
        JSON.stringify(current.embedding) !== JSON.stringify(validated.embedding) ||
        JSON.stringify(current.approvedOrigins) !== JSON.stringify(validated.approvedOrigins);
      const staged = this.settingsStore.stage(validated);
      await this.saveData(staged);
      if (this.disposed) return;
      this.settingsStore.commit(staged);
      if (runtimeChanged) await this.configureServices(this.app as any);
    }).catch((error) => {
      this.consoleDebug.error("Settings update failed", error);
      throw error;
    });
  }

  async onExternalSettingsChange(): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return;
      const previous = this.getSettings();
      this.settingsStore.load(await this.loadData());
      const current = this.getSettings();
      const previousProfile = effectiveEmbeddingProfile(previous);
      const currentProfile = effectiveEmbeddingProfile(current);
      const embeddingProfileChanged =
        previousProfile !== undefined &&
        currentProfile !== undefined &&
        previousProfile !== currentProfile;
      const runtimeChanged =
        JSON.stringify(previous.chat) !== JSON.stringify(current.chat) ||
        JSON.stringify(previous.embedding) !== JSON.stringify(current.embedding) ||
        JSON.stringify(previous.approvedOrigins) !== JSON.stringify(current.approvedOrigins);
      if (runtimeChanged && this.app) await this.configureServices(this.app as any);
      this.settingsTab?.refreshExternalSettings();
      if (embeddingProfileChanged && this.indexedNotes)
        new Notice(
          "Embedding settings changed from sync. Clear the index and embedding cache, then run Update or Rebuild. No data was deleted."
        );
    }).catch((error) => {
      this.consoleDebug.error("External settings reload failed", error);
      throw error;
    });
  }

  updateIndex(): Promise<void> {
    return this.runIndex(false);
  }
  rebuildIndex(): Promise<void> {
    return this.runIndex(true);
  }
  stopIndex(): void {
    this.automaticPending = false;
    this.cancelAutomaticDebounce();
    if (this.indexRun) {
      this.operationNotice?.setMessage(`Stopping ${this.indexRun.label.toLowerCase()}…`);
      this.indexRun.manualIndex.cancel();
      return;
    }
    if (this.clearRun) {
      this.operationNotice?.setMessage("Stopping index clear…");
      this.clearRun.controller.abort();
      return;
    }
    new Notice("No index operation is running.");
  }

  clearIndex(): Promise<void> {
    this.automaticPending = false;
    this.cancelAutomaticDebounce();
    if (this.indexRun || this.clearRun) {
      new Notice("An index operation is already running.");
      return Promise.resolve();
    }
    const client = this.client;
    if (!client) {
      new Notice("The local index is unavailable.");
      return Promise.resolve();
    }
    const controller = new AbortController();
    const previousStatus = this.status?.getStatus();
    this.status?.setStatus({
      kind: "building",
      message: "Clearing local index…",
      canIndex: false,
      canReindex: false,
      canCancel: true,
    });
    this.showOperationNotice("Clearing local index…");
    const finishLog = this.consoleDebug.start("Index clear");
    const run = { client, controller, promise: Promise.resolve() };
    this.clearRun = run;
    let committed = false;
    const operation = (async () => {
      try {
        this.retrieval?.cancelSearches();
        for (const leaf of (this.app as any)?.workspace?.getLeavesOfType?.("trama-lente") ?? [])
          leaf.view?.clearResults?.();
        await client.call("noteStoreClear", {}, controller.signal);
        if (this.clearRun !== run || this.disposed) return;
        committed = true;
        this.retrieval?.invalidateRelated();
        this.indexedNotes = false;
        this.status?.setStatus({
          kind: "index-required",
          message: "Local index and local embedding cache cleared.",
          canIndex: false,
          canReindex: false,
          canCancel: true,
        });
        this.refreshVoceSuggestions();
        this.operationNotice?.setMessage("Clearing shared embedding cache files…");
        const adapter = (this.app as any)?.vault?.adapter;
        if (!adapter) throw new Error("Vault storage is unavailable for shared cache cleanup.");
        await VaultEmbeddingCache.clearManagedFiles(adapter, controller.signal);
        if (this.clearRun !== run || this.disposed) return;
        finishLog("completed");
        this.status?.setStatus({
          kind: "index-required",
          message: "Local index and embedding cache cleared.",
          canIndex: true,
          canReindex: true,
          canCancel: false,
        });
        this.finishOperationNotice("Local index and embedding cache cleared.");
      } catch (error: unknown) {
        if (this.clearRun !== run || this.disposed) return;
        const cancelled = error instanceof DOMException && error.name === "AbortError";
        if (committed) {
          this.status?.setStatus({
            kind: "index-required",
            message:
              "Local index and SQLite cache cleared; shared cache cleanup is incomplete. Retry Clear to finish.",
            canIndex: false,
            canReindex: false,
            canCancel: false,
          });
        } else if (previousStatus) {
          this.status?.setStatus(previousStatus);
        }
        finishLog(
          committed
            ? cancelled
              ? "cancelled-after-local-clear"
              : "shared-cache-cleanup-failed"
            : cancelled
              ? "cancelled"
              : "failed",
          undefined,
          cancelled ? undefined : error,
          cancelled ? "info" : "error"
        );
        const message = cancelled
          ? committed
            ? "Local index and SQLite cache cleared; shared cache cleanup stopped. Retry Clear to finish."
            : "Index clear stopped."
          : committed
            ? `Local index and SQLite cache cleared; shared cache cleanup is incomplete. Retry Clear to finish. ${error instanceof Error ? error.message : "Could not remove shared cache files."}`
            : error instanceof Error
              ? error.message
              : "Could not clear the local index.";
        this.finishOperationNotice(message);
      }
    })().finally(() => {
      if (this.clearRun === run) this.clearRun = undefined;
      this.automaticPending = false;
    });
    run.promise = operation;
    return operation;
  }

  async relatedNoteSuggestions(signal: AbortSignal): Promise<readonly string[]> {
    const sourcePath = this.activeNote;
    const retrieval = this.retrieval;
    if (!sourcePath || !retrieval) return [];
    const result = await retrieval.relatedPaths(sourcePath, signal, 7);
    if (signal.aborted || this.activeNote !== sourcePath || this.retrieval !== retrieval) return [];
    return [...new Set(result.paths)]
      .filter((path) => path !== sourcePath && this.catalog().includes(path))
      .slice(0, 5);
  }

  discoverModels(
    target: "chat" | "embedding",
    endpoint?: string,
    approvals?: readonly import("@/security/EndpointPolicy").EndpointApproval[]
  ): Promise<readonly string[]> {
    const settings = this.getSettings();
    return discoverLocalModels(
      endpoint ?? settings[target].endpoint,
      new EndpointPolicy({ approvals: approvals ?? settings.approvedOrigins })
    );
  }

  private runIndex(rebuild: boolean, automatic = false): Promise<void> {
    if (this.clearRun) {
      new Notice("The local index is being cleared.");
      return Promise.resolve();
    }
    const manualIndex = this.manualIndex;
    if (!manualIndex) return Promise.reject(new Error("Index is unavailable."));
    if (this.indexRun?.manualIndex === manualIndex) {
      if (automatic) this.automaticPending = true;
      else new Notice("An index operation is already running.");
      return this.indexRun.promise;
    }
    this.automaticPending = false;
    const run = {
      manualIndex,
      excludedFolders: [...this.getSettings().excludedFolders],
      label: rebuild ? "Rebuilding note index" : "Updating note index",
      promise: Promise.resolve(),
    };
    this.indexRun = run;
    const finishLog = this.consoleDebug.start(run.label, { automatic, rebuild });
    if (!automatic)
      this.showOperationNotice(rebuild ? "Rebuilding note index…" : "Updating note index…");
    this.status?.setStatus({
      kind: "building",
      message: rebuild ? "Rebuilding note index…" : "Updating note index…",
      canIndex: false,
      canReindex: false,
      canCancel: true,
    });
    let operation: ReturnType<ManualIndex["update"]>;
    let completed = false;
    try {
      operation = rebuild ? manualIndex.rebuild() : manualIndex.update();
    } catch (error) {
      operation = Promise.reject(error);
    }
    const completion = operation
      .then(async (result) => {
        if (this.indexRun !== run || this.manualIndex !== manualIndex) return;
        this.indexedNotes = Boolean(await this.client?.call("noteStoreHasNotes", {}));
        completed = result.sharing === "complete";
        finishLog(result.sharing === "complete" ? "completed" : result.sharing, {
          visited: result.visited,
          deleted: result.deleted,
          numAdded: result.numAdded,
          numUpdated: result.numUpdated,
          numSkipped: result.numSkipped,
        });
        this.retrieval?.invalidateRelated();
        this.refreshLenteResults();
        this.refreshVoceSuggestions();
        const message =
          result.sharing === "incomplete"
            ? "Index updated; sharing incomplete."
            : result.sharing === "cancelled"
              ? "Index updated; sharing cancelled."
              : `Indexed ${result.visited} notes.`;
        this.status?.setStatus({
          kind: "ready",
          message,
          canIndex: true,
          canReindex: true,
          canCancel: false,
        });
        if (!automatic) this.finishOperationNotice(message);
      })
      .catch((error) => {
        if (this.indexRun !== run || this.manualIndex !== manualIndex) return;
        const cancelled = isCancelled(error);
        finishLog(
          cancelled ? "cancelled" : "failed",
          undefined,
          cancelled ? undefined : error,
          cancelled ? "info" : "error"
        );
        this.retrieval?.invalidateRelated();
        this.refreshVoceSuggestions();
        this.status?.setStatus({
          kind: cancelled ? "ready" : "error",
          message: cancelled
            ? "Indexing stopped."
            : error instanceof Error
              ? error.message
              : "Indexing failed.",
          canIndex: true,
          canReindex: true,
          canCancel: false,
        });
        if (!automatic)
          this.finishOperationNotice(
            cancelled
              ? "Indexing stopped."
              : error instanceof Error
                ? error.message
                : "Indexing failed."
          );
      })
      .finally(() => {
        if (this.indexRun === run) this.indexRun = undefined;
        if (completed && this.automaticPending) {
          this.automaticPending = false;
          if (this.indexedNotes && !this.disposed) void this.runIndex(false, true);
        } else this.automaticPending = false;
      });
    run.promise = completion;
    return completion;
  }

  private startAutomaticIndexing(app: any): void {
    if (this.disposed || this.automaticReady) return;
    this.automaticReady = true;
    const schedule = (vaultEvent = false) => {
      if (
        this.disposed ||
        !this.automaticReady ||
        !this.client ||
        !this.manualIndex ||
        !this.getSettings().embedding.modelId.trim()
      )
        return;
      if (this.indexRun || this.clearRun) {
        if (vaultEvent) this.automaticPending = true;
        return;
      }
      if (!this.indexedNotes) return;
      void this.runIndex(false, true);
    };
    const changed = (file: any) => {
      if (this.isVisibleMarkdown(file?.path)) this.debounceAutomaticIndex(() => schedule(true));
    };
    for (const event of ["create", "modify", "delete"])
      this.registerEvent(app.vault.on(event, changed));
    this.registerEvent(
      app.vault.on("rename", (file: any, oldPath: string) => {
        if (this.isVisibleMarkdown(file?.path) || this.isVisibleMarkdown(oldPath))
          this.debounceAutomaticIndex(() => schedule(true));
      })
    );
    this.registerInterval(window.setInterval(schedule, 300_000));
    schedule();
  }

  private debounceAutomaticIndex(schedule: () => void): void {
    if (this.disposed) return;
    if (this.automaticTimer) clearTimeout(this.automaticTimer);
    this.automaticTimer = setTimeout(() => {
      this.automaticTimer = undefined;
      schedule();
    }, 20_000);
  }

  private cancelAutomaticDebounce(): void {
    if (this.automaticTimer) clearTimeout(this.automaticTimer);
    this.automaticTimer = undefined;
  }

  private refreshVoceSuggestions(): void {
    for (const leaf of (this.app as any)?.workspace?.getLeavesOfType?.("trama-voce") ?? [])
      void leaf.view?.refreshSuggestions?.();
  }

  private refreshFiloResults(path: string | undefined): void {
    for (const leaf of (this.app as any)?.workspace?.getLeavesOfType?.("trama-filo") ?? [])
      leaf.view?.refreshActiveNote?.(path);
  }

  private refreshLenteResults(): void {
    for (const leaf of (this.app as any)?.workspace?.getLeavesOfType?.("trama-lente") ?? [])
      leaf.view?.refreshSubmitted?.();
  }

  private showOperationNotice(message: string): void {
    this.operationNotice?.hide();
    this.operationNotice = new Notice(message, 0);
  }

  private finishOperationNotice(message: string): void {
    if (this.disposed) return;
    const notice = this.operationNotice;
    this.operationNotice = undefined;
    if (!notice) return;
    notice.hide();
    new Notice(message);
  }

  private isVisibleMarkdown(path: string): boolean {
    return (
      typeof path === "string" &&
      path.toLowerCase().endsWith(".md") &&
      !path.split("/").some((part) => part.startsWith("."))
    );
  }

  private isIndexableMarkdown(path: string): boolean {
    return (
      this.isVisibleMarkdown(path) &&
      !(this.indexRun?.excludedFolders ?? this.getSettings().excludedFolders).some((folder) =>
        path.startsWith(`${folder}/`)
      )
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function effectiveEmbeddingProfile(settings: TramaSettings): string | undefined {
  if (!settings.embedding.modelId.trim()) return undefined;
  try {
    const endpoint = new EndpointPolicy({ approvals: settings.approvedOrigins }).normalize(
      settings.embedding.endpoint
    );
    return noteEmbeddingProfile({ ...settings.embedding, endpoint });
  } catch {
    return undefined;
  }
}

function unavailableEmbeddings(): EmbeddingsInterface<number[]> & {} {
  const fail = async (): Promise<never> => {
    throw new EmbeddingProviderError(
      "Configure a local embedding model to build semantic vectors."
    );
  };
  return { embedDocuments: fail, embedQuery: fail };
}

function isCancelled(error: unknown): boolean {
  return Boolean(
    (error instanceof DOMException && error.name === "AbortError") ||
    (error && typeof error === "object" && "code" in error && error.code === "cancelled")
  );
}
