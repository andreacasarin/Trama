import { StructuredError, type IndexFreshness, type IndexChannelStatus } from "@/domain/contracts";
import { isQueryEmbeddingError } from "@/index/retrieval/QueryEmbeddingError";

export type VaultSearchMode = "hybrid" | "lexical";
export type VaultSearchMethod = "hybrid" | "keyword";

export interface VaultSearchHit {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly excerpt: string;
  readonly generationId?: string;
  readonly changeCounter?: number;
  readonly chunkId: string;
  readonly ordinal: number;
  readonly semanticScore?: number;
  readonly lexicalScore?: number;
  readonly fusedScore: number;
}

export interface VaultSearchState {
  readonly changeCounter: number;
  readonly generationId: string;
  readonly semantic: IndexChannelStatus;
  readonly freshness?: IndexFreshness;
}

export interface VaultRetrievalPort {
  vaultSearchState(): VaultSearchState | null;
  retrieveVaultCandidates(
    query: string,
    mode: VaultSearchMode,
    signal?: AbortSignal
  ): Promise<readonly VaultSearchHit[]>;
}

export interface VaultSearchResult {
  readonly hits: readonly VaultSearchHit[];
  readonly state: VaultSearchState;
  readonly mode: VaultSearchMode;
  readonly degraded: boolean;
  readonly degradationReason?: "semantic-unavailable" | "query-embedding-failed";
}

/** One search policy for Lente, the command palette, and Voce's vault_search tool. */
export async function searchVault(
  retrieval: VaultRetrievalPort,
  query: string,
  options: { readonly searchMethod?: VaultSearchMethod; readonly signal?: AbortSignal } = {}
): Promise<VaultSearchResult> {
  const normalized = query.trim();
  if (!normalized)
    throw new StructuredError("invalid_request", "Search query must not be empty.", false);
  if (options.signal?.aborted) throw new StructuredError("cancelled", "Search cancelled.", true);
  const state = retrieval.vaultSearchState();
  if (!state) throw new StructuredError("unavailable", "Lexical index is unavailable.", true);
  const method = options.searchMethod ?? "hybrid";
  let mode: VaultSearchMode = method === "keyword" ? "lexical" : "hybrid";
  let degraded = mode === "hybrid" && !state.semantic.searchable;
  let degradationReason: VaultSearchResult["degradationReason"] = degraded
    ? "semantic-unavailable"
    : undefined;
  if (degraded) mode = "lexical";
  let hits: readonly VaultSearchHit[];
  try {
    hits = await retrieval.retrieveVaultCandidates(normalized, mode, options.signal);
  } catch (error) {
    if (mode !== "hybrid" || options.signal?.aborted || !isQueryEmbeddingError(error)) throw error;
    mode = "lexical";
    degraded = true;
    degradationReason = "query-embedding-failed";
    hits = await retrieval.retrieveVaultCandidates(normalized, mode, options.signal);
  }
  if (options.signal?.aborted) throw new StructuredError("cancelled", "Search cancelled.", true);
  return { hits, state, mode, degraded, ...(degradationReason ? { degradationReason } : {}) };
}
