import { ButtonComponent, type App, type HoverParent } from "obsidian";

let disclosureId = 0;
export const NOTE_RESULT_HOVER_SOURCE_ID = "trama-results";

const SIMILARITY_LEVELS = [
  { minimum: 0.85, label: "Very high" },
  { minimum: 0.7, label: "High" },
  { minimum: 0.5, label: "Medium" },
  { minimum: 0.3, label: "Low" },
] as const;
export function similarityLabel(similarity: unknown, lexicalScore?: unknown): string {
  if (typeof similarity === "number" && Number.isFinite(similarity))
    return SIMILARITY_LEVELS.find((level) => similarity >= level.minimum)?.label ?? "Very low";
  if (similarity == null && typeof lexicalScore === "number" && Number.isFinite(lexicalScore))
    return "Keyword match";
  return "Similarity unavailable";
}

export function appendSimilarityLabel(
  parent: HTMLElement,
  similarity: unknown,
  lexicalScore?: unknown,
  comparison: "query" | "note" = "query"
): void {
  const label = similarityLabel(similarity, lexicalScore);
  const span = parent.createSpan({ cls: "trama-note-result__similarity", text: label });
  if (label === "Keyword match")
    span.setAttribute("title", "Matched by keywords; semantic similarity is unavailable.");
  else
    span.setAttribute(
      "title",
      comparison === "query"
        ? "Similarity between the query and a passage in this note."
        : "Similarity between the current note and this note."
    );
}

export function configureNoteResultHover(
  title: HTMLElement,
  app: App,
  path: string,
  hoverParent: HoverParent
): void {
  title.addEventListener("mouseover", (event) => {
    app.workspace.trigger("hover-link", {
      event,
      source: NOTE_RESULT_HOVER_SOURCE_ID,
      hoverParent,
      targetEl: title,
      linktext: path,
    });
  });
}

export function appendNoteResultRow(
  parent: HTMLElement,
  app: App,
  path: string,
  hoverParent: HoverParent,
  onOpen: (event: MouseEvent) => void,
  similarity?: unknown,
  onDisclosure?: (expanded: boolean, metadata: HTMLElement) => void,
  lexicalScore?: unknown,
  comparison: "query" | "note" = "query"
): HTMLDivElement {
  const row = parent.createDiv({ cls: "tree-item search-result is-collapsed" });
  const heading = row.createDiv({ cls: "tree-item-self search-result-file-title is-clickable" });
  const title = heading.createEl("a", {
    cls: "tree-item-inner trama-note-result__title",
    text: path.split("/").pop()?.replace(/\.md$/i, "") ?? path,
    attr: { href: path, "data-href": path },
  });
  title.addEventListener("click", (event) => {
    event.preventDefault();
    onOpen(event);
  });
  configureNoteResultHover(title, app, path, hoverParent);
  appendSimilarityLabel(heading, similarity, lexicalScore, comparison);
  if (onDisclosure) {
    const metadataId = `trama-note-result-meta-${++disclosureId}`;
    const toggleComponent = new ButtonComponent(heading)
      .setIcon("right-triangle")
      .setTooltip("Expand note details");
    const toggle = toggleComponent.buttonEl;
    heading.insertBefore(toggle, title);
    toggle.classList.add("clickable-icon", "tree-item-icon", "collapse-icon", "is-collapsed");
    toggle.classList.add("trama-note-result__toggle");
    toggle.setAttribute("type", "button");
    toggle.setAttribute("aria-label", "Expand note details");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", metadataId);
    const metadata = row.createDiv({ cls: "search-result-file-matches", attr: { id: metadataId } });
    metadata.hidden = true;
    toggleComponent.onClick(() => {
      metadata.hidden = !metadata.hidden;
      const expanded = !metadata.hidden;
      const label = `${expanded ? "Collapse" : "Expand"} note details`;
      row.classList.toggle("is-collapsed", !expanded);
      toggle.classList.toggle("is-collapsed", !expanded);
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-label", label);
      toggleComponent.setTooltip(label);
      onDisclosure(expanded, metadata);
    });
  }
  return row;
}

export function renderResultContext(
  parent: HTMLElement,
  result: Awaited<ReturnType<import("@/index/VaultRetrieval").VaultRetrieval["searchEvidence"]>>
): void {
  parent.empty();
  if (result.kind === "empty") {
    const row = parent.closest(".tree-item");
    row?.querySelector(".trama-note-result__toggle")?.remove();
    parent.parentElement?.remove();
  } else if (result.kind === "changed" || result.kind === "unavailable") {
    parent.textContent =
      result.kind === "changed"
        ? "Note changed. Search again for an updated passage."
        : "Preview unavailable. Open note.";
  } else {
    parent.createDiv({
      text: result.kind === "passage" ? "Matched passage" : "Preview",
      cls: "setting-item-description",
    });
    parent.createEl("blockquote", { cls: "trama-note-result__quote", text: result.text });
  }
}
