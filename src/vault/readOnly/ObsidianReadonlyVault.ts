import { noteCandidates } from "@/domain/notePaths";
import { MetadataCache, TFile, Vault, type CachedMetadata } from "obsidian";
import type { ReadonlyNote, ReadonlyVault, VaultLink } from "@/domain/vault";
import { StructuredError, checkAbort } from "@/domain/errors";

const MARKDOWN = /\.md$/i;

/** Provides read-only access to an Obsidian vault and never exposes its write APIs. */
export class ObsidianReadonlyVault implements ReadonlyVault {
  private readonly hidden: readonly string[];

  constructor(
    private readonly vault: Pick<Vault, "getFileByPath" | "read" | "configDir"> & {
      getMarkdownFiles?: () => readonly TFile[];
    },
    private readonly metadataCache: Pick<MetadataCache, "getFirstLinkpathDest" | "getFileCache">
  ) {
    this.hidden = [".trama", this.vault.configDir || ".obsidian"];
  }

  async readNote(path: string, signal: AbortSignal): Promise<ReadonlyNote> {
    checkAbort(signal);
    const normalized = this.normalizePath(path);
    const file = this.vault.getFileByPath(normalized);
    if (!file || !MARKDOWN.test(file.path)) throw new Error("Note not found");
    const content = await this.vault.read(file);
    checkAbort(signal);
    return {
      path: normalized,
      content,
      truncated: false,
      startLine: 1,
      endLine: content ? content.split("\n").length : 0,
    };
  }

  async resolveLink(
    link: string,
    sourcePath: string | null,
    signal: AbortSignal
  ): Promise<string | null> {
    checkAbort(signal);
    const clean = this.linkText(link).split("#", 1)[0].split("^", 1)[0].trim();
    if (sourcePath === null) {
      if (!clean) throw new Error("Invalid vault note name");
      const exact = MARKDOWN.test(clean) ? clean : `${clean}.md`;
      this.normalizePath(exact);
      const markdownFiles = this.vault.getMarkdownFiles?.() ?? [];
      const candidates = noteCandidates(
        clean,
        markdownFiles.filter((file) => !this.isHidden(file.path)).map((file) => file.path)
      );
      if (candidates.length > 1)
        throw new StructuredError(
          "invalid_request",
          `Ambiguous note name '${clean}'; candidates: ${candidates.join(", ")}`,
          false
        );
      return candidates[0] ? this.normalizePath(candidates[0]) : null;
    }
    const source = this.normalizePath(sourcePath);
    if (!clean) return source;
    const markdownFiles = this.vault.getMarkdownFiles?.() ?? [];
    const exact = MARKDOWN.test(clean) ? clean : `${clean}.md`;
    if (clean.includes("/")) {
      const exactPath = markdownFiles
        .filter((file) => !this.isHidden(file.path))
        .find((file) => file.path === exact)?.path;
      if (exactPath) return this.normalizePath(exactPath);
    }
    const destination = this.metadataCache.getFirstLinkpathDest(clean, source);
    if (!destination || !MARKDOWN.test(destination.path) || this.isHidden(destination.path))
      return null;
    return this.normalizePath(destination.path);
  }

  async resolveLinkDetails(link: string, sourcePath: string, signal: AbortSignal) {
    const source = this.normalizePath(sourcePath);
    const cache = this.metadataCache.getFileCache(this.vault.getFileByPath(source) as TFile);
    const text = this.linkText(link);
    const clean = text.split("#", 1)[0].split("^", 1)[0].trim();
    const cached = this.cachedLinks(cache).find(
      (item) => item.link === text || item.link === clean
    );
    return { path: await this.resolveLink(link, source, signal), ...this.linkRange(cached) };
  }

  async discoverLinks(
    path: string,
    signal: AbortSignal,
    maxLinks = Number.POSITIVE_INFINITY
  ): Promise<readonly VaultLink[]> {
    checkAbort(signal);
    const sourcePath = this.normalizePath(path);
    const file = this.vault.getFileByPath(sourcePath);
    if (!file) throw new Error("Note not found");
    const cache = this.metadataCache.getFileCache(file as TFile);
    const links = this.cachedLinks(cache);
    const output: VaultLink[] = [];
    for (const link of links.slice(0, Math.max(0, Math.floor(maxLinks)))) {
      checkAbort(signal);
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

  private linkText(link: string): string {
    const match = link.match(/^!?\[\[([^\]]+)\]\]$/);
    return match ? match[1].split("|", 1)[0].trim() : link;
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

  private cachedLinks(cache: CachedMetadata | null): readonly {
    link: string;
    position?: NonNullable<CachedMetadata["frontmatterPosition"]>;
  }[] {
    if (!cache) return [];
    const frontmatter = (cache.frontmatterLinks ?? []).map((reference) => ({
      link: reference.link,
      position: cache.frontmatterPosition,
    }));
    const body = [...(cache.links ?? []), ...(cache.embeds ?? [])].sort(
      (left, right) => left.position.start.offset - right.position.start.offset
    );
    return [...frontmatter, ...body];
  }
}
