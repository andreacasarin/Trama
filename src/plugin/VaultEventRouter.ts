import type { TAbstractFile } from "obsidian";
import type { IndexPathMutation } from "@/index/IndexManager";
import { isExcludedPath, type TramaSettings } from "@/settings/Settings";

interface VaultEventHost {
  getSettings(): TramaSettings;
  getConfigDirectory(): string;
  registerEvent(ref: any): void;
  notifyPublicationFileEvent(path: string): void;
  queueMutation(mutation: IndexPathMutation): void;
  requestFullRecovery(path?: string): void;
}

export class VaultEventRouter {
  private readonly refs: Array<{ unsubscribe?: () => void }> = [];

  constructor(private readonly host: VaultEventHost) {}

  register(vault: any): void {
    this.registerEvent(vault, "create", (file: TAbstractFile) =>
      this.handlePathEvent(file, "upsert")
    );
    this.registerEvent(vault, "modify", (file: TAbstractFile) =>
      this.handlePathEvent(file, "upsert")
    );
    this.registerEvent(vault, "delete", (file: TAbstractFile) =>
      this.handlePathEvent(file, "delete")
    );
    this.registerEvent(vault, "rename", (file: TAbstractFile, oldPath: string) => {
      if (typeof oldPath === "string") this.host.notifyPublicationFileEvent(oldPath);
      if (typeof file?.path === "string") this.host.notifyPublicationFileEvent(file.path);
      if (
        (typeof oldPath === "string" && this.isPublicationPath(oldPath)) ||
        (typeof file?.path === "string" && this.isPublicationPath(file.path))
      )
        return;
      if (
        !file ||
        typeof file.path !== "string" ||
        this.isFolder(file) ||
        typeof oldPath !== "string"
      ) {
        this.host.requestFullRecovery(file?.path);
        return;
      }
      const oldEligible = this.isMarkdownPath(oldPath) && this.isIndexEligible(oldPath);
      const newEligible = this.isMarkdownPath(file.path) && this.isIndexEligible(file.path);
      if (oldEligible && newEligible)
        this.host.queueMutation({ type: "rename", from: oldPath, to: file.path });
      else if (oldEligible) this.host.queueMutation({ type: "delete", path: oldPath });
      else if (newEligible) this.host.queueMutation({ type: "upsert", path: file.path });
    });
  }

  dispose(): void {
    for (const ref of this.refs) ref.unsubscribe?.();
    this.refs.length = 0;
  }

  isMarkdownPath(path: string): boolean {
    return /\.md$/i.test(path);
  }

  isPublicationPath(path: string): boolean {
    const directory = this.host.getSettings().publicationDirectory.replace(/\/$/, "");
    return path === directory || path.startsWith(`${directory}/`);
  }

  isIndexEligible(path: string): boolean {
    return (
      this.isVisibleMarkdown(path) &&
      !isExcludedPath(path, [
        ...this.host.getSettings().filo.excludedPaths,
        this.host.getSettings().publicationDirectory,
      ])
    );
  }

  isVisibleMarkdown(path: string): boolean {
    const configDir = this.host.getConfigDirectory().replace(/\/$/, "");
    return (
      /\.md$/i.test(path) &&
      !path.split("/").some((part) => part.startsWith(".")) &&
      !path.startsWith(`${configDir}/`) &&
      !path.startsWith(".trama/")
    );
  }

  private registerEvent(vault: any, event: string, callback: (...args: any[]) => void): void {
    const ref = vault.on(event, callback);
    this.refs.push(ref);
    this.host.registerEvent(ref);
  }

  private handlePathEvent(file: TAbstractFile | undefined, type: "upsert" | "delete"): void {
    if (!file || typeof file.path !== "string") {
      this.host.requestFullRecovery();
      return;
    }
    this.host.notifyPublicationFileEvent(file.path);
    if (this.isPublicationPath(file.path)) return;
    if (this.isFolder(file)) {
      this.host.requestFullRecovery(file.path);
      return;
    }
    if (!this.isMarkdownPath(file.path) || !this.isIndexEligible(file.path)) return;
    this.host.queueMutation({ type, path: file.path });
  }

  private isFolder(file: unknown): boolean {
    return Boolean(file && typeof file === "object" && Array.isArray((file as any).children));
  }
}
