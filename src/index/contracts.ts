/** Backend-neutral identity used to detect a retrieval view changing under a reader. */
export type IndexRevision = number | string;

export interface IndexVaultDocument {
  readonly path: string;
  readonly content: string;
  readonly revision?: string;
}

/** Minimal vault read port used by indexing; it deliberately has no Obsidian types. */
export interface IndexVaultPort {
  listMarkdownPaths(signal: AbortSignal): Promise<readonly string[]>;
  readMarkdown(path: string, signal: AbortSignal): Promise<IndexVaultDocument>;
  /** Live plugin-owned index eligibility; omitted by non-Obsidian test ports. */
  isIndexEligible?(path: string): boolean;
  isMarkdownAvailable?(path: string, signal: AbortSignal): Promise<boolean>;
  estimateMarkdownTextCount?(
    paths: readonly string[],
    chunkSize: number,
    overlap: number,
    signal: AbortSignal
  ): Promise<number | undefined>;
}

export interface IndexFingerprint {
  readonly embeddingBaseUrl: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly excludedPaths: readonly string[];
  readonly chunking: {
    readonly algorithmVersion: number;
    readonly size: number;
    readonly overlap: number;
  };
  readonly extractionVersion: number;
  readonly schemaVersion: number;
}

/** The note identity needed to derive canonical chunk IDs during hydration. */
export interface RetrievalNote {
  readonly path: string;
  readonly contentId: string;
  readonly chunkCount: number;
}

/** A row returned by a retrieval repository. Backend-specific storage fields stay out. */
export interface RetrievalChunk {
  readonly rowId?: string;
  readonly canonicalId?: string;
  readonly ordinal: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly vector?: ArrayLike<number>;
}

export interface RetrievalRow {
  readonly rowId?: string;
  readonly canonicalId?: string;
  readonly id?: string;
  readonly path: string;
  readonly ordinal: number;
}

/**
 * Mutable-reader contract for the one-index model. A row may disappear between
 * ranking and hydration; repositories return undefined for that case.
 */
export interface RetrievalRepository {
  readonly generationId: string;
  readonly revision: IndexRevision;
  readonly fingerprint: string;
  readonly notes: readonly RetrievalNote[];
  pin?(): RetrievalRepository;
  release?(): Promise<void>;
  getNote?(path: string): RetrievalNote | undefined;
  hydrateRow?(row: RetrievalRow): Promise<RetrievalChunk | undefined>;
  hydrateChunk?(row: RetrievalRow | string, ordinal?: number): Promise<RetrievalChunk | undefined>;
}
