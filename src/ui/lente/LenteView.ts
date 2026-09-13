import { ItemView, Keymap, setIcon, setTooltip, WorkspaceLeaf } from "obsidian";
import {
  sortLenteResults,
  type LenteBatch,
  type LenteResult,
  type LenteSearchOptions,
  type LenteSearch,
  type LenteSort,
} from "@/index/LenteSearch";
import { TRAMA_ICONS } from "@/ui/icons";
import type { IconName } from "obsidian";

export const LENTE_VIEW_TYPE = "trama-lente";

interface LenteSearchPort {
  search(query: string, options?: LenteSearchOptions): Promise<LenteBatch>;
}

/** Native Obsidian view for explicit-submit hybrid vault search. */
export class LenteView extends ItemView {
  private root!: HTMLDivElement;
  private input!: HTMLInputElement;
  private submitButton!: HTMLButtonElement;
  private toolbar!: HTMLDivElement;
  private resultCountEl!: HTMLSpanElement;
  private sortGroup!: HTMLDivElement;
  private statusEl!: HTMLDivElement;
  private announcementEl!: HTMLDivElement;
  private rowsEl!: HTMLDivElement;
  private sort: LenteSort = "relevant";
  private draft = "";
  private submitted = "";
  private batch?: LenteBatch;
  private canonicalResults: readonly LenteResult[] = [];
  private abort?: AbortController;
  private revision = 0;
  private opened = false;
  private lastError = false;
  private errorMessage = "Search failed. Try again.";

  constructor(
    leaf: WorkspaceLeaf,
    private searchSource: LenteSearchPort | LenteSearch
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

  setSearch(search: LenteSearchPort | LenteSearch): void {
    this.cancel();
    this.searchSource = search;
    this.batch = undefined;
    this.canonicalResults = [];
    this.lastError = false;
    this.errorMessage = "Search failed. Try again.";
    if (this.announcementEl) this.announcementEl.textContent = "";
    if (this.opened) this.render();
  }

  /** Reruns the last submitted query after the mutable index changes. */
  refreshSubmitted(): void {
    if (this.submitted && this.opened) void this.runQuery(this.submitted);
  }

  override onOpen(): Promise<void> {
    this.opened = true;
    this.contentEl.empty();
    this.root = this.contentEl.createDiv({ cls: "trama-lente" });
    this.root.createEl("h1", { text: "Lente", cls: "trama-lente__title" });
    const form = this.root.createDiv({ cls: "trama-lente__form" });
    this.input = form.createEl("input", {
      cls: "trama-lente__input",
      attr: { type: "search", placeholder: "Search your vault", "aria-label": "Search your vault" },
    });
    this.input.value = this.draft;
    this.input.addEventListener("input", () => {
      this.draft = this.input.value;
    });
    this.input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        void this.submit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.clear();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        this.firstRow()?.focus();
      }
    });
    this.submitButton = form.createEl("button", {
      cls: "clickable-icon trama-lente__submit",
      text: "Search",
      attr: { type: "button", "aria-label": "Search" },
    });
    setIcon(this.submitButton, TRAMA_ICONS.lente);
    this.submitButton.addEventListener("click", () => void this.submit());
    this.toolbar = this.root.createDiv({
      cls: "trama-lente__toolbar",
      attr: { hidden: "true", "aria-hidden": "true" },
    });
    this.resultCountEl = this.toolbar.createSpan({
      cls: "setting-item-description trama-lente__count",
    });
    this.sortGroup = this.toolbar.createDiv({
      cls: "trama-lente__sort",
      attr: { role: "group", "aria-label": "Sort results" },
    });
    for (const value of ["relevant", "updated"] as const) {
      const button = this.sortGroup.createEl("button", {
        cls: "clickable-icon trama-lente__sort-button",
        text: value === "relevant" ? "Relevant" : "Updated",
        attr: {
          type: "button",
          "aria-label": `Sort by ${value}`,
          "aria-pressed": String(value === this.sort),
        },
      });
      setTooltip(button, `Sort by ${value}`);
      const icon = button.createSpan({
        cls: "trama-lente__sort-icon",
        attr: { "aria-hidden": "true" },
      });
      setIcon(icon, "arrow-up-down");
      button.addEventListener("click", () => {
        this.sort = value;
        this.renderSort(this.sortGroup);
        if (this.batch) {
          this.batch = {
            ...this.batch,
            results: sortLenteResults(this.canonicalResults, this.sort, this.batch.displayLimit),
          };
          this.renderRows();
        }
      });
    }
    this.renderSort(this.sortGroup);
    this.statusEl = this.root.createDiv({
      cls: "setting-item-description trama-lente__status",
    });
    this.announcementEl = this.root.createDiv({
      cls: "trama-lente__announcement",
      attr: { "aria-live": "polite", "aria-atomic": "true" },
    });
    this.rowsEl = this.root.createDiv({ cls: "trama-lente__rows" });
    this.render();
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    this.opened = false;
    this.cancel();
    return Promise.resolve();
  }

  private async submit(): Promise<void> {
    const query = this.draft.trim();
    if (!query) {
      this.clear();
      return;
    }
    this.submitted = query;
    await this.runQuery(query);
  }

  private async runQuery(query: string): Promise<void> {
    this.cancel();
    const revision = ++this.revision;
    const controller = new AbortController();
    this.abort = controller;
    this.lastError = false;
    this.errorMessage = "Search failed. Try again.";
    this.announcementEl.textContent = "";
    this.render();
    try {
      const batch = await this.searchSource.search(query, {
        sort: this.sort,
        signal: controller.signal,
      });
      if (revision !== this.revision || controller.signal.aborted) return;
      this.abort = undefined;
      this.canonicalResults = batch.canonicalResults ?? batch.results;
      this.batch = {
        ...batch,
        results: sortLenteResults(this.canonicalResults, this.sort, batch.displayLimit),
      };
      this.announcementEl.textContent = this.batch.results.length
        ? `${this.batch.results.length} results`
        : "No matching notes found.";
      this.render();
    } catch (error) {
      if (revision !== this.revision || controller.signal.aborted) return;
      this.abort = undefined;
      this.lastError = true;
      this.errorMessage = this.messageForError(error);
      this.render();
    }
  }

  private clear(): void {
    this.cancel();
    this.draft = "";
    this.submitted = "";
    this.batch = undefined;
    this.canonicalResults = [];
    this.lastError = false;
    this.errorMessage = "Search failed. Try again.";
    if (this.announcementEl) this.announcementEl.textContent = "";
    if (this.input) this.input.value = "";
    this.render();
  }
  private cancel(): void {
    this.revision++;
    this.abort?.abort();
    this.abort = undefined;
  }
  private render(): void {
    if (!this.statusEl || !this.rowsEl) return;
    const hasResults = Boolean(
      this.batch && this.batch.results.length && !this.abort && !this.lastError
    );
    this.toolbar.hidden = !hasResults;
    this.toolbar.setAttribute("aria-hidden", String(!hasResults));
    if (hasResults) this.resultCountEl.textContent = `${this.batch!.results.length} results`;
    this.statusEl.textContent = this.abort
      ? "Searching…"
      : this.lastError
        ? this.errorMessage
        : this.batch && this.submitted && this.batch.results.length === 0
          ? "No matching notes found."
          : this.batch?.degraded
            ? "Lexical-only results (embeddings unavailable)."
            : this.submitted
              ? ""
              : "Submit a query to search your vault.";
    this.renderRows();
  }
  private messageForError(error: unknown): string {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "busy") return "Updating index…";
    if (code === "unavailable") return "Index unavailable. Reindex required.";
    return "Search failed. Try again.";
  }
  private renderRows(): void {
    this.rowsEl.empty();
    if (!this.batch) return;
    if (!this.batch.results.length) {
      this.rowsEl.createDiv({
        cls: "setting-item-description trama-lente__message",
        text: "No matching notes found.",
      });
      return;
    }
    for (const result of this.batch.results) this.renderRow(result);
  }
  private renderRow(result: LenteResult): void {
    const item = this.rowsEl.createDiv({ cls: "trama-lente__item" });
    const link = item.createEl("a", {
      cls: "internal-link trama-lente__link",
      text: this.basename(result.path),
      attr: { href: result.path, tabindex: "0" },
    });
    setTooltip(link, result.path);
    link.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      void (this.app as any)?.workspace?.openLinkText?.(result.path, "", Keymap.isModEvent(event));
    });
    item.createDiv({
      cls: "setting-item-description trama-lente__path",
      text: `${result.path}${this.lineLabel(result.startLine, result.endLine)}`,
    });
    item.createDiv({ cls: "trama-lente__excerpt", text: result.excerpt });
    if (result.mtime !== null)
      item.createDiv({
        cls: "setting-item-description trama-lente__mtime",
        text: new Date(result.mtime).toLocaleString(),
      });
  }
  private renderSort(group: HTMLDivElement): void {
    for (const child of Array.from(group.children)) {
      const active = (child.textContent ?? "").toLowerCase() === this.sort;
      child.setAttribute("aria-pressed", String(active));
      (child as HTMLButtonElement).disabled = active;
    }
  }
  private firstRow(): HTMLAnchorElement | undefined {
    const row = this.rowsEl?.children[0] as unknown as
      { children?: ArrayLike<HTMLElement> } | undefined;
    return row?.children?.[0] as HTMLAnchorElement | undefined;
  }
  private basename(path: string): string {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
  }
  private lineLabel(start: number, end: number): string {
    return start === end ? ` · line ${start}` : ` · lines ${start}-${end}`;
  }
}
