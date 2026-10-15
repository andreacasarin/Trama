import { setIcon, setTooltip, type App, type HoverParent } from "obsidian";
import { appendNoteEditDate } from "@/ui/noteEditDate";

let disclosureId = 0;
export const NOTE_RESULT_HOVER_SOURCE_ID = "trama-results";

export function appendNoteResultRow(
  parent: HTMLElement,
  app: App,
  path: string,
  hoverParent: HoverParent,
  onOpen: (event: MouseEvent) => void
): HTMLDivElement {
  const row = parent.createDiv({ cls: "trama-note-result" });
  const heading = row.createDiv({ cls: "trama-note-result__heading" });
  const metadataId = `trama-note-result-meta-${++disclosureId}`;
  const toggle = heading.createEl("button", {
    cls: "clickable-icon trama-note-result__toggle",
    attr: {
      type: "button",
      "aria-label": "Expand note details",
      "aria-expanded": "false",
      "aria-controls": metadataId,
    },
  });
  setIcon(toggle, "chevron-right");
  setTooltip(toggle, "Expand note details");
  const title = heading.createEl("a", {
    cls: "internal-link search-result-file-title trama-note-result__title",
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
  const metadata = row.createDiv({ cls: "trama-note-result__meta", attr: { id: metadataId } });
  metadata.hidden = true;
  metadata.createDiv({ cls: "trama-note-result__path", text: path });
  appendNoteEditDate(metadata, app, path);
  toggle.addEventListener("click", () => {
    metadata.hidden = !metadata.hidden;
    const expanded = !metadata.hidden;
    const label = `${expanded ? "Collapse" : "Expand"} note details`;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-label", label);
    setIcon(toggle, expanded ? "chevron-down" : "chevron-right");
    setTooltip(toggle, label);
  });
  return row;
}
