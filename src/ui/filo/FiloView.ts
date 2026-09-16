import { ItemView, Keymap, setIcon, setTooltip, WorkspaceLeaf } from "obsidian";
import { RelatedNotes, RelatedNotesResult } from "@/index/RelatedNotes";
import { formatIndexProgress, IndexStatus, IndexStatusController } from "@/ui/index/IndexStatus";
import { TRAMA_ICONS } from "@/ui/icons";
import type { IconName } from "obsidian";

export const FILO_VIEW_TYPE = "trama-filo";

interface StatusSource {
  getStatus(): IndexStatus;
  subscribe(listener: (status: IndexStatus) => void): () => void;
}

interface RelatedSource {
  find(path: string, signal: AbortSignal, limit?: number): Promise<RelatedNotesResult>;
  subscribe?(listener: (result: RelatedNotesResult) => void): () => void;
  snapshotKey?(path: string): string | undefined;
}

/** Native Obsidian view for the seven most related notes around the active note. */
export class FiloView extends ItemView {
  static readonly BASE_RESULT_COUNT = 7;
  static readonly MAX_RESULT_COUNT = 20;
  static readonly EXTENDED_SIMILARITY_THRESHOLD = 0.3;
  static readonly HIGH_SIMILARITY_THRESHOLD = 0.72;
  static readonly MEDIUM_SIMILARITY_THRESHOLD = 0.5;

  private statusUnsubscribe?: () => void;
  private relatedUnsubscribe?: () => void;
  private activeEvent?: { unsubscribe?: () => void };
  private requestGeneration = 0;
  private requestAbort?: AbortController;
  private requestKey?: string;
  private activePath?: string;
  private related?: RelatedNotesResult;
  private relatedError = false;
  private status!: IndexStatus;
  private root!: HTMLDivElement;
  private isViewOpen = false;
  private readonly expandedPaths = new Set<string>();

  constructor(
    leaf: WorkspaceLeaf,
    private statusSource: StatusSource | IndexStatusController,
    private relatedSource: RelatedSource | RelatedNotes | undefined,
    private readonly runIndex?: (kind: "index" | "reindex") => Promise<void>,
    private readonly cancelIndex?: () => void,
    private readonly runPrepare?: () => Promise<void>
  ) {
    super(leaf);
    this.status = statusSource.getStatus();
  }

  getViewType(): string {
    return FILO_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Filo";
  }
  getIcon(): IconName {
    return TRAMA_ICONS.filo;
  }

  setDependencies(
    status: StatusSource | IndexStatusController,
    related: RelatedSource | RelatedNotes | undefined
  ): void {
    const wasOpen = this.isViewOpen;
    this.teardown();
    this.statusSource = status;
    this.relatedSource = related;
    this.status = status.getStatus();
    if (wasOpen) void this.onOpen();
  }

  override onOpen(): Promise<void> {
    if (this.isViewOpen) this.teardown();
    this.isViewOpen = true;
    this.contentEl.empty();
    this.root = this.contentEl.createDiv({ cls: "trama-filo" });
    this.root.createEl("h1", { text: "Filo", cls: "trama-filo__title" });
    this.statusUnsubscribe = this.statusSource.subscribe((status) => {
      this.status = status;
      this.render();
      this.refreshRelated();
    });
    const workspace = (this.app as any)?.workspace;
    this.activeEvent = workspace?.on?.("active-leaf-change", () => this.refreshRelated());
    this.relatedUnsubscribe = this.relatedSource?.subscribe?.((result) => {
      if (this.acceptsResult(result)) {
        this.related = result;
        this.render();
      }
    });
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    this.isViewOpen = false;
    this.teardown();
    return Promise.resolve();
  }

  /** Refreshes the active note's suggestions after an index/prune settlement. */
  refreshRelatedSuggestions(): void {
    if (this.isViewOpen) this.refreshRelated();
  }

  private teardown(): void {
    this.requestGeneration++;
    this.requestAbort?.abort();
    this.statusUnsubscribe?.();
    this.relatedUnsubscribe?.();
    this.activeEvent?.unsubscribe?.();
    this.statusUnsubscribe = undefined;
    this.relatedUnsubscribe = undefined;
    this.activeEvent = undefined;
    this.related = undefined;
    this.relatedError = false;
    this.requestKey = undefined;
  }

  private currentPath(): string | undefined {
    const file = (this.app as any)?.workspace?.getActiveFile?.();
    return typeof file?.path === "string" && /\.md$/i.test(file.path) ? file.path : undefined;
  }

  private refreshRelated(): void {
    const path = this.currentPath();
    if (path !== this.activePath) this.expandedPaths.clear();
    this.activePath = path;
    if (!path || !this.relatedSource || !this.semanticReady()) {
      this.requestAbort?.abort();
      this.requestAbort = undefined;
      this.requestKey = undefined;
      this.related = undefined;
      this.relatedError = false;
      this.render();
      return;
    }
    const key = this.relatedSource.snapshotKey?.(path) ?? path;
    if (this.requestKey === key && (this.requestAbort || this.related)) {
      this.render();
      return;
    }
    this.requestAbort?.abort();
    this.requestKey = key;
    this.related = undefined;
    this.relatedError = false;
    this.render();
    const generation = ++this.requestGeneration;
    const controller = new AbortController();
    this.requestAbort = controller;
    void this.relatedSource
      .find(path, controller.signal, FiloView.MAX_RESULT_COUNT)
      .then((result) => {
        if (generation !== this.requestGeneration || controller.signal.aborted) return;
        if (!this.acceptsResult(result)) return;
        this.requestAbort = undefined;
        this.related = result;
        this.render();
      })
      .catch(() => {
        if (generation === this.requestGeneration && !controller.signal.aborted) {
          this.requestAbort = undefined;
          this.relatedError = true;
          this.render();
        }
      });
  }

  private acceptsResult(result: RelatedNotesResult): boolean {
    // A completed read remains usable after a mutable-index counter bump. The
    // next request observes the new snapshot key and refreshes the cache.
    return result.currentPath === this.activePath;
  }

  private render(): void {
    if (!this.root) return;
    this.root.empty();
    this.root.createEl("h1", { text: "Filo", cls: "trama-filo__title" });
    const path = this.activePath;
    if (!path) {
      this.root.createDiv({
        cls: "setting-item-description trama-filo__message",
        text: "Open a Markdown note to see related notes.",
      });
      return;
    }
    const status = this.status;
    const capabilities = status.capabilities;
    if (status.kind === "loading") {
      this.root.createDiv({
        cls: "setting-item-description trama-filo__message",
        text: "Loading lexical and semantic indexes…",
      });
      return;
    }
    if (capabilities?.availability === "unavailable") {
      this.root.createDiv({
        cls: "setting-item-description mod-warning trama-filo__message",
        text: "SQLite lexical and semantic indexes are unavailable. Related notes cannot be loaded.",
      });
      return;
    }
    if (status.kind === "index-required") {
      this.root.createDiv({
        cls: "setting-item-description trama-filo__message",
        text: "Build the lexical index, then update the semantic index to discover related notes.",
      });
      if (status.canIndex) this.actionButton("Build lexical index", "index");
      return;
    }
    if (status.kind === "building" || status.kind === "preparing" || status.kind === "cancelling") {
      if (status.kind === "cancelling" || !this.renderProgress(status))
        this.root.createDiv({
          cls: "setting-item-description trama-filo__message",
          text: status.message ?? "Updating lexical or semantic index…",
        });
      if (status.canCancel) this.actionButton("Cancel", "cancel");
      return;
    }
    if (status.kind === "stale") {
      if (status.hasLastGood && this.related) this.renderRows();
      this.root.createDiv({
        cls: "setting-item-description mod-warning trama-filo__message",
        text: status.message ?? "Lexical index has changes; update required.",
      });
      if (status.canIndex) this.actionButton("Update lexical index", "index");
      if (status.canReindex) this.actionButton("Rebuild lexical index", "reindex");
      this.renderFreshnessWarning(status.freshness);
      return;
    }
    if (status.kind === "error") {
      if (status.hasLastGood && this.related) this.renderRows();
      this.root.createDiv({
        cls: "setting-item-description mod-warning trama-filo__message",
        text: status.message ?? "Lexical or semantic indexing failed.",
      });
      if (status.channel === "semantic") {
        if (status.canPrepare) this.semanticButtons();
      } else if (status.canReindex) this.actionButton("Rebuild lexical index", "reindex");
      else if (status.canIndex) this.actionButton("Build lexical index", "index");
      this.renderFreshnessWarning(status.freshness);
      return;
    }
    if (status.kind === "cancelled") {
      if (status.hasLastGood && this.related) this.renderRows();
      this.root.createDiv({
        cls: "setting-item-description mod-warning trama-filo__message",
        text: status.message ?? "Lexical or semantic indexing cancelled.",
      });
      if (status.channel === "semantic") {
        if (status.canPrepare) this.semanticButtons();
      } else if (status.canReindex) this.actionButton("Rebuild lexical index", "reindex");
      else if (status.canIndex) this.actionButton("Build lexical index", "index");
      this.renderFreshnessWarning(status.freshness);
      return;
    }
    if (status.kind === "updating") {
      if (this.related) this.renderRows();
      if (!this.renderProgress(status))
        this.root.createDiv({
          cls: "setting-item-description trama-filo__message",
          text: "Updating lexical index…",
        });
      return;
    }
    if (status.kind === "empty") {
      this.root.createDiv({
        cls: "setting-item-description trama-filo__message",
        text: "No related notes found.",
      });
      if (status.canReindex) this.actionButton("Rebuild lexical index", "reindex");
      else if (status.canIndex) this.actionButton("Build lexical index", "index");
      return;
    }
    if (capabilities && !capabilities.semantic.searchable) {
      const message =
        capabilities.semantic.activity === "updating"
          ? "Updating semantic index…"
          : capabilities.semantic.state === "partial"
            ? "Semantic index is incomplete. Update the lexical index or semantic vectors to discover related notes."
            : capabilities.semantic.state === "incompatible"
              ? "Stored semantic vectors are incompatible. Update the semantic index to refresh them."
              : "Update the semantic index to discover related notes.";
      this.root.createDiv({
        cls: "setting-item-description mod-warning trama-filo__message",
        text: message,
      });
      if (capabilities.semantic.activity !== "updating") this.semanticButtons();
      this.renderFreshnessWarning(capabilities.freshness);
      return;
    }
    if (!this.related) {
      this.root.createDiv({
        cls: this.relatedError
          ? "setting-item-description mod-warning trama-filo__message"
          : "setting-item-description trama-filo__message",
        text: this.relatedError ? "Related notes could not be loaded." : "Finding related notes…",
      });
      return;
    }
    if (this.related.unavailableReason) {
      this.root.createDiv({
        cls: "setting-item-description mod-warning trama-filo__message",
        text:
          this.related.unavailableReason === "incomplete-vectors"
            ? "Semantic coverage is incomplete. Update the semantic index to discover related notes."
            : "Semantic related notes are unavailable. Update the semantic index when available.",
      });
      this.semanticButtons();
      this.renderFreshnessWarning(this.related.freshness);
      return;
    }
    this.renderRows();
    if (capabilities?.semantic.state === "partial") {
      this.root.createDiv({
        cls: "setting-item-description mod-warning trama-filo__message",
        text: "Semantic index is incomplete; related notes use available vectors.",
      });
      this.semanticButtons();
    }
    this.renderFreshnessWarning(capabilities?.freshness ?? this.related?.freshness);
  }

  private semanticReady(): boolean {
    return (
      this.status.capabilities?.semantic.searchable === true ||
      (!this.status.capabilities && this.status.hasLastGood)
    );
  }

  private renderFreshnessWarning(freshness?: string): void {
    if (freshness !== "snapshot-loaded" && freshness !== "unknown") return;
    this.root.createDiv({
      cls: "setting-item-description mod-warning trama-filo__message",
      text:
        freshness === "snapshot-loaded"
          ? "Snapshot loaded — not locally reconciled. Related notes reflect the synchronized snapshot."
          : "Index may be stale; related notes reflect the indexed content until an update.",
    });
  }

  private semanticButtons(): void {
    const source = this.statusSource as IndexStatusController;
    const actions = [
      ["Update semantic index", () => this.runPrepare?.() ?? source.run("prepare")],
      ["Rebuild semantic index", () => source.run("rebuild-semantic")],
    ] as const;
    for (const [label, run] of actions) {
      const button = this.root.createEl("button", {
        cls: "trama-filo__action",
        text: label,
        attr: { type: "button", "aria-label": label },
      });
      button.addEventListener("click", () => void run());
    }
  }

  private renderProgress(status: IndexStatus): boolean {
    const progress = status.progress;
    if (!progress) return false;
    const label = formatIndexProgress(progress, status.etaSeconds);
    this.root.createEl("p", {
      cls: "setting-item-description trama-filo__progress-label",
      text: label,
      attr: { "aria-live": "polite" },
    });
    this.root.createEl("progress", {
      cls: "trama-filo__progress",
      attr: {
        "aria-label": label,
        ...(progress.determinate && progress.total !== undefined
          ? {
              max: String(Math.max(1, progress.total)),
              value: String(Math.min(progress.completed, Math.max(1, progress.total))),
            }
          : {}),
      },
    });
    return true;
  }

  private renderRows(): void {
    const rows = this.root.createDiv({ cls: "trama-filo__rows" });
    const paths = new Set<string>();
    for (const result of this.related?.results ?? []) {
      if (result.path === this.activePath || paths.has(result.path)) continue;
      if (
        paths.size >= FiloView.BASE_RESULT_COUNT &&
        (result.similarity === undefined ||
          result.similarity < FiloView.EXTENDED_SIMILARITY_THRESHOLD)
      )
        continue;
      if (paths.size >= FiloView.MAX_RESULT_COUNT) break;
      paths.add(result.path);
      const expanded = this.expandedPaths.has(result.path);
      const item = rows.createDiv({ cls: "trama-filo__item" });
      const header = item.createDiv({ cls: "trama-filo__row" });
      const caret = header.createEl("button", {
        cls: "clickable-icon trama-filo__caret",
        attr: {
          type: "button",
          "aria-label": `${expanded ? "Collapse" : "Expand"} ${this.basename(result.path)}`,
          "aria-expanded": String(expanded),
        },
      });
      setIcon(caret, expanded ? "chevron-down" : "chevron-right");
      caret.addEventListener("click", () => {
        if (expanded) this.expandedPaths.delete(result.path);
        else this.expandedPaths.add(result.path);
        this.render();
      });
      const link = header.createEl("a", {
        cls: "internal-link trama-filo__link",
        text: this.basename(result.path),
        attr: { href: result.path },
      });
      setTooltip(link, result.path);
      link.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        void (this.app as any).workspace.openLinkText(
          result.path,
          this.activePath ?? "",
          Keymap.isModEvent(event)
        );
      });
      const relevance = this.relevance(result.similarity ?? result.score);
      header.createSpan({
        cls: "setting-item-description trama-filo__relevance",
        text: relevance,
      });
      if (expanded) {
        const detail = item.createDiv({ cls: "trama-filo__detail" });
        if (result.excerpt) detail.createDiv({ cls: "trama-filo__excerpt", text: result.excerpt });
        detail.createDiv({
          cls: "setting-item-description trama-filo__path",
          text: `${result.path}${this.lineLabel(result.startLine, result.endLine)}`,
        });
      }
    }
    if (!paths.size)
      rows.createDiv({
        cls: "setting-item-description trama-filo__message",
        text: "No related notes found.",
      });
  }

  private actionButton(label: string, action: "index" | "reindex" | "cancel"): void {
    const button = this.root.createEl("button", {
      cls: `${action === "cancel" ? "clickable-icon " : ""}trama-filo__action`,
      text: label,
      attr: { type: "button", "aria-label": label },
    });
    if (action === "cancel") setIcon(button, "square");
    button.addEventListener("click", () => {
      if (action === "cancel") {
        if (this.cancelIndex) this.cancelIndex();
        else (this.statusSource as IndexStatusController).cancel();
      } else {
        const run = this.runIndex
          ? this.runIndex(action)
          : (this.statusSource as IndexStatusController).run(action);
        void run;
      }
    });
  }

  private basename(path: string): string {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
  }

  private relevance(similarity: number): "High" | "Medium" | "Low" {
    if (similarity >= FiloView.HIGH_SIMILARITY_THRESHOLD) return "High";
    if (similarity >= FiloView.MEDIUM_SIMILARITY_THRESHOLD) return "Medium";
    return "Low";
  }

  private lineLabel(start?: number, end?: number): string {
    if (start === undefined) return "";
    return ` · ${start === end || end === undefined ? `line ${start}` : `lines ${start}–${end}`}`;
  }
}
