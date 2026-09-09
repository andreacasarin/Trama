/** Typed provenance for failures at the query-embedding boundary only. */
export class QueryEmbeddingError extends Error {
  readonly name = "QueryEmbeddingError";
  readonly code = "query_embedding_failed" as const;
  constructor() {
    super("Query embedding is unavailable.");
  }
}

export function isQueryEmbeddingError(error: unknown): error is QueryEmbeddingError {
  return error instanceof QueryEmbeddingError;
}
