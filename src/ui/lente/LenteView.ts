import { ButtonComponent, ItemView, Keymap, SearchComponent, WorkspaceLeaf } from "obsidian";
import type { Runnable } from "@langchain/core/runnables";
import type { VaultRetrievalInput, VaultRetrievalOutput } from "@/index/VaultRetrieval";
import { TRAMA_ICONS } from "@/ui/icons";
import { appendNoteResultRow } from "@/ui/noteResultRow";
import type { IconName } from "obsidian";
import type { ConsoleDebug } from "@/plugin/ConsoleDebug";

export const LENTE_VIEW_TYPE = "trama-lente";
export type SearchRunnable = Pick<Runnable<VaultRetrievalInput, VaultRetrievalOutput>, "invoke">;

export class LenteView extends ItemView {
  private input!: HTMLInputElement;
  private status!: HTMLDivElement;
  private rows!: HTMLDivElement;
  private resultsCount!: HTMLDivElement;
  private controller?: AbortController;
  private revision = 0;
  private submitted = "";
  private output?: VaultRetrievalOutput;
  private opened = false;
  constructor(
    leaf: WorkspaceLeaf,
    private search: SearchRunnable,
    private readonly consoleDebug?: ConsoleDebug
  ) {
    super(leaf);
  }
  getViewType(): string {
    return LENTE_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Lente";
  }
  getIcon(): IconName {
    return TRAMA_ICONS.lente;
  }
  setSearch(search: SearchRunnable): void {
    this.cancel();
    this.search = search;
    this.output = undefined;
    this.render();
  }
  clearResults(): void {
    this.cancel();
    this.submitted = "";
    this.output = undefined;
    if (this.input) this.input.value = "";
    if (this.status) this.status.textContent = "";
    this.render();
  }
  refreshSubmitted(): void {
    if (this.submitted && this.opened) void this.run(this.submitted);
  }
  override onOpen(): Promise<void> {
    this.opened = true;
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "trama-lente" });
    root.createEl("h1", { text: "Lente", cls: "trama-lente__title" });
    const form = root.createDiv({ cls: "trama-lente__form" });
    const search = new SearchComponent(form).setPlaceholder("Search your vault");
    this.input = search.inputEl;
    this.input.parentElement?.classList.add("trama-lente__input-component");
    this.input.classList.add("trama-lente__input");
    this.input.setAttribute("aria-label", "Search your vault");
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        this.submitted = this.input.value.trim();
        void this.run(this.submitted);
      }
      if (event.key === "Escape") {
        this.clearResults();
      }
    });
    new ButtonComponent(form)
      .setButtonText("Search")
      .onClick(() => {
        this.submitted = this.input.value.trim();
        void this.run(this.submitted);
      })
      .buttonEl.classList.add("trama-lente__submit");
    this.status = root.createDiv({
      cls: "setting-item-description trama-lente__status",
      attr: { "aria-live": "polite" },
    });
    const resultGroup = root.createDiv({ cls: "trama-note-results" });
    const resultsInfo = resultGroup.createDiv({ cls: "search-results-info" });
    this.resultsCount = resultsInfo.createDiv({
      cls: "search-results-result-count",
      attr: { "aria-live": "polite" },
    });
    this.rows = resultGroup.createDiv({
      cls: "search-result-container mod-global-search trama-lente__rows",
    });
    this.render();
    return Promise.resolve();
  }
  override onClose(): Promise<void> {
    this.opened = false;
    this.cancel();
    return Promise.resolve();
  }
  private cancel(): void {
    this.revision++;
    this.controller?.abort();
    this.controller = undefined;
  }
  private async run(query: string): Promise<void> {
    if (!query) {
      this.output = undefined;
      this.cancel();
      this.render();
      return;
    }
    this.cancel();
    const revision = ++this.revision;
    const controller = new AbortController();
    this.controller = controller;
    this.render();
    try {
      const output = await this.search.invoke(
        { query, mode: "hybrid", content: "metadata" },
        { signal: controller.signal }
      );
      if (revision !== this.revision || controller.signal.aborted) return;
      this.output = output;
      this.controller = undefined;
    } catch (error) {
      if (revision !== this.revision || controller.signal.aborted) return;
      this.consoleDebug?.error("Lente search failed", error);
      this.output = undefined;
      this.controller = undefined;
      this.status.textContent = "Search failed. Try again.";
    }
    this.render();
  }
  private render(): void {
    if (!this.status || !this.rows) return;
    this.rows.empty();
    this.resultsCount.textContent = "";
    if (this.controller) {
      this.status.textContent = "Searching…";
      return;
    }
    const output = this.output;
    if (!output) {
      if (!this.status.textContent.includes("failed"))
        this.status.textContent = "Submit a query to search your vault.";
      return;
    }
    const documents = output.documents.filter((document) =>
      Boolean(this.app.vault.getFileByPath(String(document.metadata.path ?? document.id ?? "")))
    );
    this.resultsCount.textContent = documents.length
      ? `${documents.length} ${documents.length === 1 ? "result" : "results"}`
      : "";
    this.status.textContent = output.status.degraded
      ? output.status.degradationReason === "query-embedding-failed"
        ? "Lexical results (query embedding failed)."
        : "Lexical results (semantic search unavailable)."
      : documents.length
        ? ""
        : "No matching notes found.";
    for (const document of documents) {
      const path = String(document.metadata.path ?? document.id ?? "");
      appendNoteResultRow(this.rows, this.app, path, this.leaf, (event) => {
        void (this.app as any).workspace.openLinkText(path, "", Keymap.isModEvent(event));
      });
    }
  }
}
