import { ItemView, Keymap, WorkspaceLeaf } from "obsidian";
import type { IndexStatus, IndexStatusController } from "@/ui/index/IndexStatus";
import { TRAMA_ICONS } from "@/ui/icons";
import { appendNoteResultRow, renderResultContext } from "@/ui/noteResultRow";
import type { IconName, EventRef } from "obsidian";
import type { NoteStoreHit } from "@/index/note-sqlite/protocol";
import type { VaultRetrieval } from "@/index/VaultRetrieval";

export const FILO_VIEW_TYPE = "trama-filo";
type RelatedSource = Pick<VaultRetrieval, "related" | "searchEvidence">;

export class FiloView extends ItemView {
  private status: IndexStatus;
  private unsubscribe?: () => void;
  private event?: EventRef;
  private controller?: AbortController;
  private activePath?: string;
  private contextRequests = new Map<string, AbortController>();
  private hits: readonly NoteStoreHit[] = [];
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
    this.hits = [];
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
    });
    this.event = this.app.workspace.on("active-leaf-change", () => {
      const path = this.app.workspace.getActiveFile()?.path;
      if (path !== this.activePath) this.refresh();
    });
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
    this.controller?.abort();
    for (const request of this.contextRequests.values()) request.abort();
    this.contextRequests.clear();
    this.controller = undefined;
  }
  private refresh(pathOverride?: string | null): void {
    const path =
      pathOverride === undefined
        ? ((this.app as any)?.workspace?.getActiveFile?.()?.path as string | undefined)
        : (pathOverride ?? undefined);
    this.activePath = path && path.toLowerCase().endsWith(".md") ? path : undefined;
    this.cancel();
    this.hits = [];
    this.available = false;
    this.error = false;
    if (!this.activePath || !this.related || this.status.kind === "building") {
      this.render();
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    void this.related
      .related(this.activePath, controller.signal, 20)
      .then((result) => {
        if (controller.signal.aborted) return;
        this.hits = result.hits;
        this.available = result.available;
        this.controller = undefined;
        this.render();
      })
      .catch(() => {
        if (controller.signal.aborted) return;
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
    if (!this.hits.length) {
      root.createDiv({ text: "No related notes found." });
      return;
    }
    const hits = this.hits.filter(
      (hit) => hit.path && hit.path !== this.activePath && this.app.vault.getFileByPath(hit.path)
    );
    if (!hits.length) {
      root.createDiv({ text: "No related notes found." });
      return;
    }
    const resultGroup = root.createDiv({ cls: "trama-note-results" });
    const resultsInfo = resultGroup.createDiv({ cls: "search-results-info" });
    resultsInfo.createDiv({
      cls: "search-results-result-count",
      text: `${hits.length} related ${hits.length === 1 ? "note" : "notes"}`,
    });
    const rows = resultGroup.createDiv({
      cls: "search-result-container mod-global-search trama-filo__rows",
    });
    for (const hit of hits) {
      const path = hit.path;
      appendNoteResultRow(
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
        hit.score,
        (expanded, metadata) => {
          this.contextRequests.get(path)?.abort();
          this.contextRequests.delete(path);
          metadata.empty();
          if (!expanded || !this.related) return;
          const controller = new AbortController();
          this.contextRequests.set(path, controller);
          const detail = metadata.createDiv({
            cls: "trama-note-result__evidence",
            attr: { "aria-live": "polite" },
          });
          detail.textContent = "Loading preview…";
          void this.related
            .searchEvidence({ ...hit, evidence: undefined }, controller.signal)
            .then((result) => {
              if (!controller.signal.aborted && detail.isConnected)
                renderResultContext(detail, result);
            })
            .catch(() => {
              if (!controller.signal.aborted && detail.isConnected)
                detail.textContent = "Preview unavailable. Open note.";
            });
        },
        undefined,
        "note"
      );
    }
  }
}
