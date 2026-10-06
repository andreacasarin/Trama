import { ChatSession } from "@/chat/ChatSession";
import type { TramaDiagnostics } from "@/diagnostics/TramaDiagnostics";
import type { IndexManager } from "@/index/IndexManager";
import { LenteSearch, type LenteBatch, type LenteSearchOptions } from "@/index/LenteSearch";
import type { RelatedNotes } from "@/index/RelatedNotes";
import { LmStudioChatModel } from "@/providers/lmStudio/LmStudioChatModel";
import { LmStudioTransport } from "@/providers/lmStudio/LmStudioTransport";
import { EndpointPolicy } from "@/security/EndpointPolicy";
import type { TramaSettings } from "@/settings/Settings";
import {
  DiscoverLinksTool,
  FollowLinkTool,
  ReadNoteTool,
  ToolRegistry,
  VaultSearchTool,
} from "@/tools/ToolRegistry";
import type { IndexStatusController } from "@/ui/index/IndexStatus";
import { ObsidianLenteNoteStats } from "@/vault/readOnly/ObsidianLenteNoteStats";
import { ObsidianReadonlyVault } from "@/vault/readOnly/ObsidianReadonlyVault";

export interface LenteSearchPort {
  search(query: string, options?: LenteSearchOptions): Promise<LenteBatch>;
}

interface ModelRuntimeHost {
  readonly diagnostics: TramaDiagnostics;
  getSettings(): TramaSettings;
  getIndex(): IndexManager | undefined;
  getIndexStatus(): IndexStatusController | undefined;
  getRelatedNotes(): RelatedNotes | undefined;
}

export class ModelRuntime {
  session?: ChatSession;
  chatModel?: LmStudioChatModel;
  lenteSearch?: LenteSearchPort;

  constructor(private readonly host: ModelRuntimeHost) {}

  createLenteSearch(manager: IndexManager, app: any, settings: TramaSettings): LenteSearchPort {
    const search = new LenteSearch(
      manager,
      new ObsidianLenteNoteStats(app.vault),
      this.host.diagnostics
    );
    return {
      search: (query, options = {}) =>
        search.search(query, {
          ...options,
          searchMethod: settings.lente.searchMethod,
        }),
    };
  }

  replaceLenteSearch(app: any, refreshSubmitted = true): void {
    const manager = this.host.getIndex();
    if (!manager || !app?.vault) return;
    this.lenteSearch = this.createLenteSearch(manager, app, this.host.getSettings());
    this.composeLenteViews(app);
    if (refreshSubmitted) this.refreshOpenLente(app);
  }

  replaceChatModel(settings: TramaSettings): void {
    const model = new LmStudioChatModel({
      ...settings.chat,
      transport: new LmStudioTransport({
        policy: new EndpointPolicy({ approvals: settings.approvedOrigins }),
      }),
      diagnostics: this.host.diagnostics,
    });
    this.chatModel = model;
    this.session?.replaceModel(model);
  }

  async refreshOpenFilo(app: any): Promise<void> {
    const leaves = app?.workspace?.getLeavesOfType?.("trama-filo") ?? [];
    await Promise.allSettled(
      leaves.map(async (leaf: { view?: { refreshRelatedSuggestions?: () => Promise<void> } }) => {
        await leaf.view?.refreshRelatedSuggestions?.();
      })
    );
  }

  refreshOpenRelatedSuggestions(app: any): void {
    if (!app?.workspace) return;
    for (const leaf of app.workspace.getLeavesOfType?.("trama-voce") ?? []) {
      const view = (leaf as { view?: { refreshRelatedSuggestions?: () => void } }).view;
      view?.refreshRelatedSuggestions?.();
    }
  }

  refreshOpenLente(app: any): void {
    if (!app?.workspace) return;
    for (const leaf of app.workspace.getLeavesOfType?.("trama-lente") ?? []) {
      const view = (leaf as { view?: { refreshSubmitted?: () => void } }).view;
      view?.refreshSubmitted?.();
    }
  }

  composeChatSession(
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
        new VaultSearchTool(this.host.getIndex()!),
      ]);
    this.chatModel = new LmStudioChatModel({
      ...settings.chat,
      transport,
      diagnostics: this.host.diagnostics,
    });
    this.session = new ChatSession(this.chatModel, registry, readonlyVault, this.host.diagnostics);
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
      view?.setRelatedNotes?.(this.host.getRelatedNotes());
    }
    for (const leaf of app.workspace.getLeavesOfType?.("trama-filo") ?? []) {
      const view = (leaf as { view?: { setDependencies?: (status: any, related: any) => void } })
        .view;
      view?.setDependencies?.(this.host.getIndexStatus(), this.host.getRelatedNotes());
    }
    this.composeLenteViews(app);
  }

  composeLenteViews(app: any): void {
    for (const leaf of app.workspace.getLeavesOfType?.("trama-lente") ?? []) {
      const view = (leaf as { view?: { setSearch?: (search: LenteSearchPort) => void } }).view;
      if (this.lenteSearch) view?.setSearch?.(this.lenteSearch);
    }
  }
}
