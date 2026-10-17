import { Keymap, SuggestModal, type App } from "obsidian";
import type { VaultRetrievalOutput } from "@/index/VaultRetrieval";
import { appendNoteEditDate } from "@/ui/noteEditDate";
import type { SearchRunnable } from "./LenteView";
import type { ConsoleDebug } from "@/plugin/ConsoleDebug";

interface NoteResult {
  readonly path: string;
  readonly title: string;
}
export class LenteSearchModal extends SuggestModal<NoteResult> {
  private controller?: AbortController;
  private revision = 0;
  private opened = false;
  constructor(
    app: App,
    private readonly search: SearchRunnable,
    private readonly consoleDebug?: ConsoleDebug
  ) {
    super(app);
    this.setPlaceholder("Search your vault");
  }
  override async getSuggestions(query: string): Promise<NoteResult[]> {
    const revision = ++this.revision;
    this.controller?.abort();
    this.controller = undefined;
    const trimmed = query.trim();
    if (!trimmed) {
      this.emptyStateText = "";
      return [];
    }

    const controller = new AbortController();
    this.controller = controller;
    this.emptyStateText = "Searching…";
    try {
      const result = await this.search.invoke(
        { query: trimmed, mode: "hybrid" },
        { signal: controller.signal }
      );
      if (!this.isCurrent(revision, controller, trimmed)) return [];
      const suggestions = result.documents.flatMap((document) => {
        const path = String(document.metadata.path ?? document.id ?? "");
        return path ? [{ path, title: path.split("/").pop()?.replace(/\.md$/i, "") ?? path }] : [];
      });
      this.emptyStateText = this.describe(result);
      this.controller = undefined;
      return suggestions;
    } catch (error) {
      if (!this.isCurrent(revision, controller, trimmed)) return [];
      this.consoleDebug?.error("Lente modal search failed", error);
      this.emptyStateText = "Search failed.";
      this.controller = undefined;
      return [];
    }
  }
  override renderSuggestion(result: NoteResult, el: HTMLElement): void {
    el.empty();
    el.classList.add("trama-lente-search-modal__result");
    el.createDiv({ cls: "suggestion-title trama-lente-search-modal__title", text: result.title });
    el.createDiv({ cls: "suggestion-note trama-lente-search-modal__path", text: result.path });
    appendNoteEditDate(el, this.app, result.path);
  }
  override onChooseSuggestion(result: NoteResult, event: MouseEvent | KeyboardEvent): void {
    void (this.app as App).workspace.openLinkText(result.path, "", Keymap.isModEvent(event));
  }
  override onOpen(): void {
    super.onOpen();
    this.opened = true;
    this.inputEl.focus();
  }
  override onClose(): void {
    this.opened = false;
    this.cancel();
    super.onClose();
  }
  private cancel(): void {
    this.revision++;
    this.controller?.abort();
    this.controller = undefined;
  }
  private isCurrent(revision: number, controller: AbortController, query: string): boolean {
    return (
      this.opened &&
      revision === this.revision &&
      !controller.signal.aborted &&
      this.inputEl.value.trim() === query
    );
  }
  private describe(output: VaultRetrievalOutput): string {
    if (!output.documents.length) return "No matching notes found.";
    return output.status.degraded
      ? "Results use lexical search because semantic search degraded."
      : `${output.documents.length} notes`;
  }
}
