import { Keymap, SuggestModal, type App } from "obsidian";
import type { LenteBatch, LenteResult, LenteSearchOptions } from "@/index/LenteSearch";

export interface LenteSearchPort {
  search(query: string, options?: LenteSearchOptions): Promise<LenteBatch>;
}

type ModalState =
  | { readonly kind: "idle"; readonly query: string }
  | { readonly kind: "loading"; readonly query: string }
  | {
      readonly kind: "results";
      readonly query: string;
      readonly results: readonly LenteResult[];
      readonly degraded: boolean;
    }
  | { readonly kind: "empty"; readonly query: string; readonly degraded: boolean }
  | { readonly kind: "busy"; readonly query: string }
  | { readonly kind: "unavailable"; readonly query: string }
  | { readonly kind: "error"; readonly query: string };

/** Explicit-submit native suggestion modal for vault search. */
export class LenteSearchModal extends SuggestModal<LenteResult> {
  private readonly automaticSearchDelayMs: number;
  private searchRevision = 0;
  private searchAbort?: AbortController;
  private automaticSearchTimer?: ReturnType<typeof setTimeout>;
  private submittedQuery = "";
  private state: ModalState = { kind: "idle", query: "" };
  private statusEl?: HTMLElement;
  private keydownWindow?: Window;
  private refreshingSuggestions = false;
  private composing = false;
  private modalOpen = false;
  private readonly captureKeydown = (event: KeyboardEvent): void => {
    if (event.target !== this.inputEl) return;
    if (event.key !== "Enter" || event.isComposing) return;

    const query = this.inputEl.value.trim();
    if (!query || this.hasSelectableResults(query) || this.state.kind === "loading") return;

    event.preventDefault();
    void this.submit(query);
  };

  constructor(
    app: App,
    private readonly searchSource: LenteSearchPort,
    automaticSearchDelayMs = 0
  ) {
    super(app);
    this.automaticSearchDelayMs = automaticSearchDelayMs;
    this.setPlaceholder("Search your vault");
    this.setInstructions([{ command: "Enter", purpose: "Search" }]);
    this.statusEl = this.contentEl.createDiv({
      cls: "trama-lente-search-modal__status",
      attr: { "aria-live": "polite", "aria-atomic": "true" },
    });
    this.inputEl.addEventListener("input", () => {
      if (this.refreshingSuggestions || !this.modalOpen || this.composing) return;
      this.handleInput();
    });
    this.inputEl.addEventListener("compositionstart", () => {
      if (!this.modalOpen) return;
      this.composing = true;
      this.handleInput(false);
    });
    this.inputEl.addEventListener("compositionend", () => {
      if (!this.modalOpen) return;
      this.composing = false;
      this.handleInput();
    });
  }

  override onOpen(): void {
    super.onOpen();
    this.modalOpen = true;
    this.attachKeydownListener();
    this.inputEl.focus();
    this.updateStatus();
    this.refreshSuggestions();
  }

  override onClose(): void {
    this.modalOpen = false;
    this.detachKeydownListener();
    this.cancelAutomaticSearch();
    this.cancelSearch();
    this.resetAfterClose();
    super.onClose();
  }

  override close(): void {
    this.modalOpen = false;
    this.cancelAutomaticSearch();
    this.cancelSearch();
    this.resetAfterClose();
    super.close();
  }

  /** Native suggestion UI calls this for the current keyboard selection. */
  override selectActiveSuggestion(evt: MouseEvent | KeyboardEvent): void {
    const query = this.inputEl?.value.trim() ?? "";
    if (!query || ("isComposing" in evt && evt.isComposing)) return;
    if (this.state.kind === "loading" && query === this.submittedQuery) return;
    if (this.state.kind !== "results" || query !== this.submittedQuery) {
      this.cancelAutomaticSearch();
      void this.submit(query);
      return;
    }
    super.selectActiveSuggestion(evt);
  }

  override onChooseSuggestion(result: LenteResult, evt: MouseEvent | KeyboardEvent): void {
    this.selectSuggestion(result, evt);
  }

  override getSuggestions(query: string): LenteResult[] {
    if (this.state.kind !== "results" || query.trim() !== this.submittedQuery) return [];
    return [...this.state.results];
  }

  override renderSuggestion(result: LenteResult, el: HTMLElement): void {
    el.empty();
    el.addClass("trama-lente-search-modal__result");
    const content = el.createDiv({
      cls: "suggestion-content trama-lente-search-modal__content",
    });
    content.createDiv({
      cls: "suggestion-title trama-lente-search-modal__title",
      text: this.basename(result.path),
    });
    content.createDiv({
      cls: "suggestion-note trama-lente-search-modal__path",
      text: `${result.path}${this.lineLabel(result.startLine, result.endLine)}`,
    });
    content.createDiv({
      cls: "suggestion-note trama-lente-search-modal__excerpt",
      text: result.excerpt,
    });
  }

  override selectSuggestion(result: LenteResult, evt: MouseEvent | KeyboardEvent): void {
    if (
      this.state.kind !== "results" ||
      this.state.results.indexOf(result) < 0 ||
      result.path.length === 0
    )
      return;
    void (this.app as App).workspace.openLinkText(result.path, "", Keymap.isModEvent(evt));
    this.close();
  }

  getState(): ModalState {
    return this.state;
  }

  private async submit(query: string): Promise<void> {
    const normalized = query.trim();
    if (!normalized) return;

    this.cancelSearch();
    this.cancelAutomaticSearch();
    const revision = ++this.searchRevision;
    const controller = new AbortController();
    this.searchAbort = controller;
    this.submittedQuery = normalized;
    this.clearSelectableResults();
    this.state = { kind: "loading", query: normalized };
    this.updateStatus();

    try {
      const batch = await this.searchSource.search(normalized, {
        sort: "relevant",
        signal: controller.signal,
      });
      if (!this.isCurrentSearch(revision, controller, normalized)) return;
      this.searchAbort = undefined;
      if (this.inputEl.value.trim() !== normalized) {
        this.state = { kind: "idle", query: this.inputEl.value };
        this.updateStatus();
        this.refreshSuggestions();
        return;
      }
      const results = [...batch.results];
      this.state = results.length
        ? { kind: "results", query: normalized, results, degraded: batch.degraded }
        : { kind: "empty", query: normalized, degraded: batch.degraded };
      this.updateStatus();
      this.refreshSuggestions();
    } catch (error) {
      if (!this.isCurrentSearch(revision, controller, normalized)) return;
      this.searchAbort = undefined;
      if (this.inputEl.value.trim() !== normalized) {
        this.state = { kind: "idle", query: this.inputEl.value };
      } else {
        const code = this.errorCode(error);
        this.state = {
          kind: code === "busy" ? "busy" : code === "unavailable" ? "unavailable" : "error",
          query: normalized,
        };
      }
      this.updateStatus();
      this.refreshSuggestions();
    }
  }

  private hasSelectableResults(query: string): boolean {
    return (
      this.state.kind === "results" &&
      this.state.results.some((result) => result.path.length > 0) &&
      query === this.submittedQuery
    );
  }

  private attachKeydownListener(): void {
    const owningWindow = this.inputEl.ownerDocument?.defaultView;
    if (!owningWindow) return;
    this.detachKeydownListener();
    owningWindow.addEventListener("keydown", this.captureKeydown, true);
    this.keydownWindow = owningWindow;
  }

  private detachKeydownListener(): void {
    this.keydownWindow?.removeEventListener("keydown", this.captureKeydown, true);
    this.keydownWindow = undefined;
  }

  private isCurrentSearch(revision: number, controller: AbortController, query: string): boolean {
    return (
      revision === this.searchRevision &&
      this.searchAbort === controller &&
      !controller.signal.aborted &&
      this.submittedQuery === query
    );
  }

  private cancelSearch(): void {
    this.searchRevision++;
    this.searchAbort?.abort();
    this.searchAbort = undefined;
  }

  private handleInput(schedule = true): void {
    const query = this.inputEl.value;
    this.cancelAutomaticSearch();
    this.cancelSearch();
    this.submittedQuery = "";
    this.clearSelectableResults();
    this.state = { kind: "idle", query };
    this.updateStatus();
    this.refreshSuggestions();
    if (schedule && query.trim() && this.automaticSearchDelayMs > 0)
      this.automaticSearchTimer = setTimeout(() => {
        this.automaticSearchTimer = undefined;
        if (!this.modalOpen || this.composing) return;
        const latestQuery = this.inputEl.value.trim();
        if (latestQuery) void this.submit(latestQuery);
      }, this.automaticSearchDelayMs);
  }

  private cancelAutomaticSearch(): void {
    if (this.automaticSearchTimer !== undefined) clearTimeout(this.automaticSearchTimer);
    this.automaticSearchTimer = undefined;
  }

  private clearSelectableResults(): void {
    if (this.state.kind === "results")
      this.state = { kind: "idle", query: this.inputEl?.value ?? "" };
    this.emptyStateText = "";
    this.resultContainerEl.empty();
  }

  private resetAfterClose(): void {
    this.submittedQuery = "";
    this.clearSelectableResults();
    this.state = { kind: "idle", query: this.inputEl?.value ?? "" };
    this.updateStatus();
  }

  private updateStatus(): void {
    const text = this.statusText();
    this.emptyStateText = text;
    if (this.statusEl) {
      this.statusEl.textContent = text;
      this.statusEl.toggleVisibility(Boolean(text));
    }
  }

  /** Ask the public SuggestModal input surface to render the accepted state. */
  private refreshSuggestions(): void {
    this.refreshingSuggestions = true;
    try {
      this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    } finally {
      this.refreshingSuggestions = false;
    }
  }

  private statusText(): string {
    switch (this.state.kind) {
      case "idle":
        return "";
      case "loading":
        return "Searching…";
      case "empty":
        return this.state.degraded
          ? "No matching notes (lexical-only; embeddings unavailable)."
          : "No matching notes";
      case "busy":
        return "Updating index";
      case "unavailable":
        return "Index unavailable";
      case "error":
        return "Search failed";
      case "results":
        return this.state.degraded ? "Lexical-only results (embeddings unavailable)." : "";
    }
  }

  private errorCode(error: unknown): string | undefined {
    return error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  }

  private basename(path: string): string {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
  }

  private lineLabel(start: number, end: number): string {
    return start === end ? ` · line ${start}` : ` · lines ${start}-${end}`;
  }
}
