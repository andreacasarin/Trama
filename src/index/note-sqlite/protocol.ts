export type NoteVector = readonly number[];

export const EMBEDDING_ARTIFACT_MAX_ENTRIES = 128;
export const EMBEDDING_ARTIFACT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const EMBEDDING_ARTIFACT_MAX_VECTOR_BYTES = EMBEDDING_ARTIFACT_MAX_FILE_BYTES - 128 * 1024;

export interface SqliteEmbeddingShard {
  readonly bytes: Uint8Array;
  readonly hashes: readonly string[];
}

export interface SqliteConnection {
  exec(
    options:
      | string
      | {
          readonly sql: string;
          readonly bind?: readonly unknown[];
          readonly rowMode?: "object";
          readonly callback?: (row: Record<string, unknown>) => void;
        }
  ): void;
  close(): void;
}

export interface NoteStoreHit {
  readonly path: string;
  readonly score: number;
  readonly lexicalScore?: number;
  readonly semanticScore?: number;
}

export interface NoteStoreHybridResult {
  readonly hits: readonly NoteStoreHit[];
  readonly mode: "hybrid" | "lexical";
  readonly degraded: boolean;
  readonly degradationReason?: "semantic-unavailable";
}

export interface NoteStoreRelatedResult {
  readonly hits: readonly NoteStoreHit[];
  readonly available: boolean;
}

export interface NoteSourceRevision {
  readonly path: string;
  readonly revision: string;
}

export interface NoteStoreRpc {
  noteStoreCheckSources: {
    readonly sources: readonly NoteSourceRevision[];
    readonly profile: string;
  };
  noteStoreRememberSources: {
    readonly sources: readonly NoteSourceRevision[];
    readonly profile: string;
  };
  embeddingCacheGet: {
    readonly profile: string;
    readonly task: "document" | "query";
    readonly hashes: readonly string[];
    readonly now: number;
  };
  embeddingCacheSet: {
    readonly profile: string;
    readonly task: "document" | "query";
    readonly dimensions: number;
    readonly entries: readonly { readonly hash: string; readonly vector: Uint8Array }[];
    readonly now: number;
  };
  embeddingCacheDelete: {
    readonly profile: string;
    readonly task: "document" | "query";
    readonly hashes: readonly string[];
  };
  embeddingCacheKeys: {
    readonly profile: string;
    readonly task: "document" | "query";
    readonly after?: string;
    readonly limit: number;
  };
  embeddingCacheSqliteCheckArtifacts: {
    readonly profile: string;
    readonly checksums: readonly string[];
  };
  embeddingCacheSqliteReconcile: {
    readonly profile: string;
    readonly checksums: readonly string[];
  };
  embeddingCacheSqliteImport: {
    readonly profile: string;
    readonly checksum: string;
    readonly dimensions: number;
    readonly bytes: Uint8Array;
    readonly now: number;
  };
  embeddingCacheSqliteExport: {
    readonly profile: string;
    readonly dimensions: number;
    readonly limit: number;
  };
  embeddingCacheSqliteMarkPublished: {
    readonly profile: string;
    readonly checksum: string;
    readonly hashes: readonly string[];
    readonly now: number;
  };
  noteStoreReplace: {
    readonly uid: string;
    readonly path: string;
    readonly profile: string | null;
    readonly markdown: string;
    readonly vectors: readonly NoteVector[];
  };
  noteStoreDelete: { readonly uids: readonly string[] };
  noteStoreReset: Record<string, never>;
  noteStoreClear: Record<string, never>;
  noteStoreHasNotes: Record<string, never>;
  recordManagerGetTime: Record<string, never>;
  recordManagerUpdate: {
    readonly keys: readonly string[];
    readonly groupIds?: readonly (string | null)[];
    readonly timeAtLeast?: number;
  };
  recordManagerExists: { readonly keys: readonly string[] };
  recordManagerListKeys: {
    readonly before?: number;
    readonly after?: number;
    readonly groupIds?: readonly (string | null)[];
    readonly limit: number;
  };
  recordManagerDeleteKeys: { readonly keys: readonly string[] };
  noteStoreSemantic: {
    readonly vector: NoteVector;
    readonly profile: string;
    readonly k: number;
  };
  noteStoreHybrid: {
    readonly query?: string;
    readonly vector?: NoteVector;
    readonly profile?: string;
    readonly k: number;
  };
  noteStoreRelated: {
    readonly sourcePath: string;
    readonly profile: string;
    readonly k: number;
  };
}

export type NoteStoreMethod = keyof NoteStoreRpc;

export interface NoteStoreInit {
  readonly namespace: string;
}

export type NoteStoreCall = <M extends NoteStoreMethod>(
  method: M,
  payload: NoteStoreRpc[M],
  signal?: AbortSignal
) => Promise<unknown>;
