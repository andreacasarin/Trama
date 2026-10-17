import type { Plugin } from "obsidian";
import type { ChatSession } from "@/chat/ChatSession";
import type { VaultRetrieval } from "@/index/VaultRetrieval";
import type { IndexStatusController } from "@/ui/index/IndexStatus";
import type { TramaPlugin } from "@/plugin/TramaPlugin";
import { TRAMA_ICONS } from "@/ui/icons";
import { LenteSearchModal } from "@/ui/lente/LenteSearchModal";
import { NOTE_RESULT_HOVER_SOURCE_ID } from "@/ui/noteResultRow";

export async function loadPluginUi() {
  const [voce, filo, lente, settings] = await Promise.all([
    import("@/ui/voce/VoceView"),
    import("@/ui/filo/FiloView"),
    import("@/ui/lente/LenteView"),
    import("@/ui/settings/SettingsTab"),
  ]);
  return { ...voce, ...filo, ...lente, ...settings };
}

export interface PluginUiDependencies {
  readonly session: ChatSession;
  readonly status: IndexStatusController;
  readonly retrieval: VaultRetrieval;
  readonly noteCatalog: () => readonly string[];
  readonly currentNote: () => readonly string[];
}

export function registerPluginUi(
  plugin: Plugin & TramaPlugin,
  app: any,
  ui: Awaited<ReturnType<typeof loadPluginUi>>,
  dependencies: PluginUiDependencies
): InstanceType<typeof ui.TramaSettingsTab> {
  plugin.registerHoverLinkSource(NOTE_RESULT_HOVER_SOURCE_ID, {
    display: "Trama results",
    defaultMod: false,
  });
  const settingsTab = new ui.TramaSettingsTab(app, plugin);
  plugin.addSettingTab(settingsTab);
  plugin.registerView(
    ui.VOCE_VIEW_TYPE,
    (leaf) =>
      new ui.VoceView(
        leaf,
        dependencies.session,
        dependencies.noteCatalog,
        dependencies.currentNote,
        undefined,
        (signal) => plugin.relatedNoteSuggestions(signal)
      )
  );
  plugin.registerView(
    ui.FILO_VIEW_TYPE,
    (leaf) => new ui.FiloView(leaf, dependencies.status, dependencies.retrieval)
  );
  plugin.registerView(
    ui.LENTE_VIEW_TYPE,
    (leaf) => new ui.LenteView(leaf, dependencies.retrieval.runnable)
  );
  for (const [id, name, icon, type] of [
    ["open-voce", "Open Voce", TRAMA_ICONS.voce, ui.VOCE_VIEW_TYPE],
    ["open-filo", "Open Filo", TRAMA_ICONS.filo, ui.FILO_VIEW_TYPE],
    ["open-lente", "Open Lente", TRAMA_ICONS.lente, ui.LENTE_VIEW_TYPE],
  ] as const)
    plugin.addCommand({
      id,
      name,
      icon,
      callback: () => void app.workspace.getLeaf(true).setViewState({ type, active: true }),
    });
  plugin.addCommand({
    id: "search-with-lente",
    name: "Search with Lente",
    icon: TRAMA_ICONS.lente,
    callback: () => new LenteSearchModal(app, dependencies.retrieval.runnable).open(),
  });
  plugin.addCommand({
    id: "trama-update-index",
    name: "Update note index",
    callback: () => void plugin.updateIndex(),
  });
  plugin.addCommand({
    id: "trama-rebuild-index",
    name: "Rebuild note index",
    callback: () => void plugin.rebuildIndex(),
  });
  plugin.addCommand({
    id: "trama-stop-indexing",
    name: "Stop index operation",
    callback: () => plugin.stopIndex(),
  });
  plugin.addCommand({
    id: "trama-clear-index",
    name: "Clear local index",
    callback: () => void plugin.clearIndex(),
  });
  return settingsTab;
}
