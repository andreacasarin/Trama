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
import { loadPluginUi, registerPluginUi } from "@/plugin/PluginUi";
import { EndpointPolicy } from "@/security/EndpointPolicy";
import { DEFAULT_SETTINGS, SettingsStore, type TramaSettings } from "@/settings/Settings";
import { IndexStatusController } from "@/ui/index/IndexStatus";
import { ObsidianIndexVault } from "@/vault/indexing/ObsidianIndexVault";
import { ObsidianReadonlyVault } from "@/vault/readOnly/ObsidianReadonlyVault";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export class TramaPlugin extends Plugin {
  private readonly settingsStore = new SettingsStore();
  private readonly sqliteRuntime = new NoteSqliteRuntime(() => this.manifest);
  private lifecycle = Promise.resolve();
  private disposed = false;
  private client?: NoteStoreClient;
  private manualIndex?: ManualIndex;
  private retrieval?: VaultRetrieval;
  private session?: ChatSession;
  private status?: IndexStatusController;
  private indexRun?: { readonly manualIndex: ManualIndex; promise: Promise<void> };
  private activeNote?: string;
  private ui?: Awaited<ReturnType<typeof loadPluginUi>>;
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
          this.activeNote = file?.path && this.isVisibleMarkdown(file.path) ? file.path : undefined;
        })
      );
      try {
        await this.configureServices(app);
        if (this.disposed) return;
        const ui = await loadPluginUi();
        if (this.disposed) return;
        this.ui = ui;
        registerPluginUi(this, app, ui, {
          session: this.session!,
          status: this.status!,
          retrieval: this.retrieval!,
          noteCatalog: this.catalog,
          currentNote: () => (this.activeNote ? [this.activeNote] : []),
        });
      } catch (error) {
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
    const previousClient = this.client;
    this.manualIndex?.cancel();
    this.session?.reset();
    this.manualIndex = undefined;
    this.client = undefined;
    if (previousRun) await previousRun.promise;
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
          profile.dimensions
        )
      : undefined;
    const readonlyVault = new ObsidianReadonlyVault(app.vault, app.metadataCache);
    const noteVault = new ObsidianIndexVault(app.vault, (path) => this.isVisibleMarkdown(path));
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
      sharedEmbeddingCache
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
      }
    );
    const chatModel: BaseChatModel = createLocalChatModel(settings.chat, policy);
    this.session = new ChatSession(
      chatModel,
      (observer) => createVaultTools(readonlyVault, this.retrieval!, observer),
      readonlyVault,
      () => {
        if (!settings.chat.modelId.trim())
          throw new Error("Set a local chat model in Trama settings before sending a message.");
      }
    );
    if (wasConfigured && this.ui) {
      for (const leaf of app.workspace.getLeavesOfType("trama-voce"))
        leaf.view?.setSession?.(this.session);
      for (const leaf of app.workspace.getLeavesOfType("trama-filo"))
        leaf.view?.setRelated?.(this.retrieval);
      for (const leaf of app.workspace.getLeavesOfType("trama-lente"))
        leaf.view?.setSearch?.(this.retrieval.runnable);
    }
  }

  onunload(): void {
    this.disposed = true;
    this.manualIndex?.cancel();
    this.session?.reset();
    void this.client?.close().catch(() => undefined);
    this.manualIndex = undefined;
    this.retrieval = undefined;
    this.session = undefined;
    this.client = undefined;
  }

  getSettings(): TramaSettings {
    return this.settingsStore.get() ?? DEFAULT_SETTINGS;
  }
  async saveSettings(
    update: TramaSettings | ((current: TramaSettings) => TramaSettings)
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return;
      const next = typeof update === "function" ? update(this.getSettings()) : update;
      const policy = new EndpointPolicy({ approvals: next.approvedOrigins });
      const validated = {
        ...next,
        chat: { ...next.chat, endpoint: policy.normalize(next.chat.endpoint) },
        embedding: { ...next.embedding, endpoint: policy.normalize(next.embedding.endpoint) },
      };
      const staged = this.settingsStore.stage(validated);
      await this.saveData(staged);
      if (this.disposed) return;
      this.settingsStore.commit(staged);
      await this.configureServices(this.app as any);
    });
  }

  updateIndex(): Promise<void> {
    return this.runIndex(false);
  }
  rebuildIndex(): Promise<void> {
    return this.runIndex(true);
  }
  stopIndex(): void {
    this.manualIndex?.cancel();
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

  private runIndex(rebuild: boolean): Promise<void> {
    const manualIndex = this.manualIndex;
    if (!manualIndex) return Promise.reject(new Error("Index is unavailable."));
    if (this.indexRun?.manualIndex === manualIndex) return this.indexRun.promise;
    const run: { readonly manualIndex: ManualIndex; promise: Promise<void> } = {
      manualIndex,
      promise: Promise.resolve(),
    };
    this.status?.setStatus({
      kind: "building",
      message: rebuild ? "Rebuilding note index…" : "Updating note index…",
      canIndex: false,
      canReindex: false,
      canCancel: true,
    });
    run.promise = (rebuild ? manualIndex.rebuild() : manualIndex.update())
      .then((result) => {
        if (this.indexRun !== run || this.manualIndex !== manualIndex) return;
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
      })
      .catch((error) => {
        if (this.indexRun !== run || this.manualIndex !== manualIndex) return;
        const cancelled = error instanceof DOMException && error.name === "AbortError";
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
        if (!cancelled) new Notice(error instanceof Error ? error.message : "Indexing failed.");
      })
      .finally(() => {
        if (this.indexRun === run) this.indexRun = undefined;
      });
    this.indexRun = run;
    return run.promise;
  }

  private isVisibleMarkdown(path: string): boolean {
    return (
      typeof path === "string" &&
      path.toLowerCase().endsWith(".md") &&
      !path.split("/").some((part) => part.startsWith("."))
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

function unavailableEmbeddings(): EmbeddingsInterface<number[]> & {} {
  const fail = async (): Promise<never> => {
    throw new EmbeddingProviderError(
      "Configure a local embedding model to build semantic vectors."
    );
  };
  return { embedDocuments: fail, embedQuery: fail };
}
