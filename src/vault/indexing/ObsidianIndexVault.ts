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
  getRevision(path: string): string | undefined {
    const stat = this.vault.getFileByPath(path)?.stat;
    return stat &&
      Number.isFinite(stat.mtime) &&
      Number.isFinite(stat.ctime) &&
      Number.isFinite(stat.size)
      ? `${stat.mtime}:${stat.ctime}:${stat.size}`
      : undefined;
  }
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
    const before = this.getRevision(path);
    const content = await this.vault.read(file);
    const revision = before === this.getRevision(path) ? before : undefined;
    return { path, content, ...(revision === undefined ? {} : { revision }) };
  }
}
