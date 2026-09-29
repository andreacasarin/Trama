import type { IndexFreshness } from "@/domain/contracts";
import type { TramaDiagnostics } from "@/diagnostics/TramaDiagnostics";
import {
  emitTramaDiagnostic,
  NOOP_TRAMA_DIAGNOSTICS,
  projectDiagnosticError,
  startDiagnosticTimer,
} from "@/diagnostics/TramaDiagnostics";
import type { LenteNoteStatPort } from "@/vault/readOnly/ObsidianLenteNoteStats";
import {
  searchVault,
  type VaultRetrievalPort,
  type VaultSearchHit,
  type VaultSearchMethod,
  type VaultSearchMode,
} from "@/index/VaultSearch";

export type LenteSort = "relevant" | "updated";
export type LenteRetrievalMode = VaultSearchMode;
export type LenteSearchMethod = VaultSearchMethod;

export interface LenteSearchOptions {
  readonly searchMethod?: LenteSearchMethod;
  readonly sort?: LenteSort;
  readonly signal?: AbortSignal;
}

export type LenteHit = VaultSearchHit;

export interface LenteResult {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly excerpt: string;
  readonly generationId?: string;
  readonly changeCounter?: number;
  readonly chunkId: string;
  readonly ordinal: number;
  readonly mtime: number | null;
  readonly semanticScore?: number;
  readonly lexicalScore?: number;
  readonly fusedScore: number;
}

export interface LenteBatch {
  readonly generationId?: string;
  readonly changeCounter?: number;
  readonly mode: LenteRetrievalMode;
  readonly degraded: boolean;
  /** Why hybrid retrieval was reduced to lexical-only results, when applicable. */
  readonly degradationReason?: "semantic-unavailable" | "query-embedding-failed";
  readonly freshness?: IndexFreshness;
  readonly publicationId?: string;
  readonly displayLimit: number;
  readonly semanticPartial?: boolean;
  readonly results: readonly LenteResult[];
  /** Full deterministic candidate pool retained for local sort/display projection. */
  readonly canonicalResults?: readonly LenteResult[];
  readonly durationMs: number;
}

const MAX_CANDIDATES = 160;
const MAX_RESULTS = 20;

/** Hybrid vault search orchestration. It carries no provider or storage types. */
export class LenteSearch {
  static readonly MAX_CANDIDATES = MAX_CANDIDATES;
  static readonly MAX_RESULTS = MAX_RESULTS;

  constructor(
    private readonly retrieval: VaultRetrievalPort,
    private readonly stats: LenteNoteStatPort,
    private readonly diagnostics: TramaDiagnostics = NOOP_TRAMA_DIAGNOSTICS
  ) {}

  async search(query: string, options: LenteSearchOptions = {}): Promise<LenteBatch> {
    const elapsedMs = startDiagnosticTimer();
    const displayLimit = MAX_RESULTS;
    let mode: LenteRetrievalMode = options.searchMethod === "keyword" ? "lexical" : "hybrid";
    try {
      const {
        hits: raw,
        state,
        degraded,
        degradationReason,
        mode: effectiveMode,
      } = await searchVault(this.retrieval, query, options);
      mode = effectiveMode;
      const generationId = raw[0]?.generationId ?? state.generationId;
      const changeCounter = raw[0]?.changeCounter ?? state.changeCounter;
      const canonicalResults = selectLenteResults(
        raw,
        generationId,
        (path) => this.stats.getMtime(path),
        "relevant",
        MAX_CANDIDATES
      );
      const results = sortLenteResults(canonicalResults, options.sort ?? "relevant", displayLimit);
      const batch = {
        generationId,
        changeCounter,
        mode,
        degraded,
        ...(degradationReason ? { degradationReason } : {}),
        ...(state.freshness ? { freshness: state.freshness } : {}),
        ...(state.semantic.state === "partial" ? { semanticPartial: true } : {}),
        ...(state.publicationId ? { publicationId: state.publicationId } : {}),
        displayLimit,
        results,
        canonicalResults,
        durationMs: elapsedMs(),
      } as const;
      emitTramaDiagnostic(this.diagnostics, {
        area: "index",
        event: "lente_search",
        generation: generationId,
        mode,
        resultCount: results.length,
        durationMs: batch.durationMs,
      } as never);
      return batch;
    } catch (error) {
      emitTramaDiagnostic(this.diagnostics, {
        area: "index",
        event: "lente_search",
        generation: this.retrieval.vaultSearchState()?.generationId,
        mode,
        resultCount: 0,
        durationMs: elapsedMs(),
        cancelled: isCancelled(error),
        error: projectDiagnosticError(error),
      } as never);
      throw error;
    }
  }
}

function isCancelled(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    ((error as { code?: unknown }).code === "cancelled" ||
      (error as { cancelled?: unknown }).cancelled === true)
  );
}

/** Pure, deterministic note collapse and ordering used by the service and tests. */
export function selectLenteResults(
  raw: readonly LenteHit[],
  generationId: string,
  getMtime: (path: string) => number | null,
  sort: LenteSort = "relevant",
  limit = MAX_RESULTS
): LenteResult[] {
  const byPath = new Map<string, LenteResult>();
  for (const result of raw) {
    if (result.generationId !== undefined && result.generationId !== generationId) continue;
    const mtime = getMtime(result.path);
    if (mtime === null) continue;
    const enriched: LenteResult = { ...result, excerpt: plainExcerpt(result.excerpt), mtime };
    const current = byPath.get(result.path);
    if (!current || compareRelevant(enriched, current) < 0) byPath.set(result.path, enriched);
  }
  return sortLenteResults([...byPath.values()], sort, limit);
}

/** Sorts an already enriched candidate pool without mutating it. */
export function sortLenteResults(
  results: readonly LenteResult[],
  sort: LenteSort = "relevant",
  limit = MAX_RESULTS
): LenteResult[] {
  return [...results]
    .sort(sort === "updated" ? compareUpdated : compareRelevant)
    .slice(0, Math.max(0, Math.min(MAX_CANDIDATES, limit)));
}

function plainExcerpt(value: string): string {
  return value
    .replace(/!?(\[[^\]]*\])\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|#^]+)(?:[#^][^\]|]+)?(?:\|([^\]]+))?\]\]/g, "$2$1")
    .replace(/[`*_~>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compareRelevant(
  a: Pick<
    LenteResult,
    "fusedScore" | "semanticScore" | "lexicalScore" | "path" | "ordinal" | "chunkId"
  >,
  b: Pick<
    LenteResult,
    "fusedScore" | "semanticScore" | "lexicalScore" | "path" | "ordinal" | "chunkId"
  >
): number {
  return (
    b.fusedScore - a.fusedScore ||
    optionalScore(b.semanticScore) - optionalScore(a.semanticScore) ||
    optionalScore(b.lexicalScore) - optionalScore(a.lexicalScore) ||
    codeUnits(a.path, b.path) ||
    a.ordinal - b.ordinal ||
    codeUnits(a.chunkId, b.chunkId)
  );
}
function compareUpdated(a: LenteResult, b: LenteResult): number {
  return (b.mtime ?? -Infinity) - (a.mtime ?? -Infinity) || compareRelevant(a, b);
}
function optionalScore(value: number | undefined): number {
  return value ?? -Infinity;
}
function codeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
