import { TFile } from "obsidian";
import type { ManualIndexVault, ManualIndexNote } from "@/index/ManualIndex";

export class ObsidianIndexVault implements ManualIndexVault {
  constructor(
    private readonly vault: {
      getMarkdownFiles(): TFile[];
      getFileByPath(path: string): TFile | null;
      read(file: TFile): Promise<string>;
    },
    private readonly isEligible: (path: string) => boolean = () => true
  ) {}
  async listMarkdownPaths(signal: AbortSignal): Promise<readonly string[]> {
    if (signal.aborted) throw new DOMException("Indexing cancelled", "AbortError");
    return this.vault
      .getMarkdownFiles()
      .map((file) => file.path)
      .filter(this.isEligible);
  }
  async readMarkdown(path: string, signal: AbortSignal): Promise<ManualIndexNote> {
    if (signal.aborted) throw new DOMException("Indexing cancelled", "AbortError");
    const file = this.vault.getFileByPath(path);
    if (!file || !this.isEligible(path)) throw new Error(`Markdown note is unavailable: ${path}`);
    return { path, content: await this.vault.read(file) };
  }
  async isMarkdownAvailable(path: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) throw new DOMException("Indexing cancelled", "AbortError");
    return this.isEligible(path) && this.vault.getFileByPath(path) !== null;
  }
}
