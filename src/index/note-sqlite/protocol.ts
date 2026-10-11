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
  noteStoreReplace: {
    readonly uid: string;
    readonly path: string;
    readonly profile: string | null;
    readonly markdown: string;
    readonly vectors: readonly NoteVector[];
  };
  noteStoreDelete: { readonly uids: readonly string[] };
  noteStoreReset: Record<string, never>;
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
