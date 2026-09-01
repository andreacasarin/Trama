import { MetadataCache, TFile, Vault, Workspace } from "obsidian";
import { ReadonlyNote, ReadonlyVault, StructuredError, VaultLink } from "@/domain/contracts";

export interface ReadLimits {
  readonly maxLines: number;
  readonly maxCharacters: number;
}

const DEFAULT_LIMITS: ReadLimits = { maxLines: 200, maxCharacters: 20_000 };
const MARKDOWN = /\.md$/i;

/** Provides bounded, read-only access to an Obsidian vault and never exposes its write APIs. */
export class ObsidianReadonlyVault implements ReadonlyVault {
  private readonly limits: ReadLimits;
  private readonly hidden: readonly string[];

  constructor(
    private readonly vault: Pick<Vault, "getFileByPath" | "read" | "configDir"> & {
      getMarkdownFiles?: () => readonly TFile[];
    },
    private readonly workspace: Pick<Workspace, "getActiveFile">,
    private readonly metadataCache: Pick<MetadataCache, "getFirstLinkpathDest" | "getFileCache">,
    limits: Partial<ReadLimits> = {}
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.hidden = [".local-vault-assistant", this.vault.configDir || ".obsidian"];
  }

  async currentNotePath(signal: AbortSignal): Promise<string | null> {
    this.checkCancelled(signal);
    return this.workspace.getActiveFile()?.path ?? null;
  }

  async currentNote(signal: AbortSignal): Promise<ReadonlyNote | null> {
    const path = await this.currentNotePath(signal);
    return path ? this.readNote(path, signal) : null;
  }

  async readNote(path: string, signal: AbortSignal): Promise<ReadonlyNote> {
    this.checkCancelled(signal);
    const normalized = this.normalizePath(path);
    const file = this.vault.getFileByPath(normalized);
    if (!file || !MARKDOWN.test(file.path)) throw new Error("Note not found");
    const content = await this.vault.read(file);
    this.checkCancelled(signal);
    const lines = content.split("\n");
    const lineLimited = lines.length > this.limits.maxLines;
    const selected = lines.slice(0, this.limits.maxLines).join("\n");
    const truncated = lineLimited || selected.length > this.limits.maxCharacters;
    const bounded = selected.slice(0, this.limits.maxCharacters);
    return {
      path: normalized,
      content: bounded,
      truncated,
      startLine: 1,
      endLine: bounded ? Math.min(this.limits.maxLines, bounded.split("\n").length) : 0,
    };
  }

  async resolveLink(link: string, sourcePath: string, signal: AbortSignal): Promise<string | null> {
    this.checkCancelled(signal);
    const source = this.normalizePath(sourcePath);
    const clean = link.split("#", 1)[0].split("^", 1)[0].trim();
    if (!clean) return source;
    const markdownFiles = this.vault.getMarkdownFiles?.() ?? [];
    const exact = clean.endsWith(".md") ? clean : `${clean}.md`;
    if (clean.includes("/")) {
      const exactPath = markdownFiles
        .filter((file) => !this.isHidden(file.path))
        .find((file) => file.path === exact)?.path;
      if (exactPath) return this.normalizePath(exactPath);
    } else {
      const candidates = markdownFiles
        .filter(
          (file) =>
            !this.isHidden(file.path) && file.name.toLowerCase() === `${clean.toLowerCase()}.md`
        )
        .map((file) => file.path);
      if (candidates.length > 1)
        throw new StructuredError(
          "invalid_request",
          `Ambiguous link '${clean}'; candidates: ${candidates.join(", ")}`,
          false
        );
    }
    const destination = this.metadataCache.getFirstLinkpathDest(clean, source);
    if (!destination || !MARKDOWN.test(destination.path) || this.isHidden(destination.path))
      return null;
    return this.normalizePath(destination.path);
  }

  async resolveLinkDetails(link: string, sourcePath: string, signal: AbortSignal) {
    const source = this.normalizePath(sourcePath);
    const cache = this.metadataCache.getFileCache(this.vault.getFileByPath(source) as TFile);
    const clean = link.split("#", 1)[0].split("^", 1)[0].trim();
    const cached = cache?.links?.find((item) => item.link === link || item.link === clean);
    return { path: await this.resolveLink(link, source, signal), ...this.linkRange(cached) };
  }

  async discoverLinks(
    path: string,
    signal: AbortSignal,
    maxLinks = Number.POSITIVE_INFINITY
  ): Promise<readonly VaultLink[]> {
    this.checkCancelled(signal);
    const sourcePath = this.normalizePath(path);
    const file = this.vault.getFileByPath(sourcePath);
    if (!file) throw new Error("Note not found");
    const cache = this.metadataCache.getFileCache(file as TFile);
    const links = cache?.links ?? [];
    const output: VaultLink[] = [];
    for (const link of links.slice(0, Math.max(0, Math.floor(maxLinks)))) {
      this.checkCancelled(signal);
      output.push({
        link: link.link,
        sourcePath,
        targetPath: await this.resolveLink(link.link, sourcePath, signal),
        ...this.linkRange(link),
      });
    }
    return output;
  }

  private normalizePath(path: string): string {
    if (
      typeof path !== "string" ||
      !path.trim() ||
      path.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(path)
    )
      throw new Error("Invalid vault path");
    const parts: string[] = path.replace(/\\/g, "/").split("/");
    if (parts.some((part: string) => part === ".."))
      throw new Error("Path traversal is not allowed");
    const normalized = parts.filter(Boolean).join("/");
    if (!MARKDOWN.test(normalized) || this.isHidden(normalized))
      throw new Error("Path is not an accessible Markdown note");
    return normalized;
  }

  private isHidden(path: string): boolean {
    return (
      path.split("/").some((part) => part.startsWith(".")) ||
      this.hidden.some((folder) => path === folder || path.startsWith(`${folder}/`))
    );
  }

  private linkRange(
    link:
      | {
          position?: { start?: { line?: number }; end?: { line?: number } };
        }
      | undefined
  ) {
    const startLine = link?.position?.start?.line;
    const endLine = link?.position?.end?.line;
    return startLine === undefined
      ? {}
      : { startLine: startLine + 1, endLine: (endLine ?? startLine) + 1 };
  }

  private checkCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new Error("Operation cancelled");
  }
}
