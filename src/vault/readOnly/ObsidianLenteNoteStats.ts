import { TFile } from "obsidian";

/** Live, metadata-only note statistics for Lente sorting. */
export interface LenteNoteStatPort {
  getMtime(path: string): number | null;
  mtime?(path: string): number | null;
}

export class ObsidianLenteNoteStats implements LenteNoteStatPort {
  constructor(
    private readonly vault: Pick<{ getFileByPath(path: string): TFile | null }, "getFileByPath">
  ) {}

  getMtime(path: string): number | null {
    const file = this.vault.getFileByPath(path);
    const mtime = file?.stat?.mtime;
    return typeof mtime === "number" && Number.isFinite(mtime) ? mtime : null;
  }

  mtime(path: string): number | null {
    return this.getMtime(path);
  }
}
