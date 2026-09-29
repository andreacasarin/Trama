import { TFile } from "obsidian";
import type { IndexVaultDocument, IndexVaultPort } from "@/index/IndexManager";

/** The plugin-owned distinction between base visibility and index eligibility. */
export interface ObsidianIndexEligibility {
  readonly isBaseVisible: (path: string) => boolean;
  readonly isIndexEligible: (path: string) => boolean;
}

/** Reads complete Markdown notes for indexing. */
export class ObsidianIndexVault implements IndexVaultPort {
  private readonly isBaseVisible: (path: string) => boolean;
  private readonly indexEligibility: (path: string) => boolean;

  constructor(
    private readonly vault: {
      getMarkdownFiles(): TFile[];
      getFileByPath(path: string): TFile | null;
      read(file: TFile): Promise<string>;
    },
    visibility: ((path: string) => boolean) | ObsidianIndexEligibility,
    isIndexEligible?: (path: string) => boolean
  ) {
    if (typeof visibility === "function") {
      this.isBaseVisible = visibility;
      this.indexEligibility = isIndexEligible ?? visibility;
    } else {
      this.isBaseVisible = visibility.isBaseVisible;
      this.indexEligibility = visibility.isIndexEligible;
    }
  }
  isIndexEligible(path: string): boolean {
    return this.isBaseVisible(path) && this.indexEligibility(path);
  }
  async listMarkdownPaths(signal: AbortSignal): Promise<readonly string[]> {
    if (signal.aborted) throw new Error("Operation cancelled");
    return this.vault
      .getMarkdownFiles()
      .map((file) => file.path)
      .filter((path) => this.isIndexEligible(path));
  }
  async readMarkdown(path: string, signal: AbortSignal): Promise<IndexVaultDocument> {
    if (signal.aborted) throw new Error("Operation cancelled");
    const file = this.vault.getFileByPath(path);
    if (!file || !this.isIndexEligible(path))
      throw new Error(`Markdown note is unavailable: ${path}`);
    const content = await this.vault.read(file);
    return { path, content };
  }

  async isMarkdownAvailable(path: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) throw new Error("Operation cancelled");
    return this.isIndexEligible(path) && this.vault.getFileByPath(path) !== null;
  }
}
