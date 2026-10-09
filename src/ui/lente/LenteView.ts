import { ItemView, Keymap, WorkspaceLeaf } from "obsidian";
import type { Runnable } from "@langchain/core/runnables";
import type { VaultRetrievalInput, VaultRetrievalOutput } from "@/index/VaultRetrieval";
import { TRAMA_ICONS } from "@/ui/icons";
import type { IconName } from "obsidian";

export const LENTE_VIEW_TYPE = "trama-lente";
export type SearchRunnable = Pick<Runnable<VaultRetrievalInput, VaultRetrievalOutput>, "invoke">;

export class LenteView extends ItemView {
  private input!: HTMLInputElement;
  private status!: HTMLDivElement;
  private rows!: HTMLDivElement;
  private controller?: AbortController;
  private revision = 0;
  private submitted = "";
  private output?: VaultRetrievalOutput;
  private opened = false;
  constructor(
    leaf: WorkspaceLeaf,
    private search: SearchRunnable
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
  refreshSubmitted(): void {
    if (this.submitted && this.opened) void this.run(this.submitted);
  }
  override onOpen(): Promise<void> {
    this.opened = true;
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "trama-lente" });
    root.createEl("h1", { text: "Lente", cls: "trama-lente__title" });
    const form = root.createDiv({ cls: "trama-lente__form" });
    this.input = form.createEl("input", {
      attr: { type: "search", placeholder: "Search your vault", "aria-label": "Search your vault" },
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        this.submitted = this.input.value.trim();
        void this.run(this.submitted);
      }
      if (event.key === "Escape") {
        this.cancel();
        this.output = undefined;
        this.input.value = "";
        this.render();
      }
    });
    const button = form.createEl("button", { text: "Search", attr: { type: "button" } });
    button.addEventListener("click", () => {
      this.submitted = this.input.value.trim();
      void this.run(this.submitted);
    });
    this.status = root.createDiv({
      cls: "setting-item-description trama-lente__status",
      attr: { "aria-live": "polite" },
    });
    this.rows = root.createDiv({ cls: "trama-lente__rows" });
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
        { query, mode: "hybrid" },
        { signal: controller.signal }
      );
      if (revision !== this.revision || controller.signal.aborted) return;
      this.output = output;
      this.controller = undefined;
    } catch {
      if (revision !== this.revision || controller.signal.aborted) return;
      this.output = undefined;
      this.controller = undefined;
      this.status.textContent = "Search failed. Try again.";
    }
    this.render();
  }
  private render(): void {
    if (!this.status || !this.rows) return;
    this.rows.empty();
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
    this.status.textContent = output.status.degraded
      ? output.status.degradationReason === "query-embedding-failed"
        ? "Lexical results (query embedding failed)."
        : "Lexical results (semantic search unavailable)."
      : output.documents.length
        ? `${output.documents.length} notes`
        : "No matching notes found.";
    for (const document of output.documents) {
      const path = String(document.metadata.path ?? document.id ?? "");
      if (!path) continue;
      const link = this.rows.createEl("a", {
        cls: "internal-link trama-lente__link",
        text: path.split("/").pop()?.replace(/\.md$/i, "") ?? path,
        attr: { href: path },
      });
      link.addEventListener("click", (event) => {
        event.preventDefault();
        void (this.app as any).workspace.openLinkText(path, "", Keymap.isModEvent(event));
      });
      this.rows.createDiv({ cls: "setting-item-description trama-lente__path", text: path });
    }
  }
}
