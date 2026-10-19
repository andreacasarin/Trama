import { ButtonComponent, type App, type HoverParent } from "obsidian";
import { appendNoteEditDate } from "@/ui/noteEditDate";

let disclosureId = 0;
export const NOTE_RESULT_HOVER_SOURCE_ID = "trama-results";
const SIMILARITY_LEVELS = [
  { minimum: 0.85, label: "Very high" },
  { minimum: 0.7, label: "High" },
  { minimum: 0.5, label: "Medium" },
  { minimum: 0.3, label: "Low" },
] as const;
export function appendNoteResultRow(
  parent: HTMLElement,
  app: App,
  path: string,
  hoverParent: HoverParent,
  onOpen: (event: MouseEvent) => void,
  similarity?: unknown
): HTMLDivElement {
  const row = parent.createDiv({ cls: "tree-item search-result is-collapsed" });
  const heading = row.createDiv({ cls: "tree-item-self search-result-file-title is-clickable" });
  const metadataId = `trama-note-result-meta-${++disclosureId}`;
  const toggleComponent = new ButtonComponent(heading)
    .setIcon("right-triangle")
    .setTooltip("Expand note details");
  const toggle = toggleComponent.buttonEl;
  toggle.classList.add("clickable-icon", "tree-item-icon", "collapse-icon", "is-collapsed");
  toggle.classList.add("trama-note-result__toggle");
  toggle.setAttribute("type", "button");
  toggle.setAttribute("aria-label", "Expand note details");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", metadataId);
  const title = heading.createEl("a", {
    cls: "tree-item-inner trama-note-result__title",
    text: path.split("/").pop()?.replace(/\.md$/i, "") ?? path,
    attr: { href: path, "data-href": path },
  });
  title.addEventListener("click", (event) => {
    event.preventDefault();
    onOpen(event);
  });
  title.addEventListener("mouseover", (event) => {
    app.workspace.trigger("hover-link", {
      event,
      source: NOTE_RESULT_HOVER_SOURCE_ID,
      hoverParent,
      targetEl: title,
      linktext: path,
    });
  });
  const metadata = row.createDiv({ cls: "search-result-file-matches", attr: { id: metadataId } });
  metadata.hidden = true;
  const match = metadata.createDiv({ cls: "search-result-file-match" });
  match.createDiv({ text: path });
  appendNoteEditDate(match, app, path);
  let ratingLabel: string | undefined;
  if (typeof similarity === "number" && Number.isFinite(similarity)) {
    ratingLabel = SIMILARITY_LEVELS.find((level) => similarity >= level.minimum)?.label;
    ratingLabel ??= "Very low";
  }
  if (ratingLabel) {
    match.createDiv({
      cls: "setting-item-description",
      text: `Similarity: ${ratingLabel}`,
    });
  }
  toggleComponent.onClick(() => {
    metadata.hidden = !metadata.hidden;
    const expanded = !metadata.hidden;
    const label = `${expanded ? "Collapse" : "Expand"} note details`;
    row.classList.toggle("is-collapsed", !expanded);
    toggle.classList.toggle("is-collapsed", !expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-label", label);
    toggleComponent.setTooltip(label);
  });
  return row;
}
