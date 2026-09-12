import type { IndexRevision } from "@/index/contracts";

export interface VectorSearchHit {
  /** Backend row identity; unlike path/ordinal it remains stable during hydration. */
  readonly rowId?: string;
  /** Canonical content-addressed chunk identity, when the backend can expose it. */
  readonly canonicalId?: string;
  /** Legacy/backend identity retained during the transition. */
  readonly id: string;
  readonly path: string;
  readonly ordinal: number;
  readonly score: number;
}

export interface VectorSearchOptions {
  readonly signal?: AbortSignal;
  readonly limit?: number;
  readonly currentPath?: string;
  /** Alias accepted by backend callers that phrase this as an exclusion. */
  readonly excludePath?: string;
  /** Paths which are currently eligible for retrieval. */
  readonly visiblePaths?: ReadonlySet<string>;
  /** Optional visibility predicate for callers that do not maintain a set. */
  readonly isVisible?: (path: string) => boolean;
  /** Feature-specific path grouping used by Lente; defaults preserve chunk search. */
  readonly distinctPaths?: boolean;
}

export interface VectorIndex {
  /** Identity of the retrieval view represented by this index. */
  readonly generationId?: string;
  readonly revision?: IndexRevision;
  readonly fingerprint?: string;
  /** Dimension of committed vectors when the backend can expose it. */
  readonly dimensions?: number;
  search(
    vector: readonly number[],
    options?: VectorSearchOptions
  ): Promise<readonly VectorSearchHit[]>;
  search(
    vector: readonly number[],
    signal: AbortSignal,
    limit: number
  ): Promise<readonly VectorSearchHit[]>;
  close(): Promise<void>;
}
