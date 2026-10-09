import { Keymap, SuggestModal, type App } from "obsidian";
import type { VaultRetrievalOutput } from "@/index/VaultRetrieval";
import type { SearchRunnable } from "./LenteView";

interface NoteResult {
  readonly path: string;
  readonly title: string;
}
export class LenteSearchModal extends SuggestModal<NoteResult> {
  private controller?: AbortController;
  private revision = 0;
  private results: NoteResult[] = [];
  private status = "";
  constructor(
    app: App,
    private readonly search: SearchRunnable
  ) {
    super(app);
    this.setPlaceholder("Search your vault");
    this.setInstructions([{ command: "Enter", purpose: "Search" }]);
  }
  override getSuggestions(query: string): NoteResult[] {
    if (query.trim() && !this.controller && !this.results.length && !this.status)
      void this.submit(query);
    return this.results;
  }
  override renderSuggestion(result: NoteResult, el: HTMLElement): void {
    el.empty();
    el.createDiv({ cls: "suggestion-title", text: result.title });
    el.createDiv({ cls: "suggestion-note", text: result.path });
  }
  override onChooseSuggestion(result: NoteResult, event: MouseEvent | KeyboardEvent): void {
    void (this.app as App).workspace.openLinkText(result.path, "", Keymap.isModEvent(event));
  }
  override onOpen(): void {
    super.onOpen();
    this.inputEl.focus();
  }
  override onClose(): void {
    this.cancel();
    super.onClose();
  }
  private cancel(): void {
    this.revision++;
    this.controller?.abort();
    this.controller = undefined;
  }
  private async submit(query = this.inputEl.value): Promise<void> {
    query = query.trim();
    if (!query) return;
    this.cancel();
    const revision = ++this.revision;
    const controller = new AbortController();
    this.controller = controller;
    this.status = "Searching…";
    this.results = [];
    this.refresh();
    try {
      const result = await this.search.invoke(
        { query, mode: "hybrid" },
        { signal: controller.signal }
      );
      if (revision !== this.revision || controller.signal.aborted) return;
      this.results = result.documents.flatMap((document) => {
        const path = String(document.metadata.path ?? document.id ?? "");
        return path ? [{ path, title: path.split("/").pop()?.replace(/\.md$/i, "") ?? path }] : [];
      });
      this.status = this.describe(result);
      this.controller = undefined;
    } catch {
      if (revision !== this.revision || controller.signal.aborted) return;
      this.controller = undefined;
      this.status = "Search failed.";
    }
    this.refresh();
  }
  private describe(output: VaultRetrievalOutput): string {
    if (!output.documents.length) return "No matching notes found.";
    return output.status.degraded
      ? "Results use lexical search because semantic search degraded."
      : `${output.documents.length} notes`;
  }
  private refresh(): void {
    this.emptyStateText = this.status;
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
