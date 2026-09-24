import type { Plugin } from "obsidian";
import type { RelatedNotes } from "@/index/RelatedNotes";
import type { LenteSearchPort } from "@/plugin/ModelRuntime";
import type { TramaSettings } from "@/settings/Settings";
import { TRAMA_ICONS } from "@/ui/icons";
import type { IndexStatusController } from "@/ui/index/IndexStatus";
import { LenteSearchModal } from "@/ui/lente/LenteSearchModal";

export async function loadPluginUi() {
  const [voce, filo, lente, settings] = await Promise.all([
    import("@/ui/voce/VoceView"),
    import("@/ui/filo/FiloView"),
    import("@/ui/lente/LenteView"),
    import("@/ui/settings/SettingsTab"),
  ]);
  return { ...voce, ...filo, ...lente, ...settings };
}

interface PluginUiDependencies {
  readonly session: NonNullable<import("@/chat/ChatSession").ChatSession>;
  readonly status: IndexStatusController;
  readonly relatedNotes?: RelatedNotes;
  readonly visibleMarkdownCatalog: () => readonly string[];
  readonly contextNoteSuggestions: () => readonly string[];
  readonly getLenteSearch: () => LenteSearchPort | undefined;
  readonly getSettings: () => TramaSettings;
  readonly stopMaintenance: () => void;
}

export function registerPluginUi(
  plugin: Plugin & {
    updateIndex(): Promise<void>;
    rebuildIndex(): Promise<void>;
    stopIndex(): Promise<void>;
  },
  app: any,
  ui: Awaited<ReturnType<typeof loadPluginUi>>,
  dependencies: PluginUiDependencies
): void {
  plugin.addSettingTab(new ui.TramaSettingsTab(app, plugin));
  plugin.registerView(
    ui.VOCE_VIEW_TYPE,
    (leaf) =>
      new ui.VoceView(
        leaf,
        dependencies.session,
        dependencies.visibleMarkdownCatalog,
        dependencies.contextNoteSuggestions,
        undefined,
        dependencies.relatedNotes
      )
  );
  plugin.registerView(
    ui.FILO_VIEW_TYPE,
    (leaf) =>
      new ui.FiloView(
        leaf,
        dependencies.status,
        dependencies.relatedNotes,
        (kind) => dependencies.status.run(kind),
        dependencies.stopMaintenance
      )
  );
  plugin.registerView(
    ui.LENTE_VIEW_TYPE,
    (leaf) =>
      new ui.LenteView(
        leaf,
        dependencies.getLenteSearch() ?? {
          search: async () => {
            throw new Error("Lente is not initialized.");
          },
        }
      )
  );
  for (const [id, name, icon, type] of [
    ["open-voce", "Open Voce", TRAMA_ICONS.voce, ui.VOCE_VIEW_TYPE],
    ["open-filo", "Open Filo", TRAMA_ICONS.filo, ui.FILO_VIEW_TYPE],
    ["open-lente", "Open Lente", TRAMA_ICONS.lente, ui.LENTE_VIEW_TYPE],
  ] as const) {
    plugin.addCommand({
      id,
      name,
      icon,
      callback: () => void app.workspace.getLeaf(true).setViewState({ type, active: true }),
    });
  }
  plugin.addCommand({
    id: "search-with-lente",
    name: "Search with Lente",
    icon: TRAMA_ICONS.lente,
    callback: () => {
      const searchSource: LenteSearchPort = {
        search: (query, options = {}) =>
          dependencies.getLenteSearch()?.search(query, options) ??
          Promise.reject({ code: "unavailable", message: "Lente is unavailable." }),
      };
      new LenteSearchModal(
        app,
        searchSource,
        dependencies.getSettings().lente.automaticSearches
      ).open();
    },
  });
}
