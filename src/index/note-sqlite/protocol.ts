export type NoteVector = readonly number[];

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

export interface NoteStoreEntry {
  readonly hash: string;
  readonly profile: string | null;
  readonly chunkCount: number;
  readonly vectorCount: number;
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

export interface NoteStoreRpc {
  noteStoreGet: { readonly path: string };
  noteStoreReplace: {
    readonly path: string;
    readonly hash: string;
    readonly profile: string | null;
    readonly markdown: string;
    readonly vectors: readonly NoteVector[];
  };
  noteStoreDelete: { readonly paths: readonly string[] };
  noteStoreListPaths: { readonly afterPath?: string; readonly limit: number };
  noteStoreReset: Record<string, never>;
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
