import type { TramaDiagnostics } from "@/diagnostics/TramaDiagnostics";
import { diagnosticTimer, emitTramaDiagnostic } from "@/diagnostics/TramaDiagnostics";
import { IndexManager, type IndexVaultPort } from "@/index/IndexManager";
import { MaintenanceScheduler, type MaintenanceSnapshot } from "@/index/MaintenanceScheduler";
import {
  PublicationManager,
  type AdoptionResult,
  type PublicationWarning,
} from "@/index/publications/PublicationManager";
import { PublicationStore } from "@/index/publications/PublicationStore";
import type { SqliteWorkerClient, SqliteWorkerLike } from "@/index/sqlite/client";
import { RelatedNotes } from "@/index/RelatedNotes";
import type { ModelRuntime } from "@/plugin/ModelRuntime";
import { LmStudioEmbeddingModel } from "@/providers/lmStudio/LmStudioEmbeddingModel";
import { LmStudioTransport } from "@/providers/lmStudio/LmStudioTransport";
import { EndpointPolicy } from "@/security/EndpointPolicy";
import { isExcludedPath, type TramaSettings } from "@/settings/Settings";
import {
  DiscoverLinksTool,
  FollowLinkTool,
  ReadNoteTool,
  ToolRegistry,
  VaultSearchTool,
} from "@/tools/ToolRegistry";
import type { IndexStatusController } from "@/ui/index/IndexStatus";
import { ObsidianIndexVault } from "@/vault/indexing/ObsidianIndexVault";
import { ObsidianReadonlyVault } from "@/vault/readOnly/ObsidianReadonlyVault";

interface RuntimeCompositionHost {
  readonly diagnostics: TramaDiagnostics;
  readonly modelRuntime: ModelRuntime;
  isVisibleMarkdown(path: string): boolean;
  createWorker(app: any): SqliteWorkerLike;
  resolveIdentity(adapter: any): Promise<string>;
  createClient(storage: object): SqliteWorkerClient | undefined;
  isCurrent(manager: IndexManager): boolean;
  getIndexStatus(): IndexStatusController | undefined;
  isAutomaticMaintenanceEnabled(): boolean;
  onComposed(runtime: Omit<ComposedRuntime, "load">): void;
  onIndexOperation(manager: IndexManager, changed: boolean): void;
  onMaintenanceSnapshot(manager: IndexManager, snapshot: MaintenanceSnapshot): void;
  onPublicationWarning(
    manager: IndexManager,
    warning: PublicationWarning,
    origin: "publication" | "check"
  ): void;
  onPublicationMetrics(manager: IndexManager): void;
  onPublicationSuccess(manager: IndexManager): void;
  onAdoptionResult(manager: IndexManager, result: AdoptionResult): void;
  onInitialState(manager: IndexManager, loaded: boolean): void;
  onLoadSettled(manager: IndexManager, loaded: boolean, app: any): void;
}

export interface ComposedRuntime {
  readonly manager: IndexManager;
  readonly publication: PublicationManager;
  readonly scheduler: MaintenanceScheduler;
  readonly relatedNotes: RelatedNotes;
  readonly embedding: LmStudioEmbeddingModel;
  readonly load: Promise<boolean>;
}

export function composeRuntime(
  host: RuntimeCompositionHost,
  app: any,
  settings: TramaSettings
): ComposedRuntime {
  const transport = new LmStudioTransport({
    policy: new EndpointPolicy({ approvals: settings.approvedOrigins }),
  });
  const readonlyVault = new ObsidianReadonlyVault(app.vault, app.workspace, app.metadataCache);
  const excludedPaths = [...settings.filo.excludedPaths];
  const isIndexEligible = (path: string) =>
    host.isVisibleMarkdown(path) &&
    !isExcludedPath(path, [...excludedPaths, settings.publicationDirectory]);
  const indexVault: IndexVaultPort = new ObsidianIndexVault(app.vault, {
    isBaseVisible: (path) => host.isVisibleMarkdown(path),
    isIndexEligible,
  });
  const embedding = new LmStudioEmbeddingModel({ ...settings.embedding, transport });
  const manager = new IndexManager(
    indexVault,
    embedding,
    settings.embedding.endpoint,
    settings.embedding.modelId,
    {
      excludedPaths,
      publicationDirectory: settings.publicationDirectory,
      isIndexEligible,
      workerFactory: () => host.createWorker(app),
      sqliteIdentity: host.resolveIdentity(app.vault.adapter),
      sqliteClient: host.createClient(app.vault),
      onProgress: (progress) => host.getIndexStatus()?.reportProgress(progress),
    },
    host.diagnostics
  );

  let warningOrigin: "publication" | "check" = "publication";
  const publication = new PublicationManager(
    manager,
    new PublicationStore(app.vault.adapter, { directory: settings.publicationDirectory }),
    {
      onWarning: (warning) => host.onPublicationWarning(manager, warning, warningOrigin),
      onMetrics: () => host.onPublicationMetrics(manager),
    }
  );

  const scheduler = new MaintenanceScheduler(
    {
      semanticConfigured: settings.embedding.modelId.trim().length > 0,
      synchronize: async (signal) => {
        const result = await manager.reconcileQueuedChanges(signal);
        host.onIndexOperation(manager, result.changed);
        return result;
      },
      rebuild: async (signal) => {
        const revision = manager.journalSnapshot().revision;
        const result = await manager.build(signal);
        if (result.converged) manager.clearJournalIfCurrent(revision);
        host.onIndexOperation(manager, result.changed);
        return result;
      },
      prepareSemantic: async (signal, shouldYield) => {
        const result = await manager.prepareSemantic(signal, shouldYield);
        host.onIndexOperation(manager, result.changed);
        return result;
      },
      rebuildSemantic: async (signal, shouldYield) => {
        const result = await manager.rebuildSemantic(signal, shouldYield);
        host.onIndexOperation(manager, result.changed);
        return result;
      },
      publish: async () => {
        warningOrigin = "publication";
        const elapsed = diagnosticTimer(host.diagnostics, "performance");
        try {
          const result = await publication.publish();
          if (result.published && !result.warning) host.onPublicationSuccess(manager);
          return result;
        } finally {
          if (elapsed)
            emitTramaDiagnostic(host.diagnostics, {
              tier: "performance",
              facets: ["index", "publication"],
              area: "index",
              event: "phase",
              operation: "publication",
              phase: "overall",
              durationMs: elapsed(),
            });
        }
      },
      adoptCurrent: async (shouldYield) => {
        warningOrigin = "check";
        try {
          const elapsed = diagnosticTimer(host.diagnostics, "performance");
          let result: AdoptionResult;
          try {
            result = await publication.adoptCurrent(shouldYield);
          } finally {
            if (elapsed)
              emitTramaDiagnostic(host.diagnostics, {
                tier: "performance",
                facets: ["index", "adoption"],
                area: "index",
                event: "phase",
                operation: "adoption",
                phase: "overall",
                durationMs: elapsed(),
              });
          }
          if (!shouldYield?.()) {
            const cached = await manager.promoteCachedSemantic(new AbortController().signal);
            host.onIndexOperation(manager, cached.changed);
          }
          return result;
        } finally {
          warningOrigin = "publication";
        }
      },
    },
    {
      onChange: (snapshot) => host.onMaintenanceSnapshot(manager, snapshot),
    }
  );

  const relatedNotes = new RelatedNotes(manager, host.diagnostics);
  host.onComposed({ manager, publication, scheduler, relatedNotes, embedding });
  scheduler.setAutomaticEnabled(settings.automaticMaintenance);
  host.modelRuntime.lenteSearch = host.modelRuntime.createLenteSearch(manager, app, settings);
  const registry = new ToolRegistry([
    new ReadNoteTool(readonlyVault),
    new DiscoverLinksTool(readonlyVault),
    new FollowLinkTool(readonlyVault),
    new VaultSearchTool(manager),
  ]);
  host.modelRuntime.composeChatSession(app, settings, readonlyVault, registry, transport);

  const load = manager
    .load({ emitDiagnostics: false })
    .then(async (loaded) => {
      if (!host.isCurrent(manager)) return loaded;
      host.onInitialState(manager, loaded);
      const usable = loaded && manager.capabilities().availability !== "unavailable";
      if (usable && host.isCurrent(manager)) {
        // Local SQLite lexical state is ready before synchronized cache ingestion
        // starts. Shards add vectors but never replace local note heads or FTS.
        void scheduler.checkPublication().then((result) => {
          if (host.isCurrent(manager)) host.onAdoptionResult(manager, result);
          if (
            settings.automaticMaintenance &&
            host.isCurrent(manager) &&
            manager.hasPendingSemanticWork()
          )
            scheduler.invalidate(false);
          if (
            host.isAutomaticMaintenanceEnabled() &&
            host.isCurrent(manager) &&
            !scheduler.snapshot.pending &&
            !scheduler.snapshot.suspended &&
            !result.adopted &&
            !result.replacementRequired
          ) {
            manager.requestFullRecovery();
            scheduler.invalidate(result.ignored === "missing");
          }
        });
      }
      return loaded;
    })
    .catch(() => false);
  void load.then((loaded) => host.onLoadSettled(manager, loaded, app));
  return { manager, publication, scheduler, relatedNotes, embedding, load };
}
