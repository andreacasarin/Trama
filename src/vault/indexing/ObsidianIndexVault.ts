import { TFile } from "obsidian";
import { IndexVaultDocument, IndexVaultPort } from "@/index/IndexManager";

/** Reads complete Markdown notes for indexing. */
export class ObsidianIndexVault implements IndexVaultPort {
  constructor(
    private readonly vault: {
      getMarkdownFiles(): TFile[];
      getFileByPath(path: string): TFile | null;
      read(file: TFile): Promise<string>;
    },
    private readonly isVisible: (path: string) => boolean
  ) {}
  async listMarkdownPaths(signal: AbortSignal): Promise<readonly string[]> {
    if (signal.aborted) throw new Error("Operation cancelled");
    return this.vault
      .getMarkdownFiles()
      .map((file) => file.path)
      .filter(this.isVisible);
  }
  async readMarkdown(path: string, signal: AbortSignal): Promise<IndexVaultDocument> {
    if (signal.aborted) throw new Error("Operation cancelled");
    const file = this.vault.getFileByPath(path);
    if (!file || !this.isVisible(path)) throw new Error(`Markdown note is unavailable: ${path}`);
    const content = await this.vault.read(file);
    return { path, content };
  }
}
