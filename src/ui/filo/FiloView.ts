import { ItemView, Keymap, setTooltip, WorkspaceLeaf } from "obsidian";
import type { Document } from "@langchain/core/documents";
import type { IndexStatus, IndexStatusController } from "@/ui/index/IndexStatus";
import { TRAMA_ICONS } from "@/ui/icons";
import { appendNoteResultRow } from "@/ui/noteResultRow";
import type { IconName, EventRef } from "obsidian";

export const FILO_VIEW_TYPE = "trama-filo";
interface RelatedSource {
  related(
    path: string,
    signal: AbortSignal,
    limit?: number
  ): Promise<{ readonly documents: readonly Document[]; readonly available: boolean }>;
}

export class FiloView extends ItemView {
  private status: IndexStatus;
  private unsubscribe?: () => void;
  private event?: EventRef;
  private controller?: AbortController;
  private generation = 0;
  private activePath?: string;
  private documents: readonly Document[] = [];
  private available = false;
  private error = false;
  constructor(
    leaf: WorkspaceLeaf,
    private readonly statusSource: IndexStatusController,
    private related: RelatedSource | undefined
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
  setRelated(source?: RelatedSource): void {
    this.cancel();
    this.related = source;
    this.documents = [];
    this.refresh();
  }
  refreshActiveNote(path: string | undefined): void {
    this.refresh(path ?? null);
  }
  override onOpen(): Promise<void> {
    this.unsubscribe = this.statusSource.subscribe((status) => {
      const wasBuilding = this.status.kind === "building";
      this.status = status;
      const isBuilding = status.kind === "building";
      const finishedBuilding = wasBuilding && !isBuilding;
      if (isBuilding || finishedBuilding) this.refresh();
      else this.render();
    });
    this.event = this.app.workspace.on("active-leaf-change", () => this.refresh());
    this.refresh();
    return Promise.resolve();
  }
  override onClose(): Promise<void> {
    this.unsubscribe?.();
    if (this.event) this.app.workspace.offref(this.event);
    this.event = undefined;
    this.cancel();
    return Promise.resolve();
  }
  private cancel(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
  }
  private refresh(pathOverride?: string | null): void {
    const path =
      pathOverride === undefined
        ? ((this.app as any)?.workspace?.getActiveFile?.()?.path as string | undefined)
        : (pathOverride ?? undefined);
    this.activePath = path && path.toLowerCase().endsWith(".md") ? path : undefined;
    this.cancel();
    this.documents = [];
    this.available = false;
    this.error = false;
    if (!this.activePath || !this.related || this.status.kind === "building") {
      this.render();
      return;
    }
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    void this.related
      .related(this.activePath, controller.signal, 20)
      .then((result) => {
        if (generation !== this.generation || controller.signal.aborted) return;
        this.documents = result.documents;
        this.available = result.available;
        this.controller = undefined;
        this.render();
      })
      .catch(() => {
        if (generation !== this.generation || controller.signal.aborted) return;
        this.error = true;
        this.controller = undefined;
        this.render();
      });
    this.render();
  }
  private render(): void {
    if (!this.contentEl) return;
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "trama-filo" });
    root.createEl("h1", { text: "Filo", cls: "trama-filo__title" });
    if (!this.activePath) {
      root.createDiv({ text: "Open a Markdown note to see related notes." });
      return;
    }
    if (this.status.kind === "building") {
      root.createDiv({ text: "Updating the index…" });
      return;
    }
    if (this.controller) {
      root.createDiv({ text: "Finding related notes…" });
      return;
    }
    if (this.error) {
      root.createDiv({ text: "Related notes could not be loaded." });
      return;
    }
    if (!this.available) {
      root.createDiv({
        text: "Related notes are unavailable until this note has semantic vectors.",
      });
      return;
    }
    if (!this.documents.length) {
      root.createDiv({ text: "No related notes found." });
      return;
    }
    const documents = this.documents.filter((document) => {
      const path = String(document.metadata.path ?? document.id ?? "");
      return Boolean(path && path !== this.activePath && this.app.vault.getFileByPath(path));
    });
    if (!documents.length) {
      root.createDiv({ text: "No related notes found." });
      return;
    }
    const resultGroup = root.createDiv({ cls: "trama-note-results" });
    const resultsInfo = resultGroup.createDiv({ cls: "search-results-info" });
    resultsInfo.createDiv({
      cls: "search-results-result-count",
      text: `${documents.length} related ${documents.length === 1 ? "note" : "notes"}`,
    });
    const rows = resultGroup.createDiv({
      cls: "search-result-container mod-global-search trama-filo__rows",
    });
    for (const document of documents) {
      const path = String(document.metadata.path ?? document.id ?? "");
      const link = appendNoteResultRow(
        rows,
        this.app,
        path,
        this.leaf,
        (event) => {
          void (this.app as any).workspace.openLinkText(
            path,
            this.activePath ?? "",
            Keymap.isModEvent(event)
          );
        },
        document.metadata.score
      );
      setTooltip(link, path);
    }
  }
}
