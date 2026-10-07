import type { IndexCapabilities, IndexFreshness, IndexProgress } from "@/domain/contracts";
import type { SqliteWorkerClient, SqliteWorkerLike } from "@/index/sqlite/client";
import type { SqliteState } from "@/index/sqlite/protocol";

export interface IndexVaultDocument {
  readonly path: string;
  readonly content: string;
  readonly revision?: string;
}

export interface IndexVaultPort {
  listMarkdownPaths(signal: AbortSignal): Promise<readonly string[]>;
  readMarkdown(path: string, signal: AbortSignal): Promise<IndexVaultDocument>;
  isIndexEligible?(path: string): boolean;
  isMarkdownAvailable?(path: string, signal: AbortSignal): Promise<boolean>;
}

export interface IndexFingerprint {
  readonly embeddingBaseUrl: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly excludedPaths: readonly string[];
  readonly effectiveExcludedPaths?: readonly string[];
  readonly chunking: {
    readonly algorithmVersion: number;
    readonly size: number;
    readonly overlap: number;
  };
  readonly extractionVersion: number;
  readonly schemaVersion: number;
  readonly corpusFingerprint?: string;
  readonly embeddingFingerprint?: string;
}

export interface RelatedIndexHit {
  readonly path: string;
  readonly score: number;
  readonly similarity?: number;
  readonly excerpt?: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface RelatedIndexState {
  readonly changeCounter?: number;
  readonly generationId?: string;
  readonly currentPath: string;
  readonly contentHash: string;
  readonly semantic?: IndexCapabilities["semantic"];
  readonly freshness?: IndexFreshness;
}

export interface SnapshotDataAdapter {
  exists?(path: string): Promise<boolean>;
  read?(path: string): Promise<string>;
  mkdir?(path: string): Promise<void>;
  readBinary?(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, value: ArrayBuffer): Promise<void>;
  write?(path: string, value: string): Promise<void>;
}

export interface IndexSyncResult {
  readonly changed: boolean;
  readonly converged: boolean;
}

export type IndexPathMutation =
  | { readonly type: "upsert"; readonly path: string }
  | { readonly type: "delete"; readonly path: string }
  | { readonly type: "rename"; readonly from: string; readonly to: string };

export type IndexOperationName = "build" | "update" | "rebuild" | "prepare";

export class SemanticProviderError extends Error {
  constructor(cause: unknown) {
    super("Embedding provider request failed");
    this.name = "SemanticProviderError";
    Object.defineProperty(this, "cause", { value: cause, configurable: true });
  }
}

export interface IndexOperationResult {
  readonly operation: IndexOperationName;
  readonly changed: boolean;
  readonly converged: boolean;
  readonly state: SqliteState;
}

export interface SemanticPrepareResult extends IndexOperationResult {
  readonly stored: number;
  readonly skipped: number;
}

export interface IndexManagerOptions {
  readonly size?: number;
  readonly overlap?: number;
  readonly excludedPaths?: readonly string[];
  readonly publicationDirectory?: string;
  readonly prepareBatchSize?: number;
  readonly isIndexEligible?: (path: string) => boolean;
  readonly onProgress?: (progress: IndexProgress) => void;
  readonly worker?: SqliteWorkerLike;
  readonly workerFactory?: () => SqliteWorkerLike;
  readonly sqliteIdentity?: string | Promise<string>;
  readonly sqliteClient?: SqliteWorkerClient;
  readonly onSuccessfulOperation?: (result: IndexOperationResult) => void | Promise<void>;
}

export interface IndexJournalSnapshot {
  readonly changes: readonly IndexPathMutation[];
  readonly fullRecovery: boolean;
  readonly revision: number;
}

export interface VaultSearchState {
  readonly changeCounter: number;
  readonly generationId: string;
  readonly semantic: IndexCapabilities["semantic"];
  readonly freshness: IndexFreshness;
}
