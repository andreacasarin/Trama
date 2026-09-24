import type { TramaDiagnostics } from "@/diagnostics/TramaDiagnostics";
import { IndexManager, type IndexVaultPort } from "@/index/IndexManager";
import { PublicationManager } from "@/index/publications/PublicationManager";
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
  getIndexStatus(): IndexStatusController | undefined;
  getVisibleMarkdownCount(): number;
  suppressRebuildPublication(): boolean;
  onComposed(runtime: Omit<ComposedRuntime, "load">): void;
  onSuccessfulOperation(
    manager: IndexManager,
    publication: PublicationManager | undefined,
    result: any
  ): void;
  onPublicationWarning(manager: IndexManager, warning: any): void;
  onPublicationMetrics(manager: IndexManager): void;
  onPublicationSettled(manager: IndexManager): void;
  onPublicationAdopted(
    manager: IndexManager,
    publication: PublicationManager,
    adopted: boolean
  ): void;
  onInitialState(manager: IndexManager, loaded: boolean): void;
  onLoadSettled(manager: IndexManager, loaded: boolean, app: any): void;
}

export interface ComposedRuntime {
  readonly manager: IndexManager;
  readonly publication: PublicationManager;
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
      onSuccessfulOperation: (result) => {
        if (host.suppressRebuildPublication() && result.operation === "rebuild") return;
        host.onSuccessfulOperation(manager, publication, result);
      },
      onProgress: (progress) => host.getIndexStatus()?.reportProgress(progress),
    },
    host.diagnostics
  );
  const publication: PublicationManager = new PublicationManager(
    manager,
    new PublicationStore(app.vault.adapter, { directory: settings.publicationDirectory }),
    {
      onWarning: (warning) => host.onPublicationWarning(manager, warning),
      onMetrics: () => host.onPublicationMetrics(manager),
      onOperationSettled: () => host.onPublicationSettled(manager),
      onEventAdopted: (result): void => {
        host.onPublicationAdopted(manager, publication, result.adopted);
      },
    }
  );
  const relatedNotes = new RelatedNotes(manager, host.diagnostics);
  host.onComposed({ manager, publication, relatedNotes, embedding });
  host.modelRuntime.lenteSearch = host.modelRuntime.createLenteSearch(manager, app, settings);
  const registry = new ToolRegistry([
    new ReadNoteTool(readonlyVault),
    new DiscoverLinksTool(readonlyVault),
    new FollowLinkTool(readonlyVault),
    new VaultSearchTool(manager),
  ]);
  host.modelRuntime.composeChatSession(app, settings, readonlyVault, registry, transport);
  const currentPublication = publication;
  const load = manager
    .load({ emitDiagnostics: false })
    .then(async (loaded) => {
      host.onInitialState(manager, loaded);
      const usable = loaded && manager.capabilities().availability !== "unavailable";
      if (usable) {
        const adoption = await currentPublication.adoptCurrent();
        if (adoption.warning) host.onPublicationWarning(manager, adoption.warning);
        else if (adoption.adopted) host.onPublicationAdopted(manager, currentPublication, true);
      }
      return loaded;
    })
    .catch(() => false);
  void load.then((loaded) => host.onLoadSettled(manager, loaded, app));
  return { manager, publication, relatedNotes, embedding, load };
}
