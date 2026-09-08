import type { CorpusSnapshot } from "@/index/corpus/CorpusStore";

export interface VectorSearchHit {
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
}

export interface VectorIndex {
  readonly snapshot: CorpusSnapshot;
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
