import { TFile } from "obsidian";
import type { IndexVaultDocument, IndexVaultPort } from "@/index/IndexManager";
import { chunkMarkdown } from "@/index/chunking";

const ESTIMATE_SAMPLE_LIMIT = 32;

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

  async estimateMarkdownTextCount(
    paths: readonly string[],
    chunkSize: number,
    overlap: number,
    signal: AbortSignal
  ): Promise<number> {
    if (signal.aborted) throw new Error("Operation cancelled");
    const stride = Math.max(1, chunkSize - overlap);
    const entries = paths
      .map((path) => ({
        path,
        file: this.vault.getFileByPath(path),
      }))
      .map(({ path, file }) => ({
        path,
        file,
        bytes: Math.max(0, Number((file as TFile | null)?.stat?.size ?? 0)),
      }))
      .filter((entry): entry is { path: string; file: TFile; bytes: number } => entry.file !== null)
      .sort((a, b) => a.bytes - b.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const metadataEstimate = entries.reduce(
      (total, entry) =>
        total + (entry.bytes > 0 ? Math.max(1, Math.ceil(entry.bytes / stride)) : 0),
      0
    );
    if (entries.length === 0 || metadataEstimate === 0) return 0;

    const sampleCount = Math.min(ESTIMATE_SAMPLE_LIMIT, entries.length);
    const sampleIndices = new Set<number>();
    for (let i = 0; i < sampleCount; i++)
      sampleIndices.add(
        sampleCount === 1 ? 0 : Math.round((i * (entries.length - 1)) / (sampleCount - 1))
      );
    let sampledMetadata = 0;
    let sampledActual = 0;
    for (const index of sampleIndices) {
      if (signal.aborted) throw new Error("Operation cancelled");
      const entry = entries[index];
      try {
        const content = await this.vault.read(entry.file);
        sampledMetadata +=
          entry.bytes > 0 ? Math.max(1, Math.ceil(entry.bytes / stride)) : content ? 1 : 0;
        sampledActual += chunkMarkdown(content, chunkSize, overlap, signal).length;
      } catch {
        if (signal.aborted) throw new Error("Operation cancelled");
        // A sampled note may move during estimation. The full build handles it
        // through its normal unavailable-note reconciliation path.
      }
    }
    if (sampledMetadata === 0) return metadataEstimate;
    return Math.max(0, Math.round(metadataEstimate * (sampledActual / sampledMetadata)));
  }
}
