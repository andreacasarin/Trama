import { setTooltip, type App } from "obsidian";

export function appendNoteEditDate(parent: HTMLElement, app: App, path: string): void {
  const file = app?.vault?.getFileByPath?.(path);
  const timestamp = file?.stat?.mtime;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return;

  const date = new Date(timestamp);
  const short = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
  const exact = new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  }).format(date);
  const label = parent.createDiv({
    cls: "setting-item-description trama-result-date",
    text: `Edited ${short}`,
  });
  label.setAttribute("aria-label", `Last edited ${exact}`);
  setTooltip(label, exact);
}
