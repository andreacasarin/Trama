export interface ProvenanceRecord {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}
export interface ReadonlyNote {
  readonly path: string;
  readonly content: string;
  readonly truncated?: boolean;
  readonly startLine?: number;
  readonly endLine?: number;
}
export interface VaultLink {
  readonly link: string;
  readonly targetPath: string | null;
  readonly sourcePath: string;
  readonly startLine?: number;
  readonly endLine?: number;
}
export interface ResolvedLink {
  readonly path: string | null;
  readonly startLine?: number;
  readonly endLine?: number;
}
export interface ReadonlyVault {
  readNote(path: string, signal: AbortSignal): Promise<ReadonlyNote>;
  resolveLink(link: string, sourcePath: string, signal: AbortSignal): Promise<string | null>;
  discoverLinks(
    path: string,
    signal: AbortSignal,
    maxLinks?: number
  ): Promise<readonly VaultLink[]>;
  resolveLinkDetails?(
    link: string,
    sourcePath: string,
    signal: AbortSignal
  ): Promise<ResolvedLink | null>;
}
