import { Keymap, SuggestModal, type App, type HoverPopover } from "obsidian";
import type { VaultRetrieval } from "@/index/VaultRetrieval";
import type { NoteStoreHit } from "@/index/note-sqlite/protocol";
import { configureNoteResultHover, appendSimilarityLabel } from "@/ui/noteResultRow";
import type { ConsoleDebug } from "@/plugin/ConsoleDebug";

type EvidenceDisplay = { kind: "passage" | "other"; text: string };

interface NoteResult {
  readonly path: string;
  readonly title: string;
  readonly semanticScore?: number;
  readonly hit: NoteStoreHit;
}
export class LenteSearchModal extends SuggestModal<NoteResult> {
  hoverPopover: HoverPopover | null = null;
  private controller?: AbortController;
  private opened = false;
  private cachedQuery?: string;
  private cachedResults: NoteResult[] = [];
  private queue: Promise<void> = Promise.resolve();
  private evidence = new Map<NoteResult, Promise<EvidenceDisplay>>();
  constructor(
    app: App,
    private readonly source: Pick<VaultRetrieval, "searchCandidates" | "searchEvidence">,
    private readonly consoleDebug?: ConsoleDebug
  ) {
    super(app);
    this.setPlaceholder("Search your vault");
  }
  override getSuggestions(query: string): NoteResult[] {
    const trimmed = query.trim();
    if (trimmed === this.cachedQuery) return this.cachedResults;
    this.cancel();
    if (!trimmed) {
      this.emptyStateText = "";
      return [];
    }
    const controller = new AbortController();
    this.controller = controller;
    this.cachedQuery = trimmed;
    this.emptyStateText = "Searching…";
    void this.loadSuggestions(trimmed, controller);
    return [];
  }
  private async loadSuggestions(query: string, controller: AbortController): Promise<void> {
    try {
      const result = await this.source.searchCandidates(
        { query, mode: "hybrid" },
        controller.signal,
        true
      );
      if (!this.isCurrent(controller, query)) return;
      this.cachedResults = result.hits.flatMap((hit) => {
        const path = hit.path;
        return path && this.app.vault.getFileByPath(path)
          ? [
              {
                path,
                title: path.split("/").pop()?.replace(/\.md$/i, "") ?? path,
                semanticScore: hit.semanticScore,
                hit,
              },
            ]
          : [];
      });
      this.emptyStateText = !this.cachedResults.length
        ? "No matching notes found."
        : result.status.degraded
          ? "Results use lexical search because semantic search degraded."
          : `${this.cachedResults.length} notes`;
    } catch (error) {
      if (!this.isCurrent(controller, query)) return;
      this.consoleDebug?.error("Lente modal search failed", error);
      this.emptyStateText = "Search failed.";
      this.cachedResults = [];
    }
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  }
  override renderSuggestion(result: NoteResult, el: HTMLElement): void {
    el.empty();
    el.classList.add("trama-lente-search-modal__result");
    const heading = el.createDiv({ cls: "trama-lente-search-modal__heading" });
    const title = heading.createDiv({
      cls: "suggestion-title trama-lente-search-modal__title",
      text: result.title,
    });
    configureNoteResultHover(title, this.app, result.path, this);
    appendSimilarityLabel(heading, result.semanticScore, result.hit.lexicalScore);
    if (
      result.hit.evidence?.startOffset === undefined ||
      result.hit.evidence.endOffset === undefined
    )
      return;
    const slot = el.createDiv({
      cls: "trama-lente-search-modal__excerpt",
      text: "Loading passage…",
    });
    const controller = this.controller;
    const query = this.inputEl.value.trim();
    if (!controller) return;
    let promise = this.evidence.get(result);
    if (!promise) {
      promise = this.queue.then(async () => {
        if (!this.isCurrent(controller, query)) return { kind: "other" as const, text: "" };
        try {
          const evidence = await this.source.searchEvidence(result.hit, controller.signal);
          if (evidence.kind === "changed")
            return {
              kind: "other" as const,
              text: "Note changed. Search again for an updated passage.",
            };
          if (evidence.kind === "unavailable")
            return { kind: "other" as const, text: "Passage unavailable. Open note." };
          return { kind: "passage" as const, text: evidence.text };
        } catch {
          return { kind: "other" as const, text: "Passage unavailable. Open note." };
        }
      });
      this.evidence.set(result, promise);
      this.queue = promise.then(() => {});
    }
    void promise.then((display) => {
      if (this.isCurrent(controller, query) && el.isConnected && slot.parentElement === el) {
        slot.empty();
        if (display.kind === "passage")
          slot.createEl("blockquote", { cls: "trama-note-result__quote", text: display.text });
        else slot.textContent = display.text;
      }
    });
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
    this.hoverPopover?.unload();
    this.hoverPopover = null;
    this.controller?.abort();
    this.controller = undefined;
    this.cachedQuery = undefined;
    this.cachedResults = [];
    this.queue = Promise.resolve();
    this.evidence.clear();
  }
  private isCurrent(controller: AbortController, query: string): boolean {
    return this.opened && !controller.signal.aborted && this.inputEl.value.trim() === query;
  }
}
