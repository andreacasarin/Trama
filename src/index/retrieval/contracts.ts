/** Hydrated retrieval evidence exposed to the UI and tool boundaries. */
export interface RetrievalResult {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly excerpt: string;
  /** Cache identity retained for display/cache invalidation, never publication state. */
  readonly generationId: string;
  readonly changeCounter?: number;
  readonly chunkId: string;
  readonly semanticScore?: number;
  readonly lexicalScore?: number;
  readonly fusedScore: number;
  readonly ordinal: number;
  readonly chunks?: readonly RetrievalResult[];
}
