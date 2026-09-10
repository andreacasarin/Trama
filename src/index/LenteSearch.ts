import { StructuredError } from "@/domain/contracts";
import type { TramaDiagnostics } from "@/diagnostics/TramaDiagnostics";
import {
  emitTramaDiagnostic,
  NOOP_TRAMA_DIAGNOSTICS,
  projectDiagnosticError,
  startDiagnosticTimer,
} from "@/diagnostics/TramaDiagnostics";
import type { LenteNoteStatPort } from "@/vault/readOnly/ObsidianLenteNoteStats";
import { isQueryEmbeddingError } from "@/index/retrieval/QueryEmbeddingError";

export type LenteSort = "relevant" | "updated";
export type LenteRetrievalMode = "hybrid" | "lexical";
export type LenteSearchMethod = "hybrid" | "keyword";

export interface LenteSearchOptions {
  readonly searchMethod?: LenteSearchMethod;
  readonly maxResults?: number;
  readonly sort?: LenteSort;
  readonly signal?: AbortSignal;
}

export interface LenteRetrievalPort {
  acquireLenteLease(): LenteRetrievalLease | null;
}

export interface LenteRetrievalLease {
  readonly generationId: string;
  readonly retriever?: {
    search(request: {
      query: string;
      mode: LenteRetrievalMode;
      resultShape: "notes";
      limit: number;
      semanticCandidateLimit: number;
      lexicalCandidateLimit: number;
      lexicalProfile: "lente";
      feature: "lente";
      signal?: AbortSignal;
    }): Promise<readonly LenteHit[]>;
  };
  search?(
    query: string,
    mode: LenteRetrievalMode,
    signal?: AbortSignal
  ): Promise<readonly LenteHit[]>;
  release(): Promise<void>;
}

export interface LenteHit {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly excerpt: string;
  readonly generationId: string;
  readonly chunkId: string;
  readonly ordinal: number;
  readonly semanticScore?: number;
  readonly lexicalScore?: number;
  readonly fusedScore: number;
}

export interface LenteResult {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly excerpt: string;
  readonly generationId: string;
  readonly chunkId: string;
  readonly ordinal: number;
  readonly mtime: number | null;
  readonly semanticScore?: number;
  readonly lexicalScore?: number;
  readonly fusedScore: number;
}

export interface LenteBatch {
  readonly generationId: string;
  readonly mode: LenteRetrievalMode;
  readonly degraded: boolean;
  readonly displayLimit: number;
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
    private readonly retrieval: LenteRetrievalPort,
    private readonly stats: LenteNoteStatPort,
    private readonly diagnostics: TramaDiagnostics = NOOP_TRAMA_DIAGNOSTICS
  ) {}

  async search(query: string, options: LenteSearchOptions = {}): Promise<LenteBatch> {
    const normalized = query.trim();
    if (!normalized)
      throw new StructuredError("invalid_request", "Search query must not be empty.", false);
    const elapsedMs = startDiagnosticTimer();
    const signal = options.signal;
    if (signal?.aborted) throw new StructuredError("cancelled", "Search cancelled.", true);
    const lease = this.retrieval.acquireLenteLease();
    if (!lease) throw new StructuredError("unavailable", "Semantic index is unavailable.", true);
    const method = options.searchMethod ?? "hybrid";
    const displayLimit = appliedDisplayLimit(options.maxResults);
    let mode: LenteRetrievalMode = method === "keyword" ? "lexical" : "hybrid";
    let degraded = false;
    try {
      let raw: readonly LenteHit[];
      try {
        raw = await this.retrieve(lease, normalized, mode, signal);
      } catch (error) {
        if (mode !== "hybrid" || !this.canFallback(error, signal)) throw error;
        mode = "lexical";
        degraded = true;
        raw = await this.retrieve(lease, normalized, "lexical", signal);
      }
      if (signal?.aborted) throw new StructuredError("cancelled", "Search cancelled.", true);
      const canonicalResults = selectLenteResults(
        raw,
        lease.generationId,
        (path) => this.stats.getMtime(path),
        "relevant",
        MAX_CANDIDATES
      );
      const results = sortLenteResults(canonicalResults, options.sort ?? "relevant", displayLimit);
      const batch = {
        generationId: lease.generationId,
        mode,
        degraded,
        displayLimit,
        results,
        canonicalResults,
        durationMs: elapsedMs(),
      } as const;
      emitTramaDiagnostic(this.diagnostics, {
        area: "index",
        event: "lente_search",
        generation: lease.generationId,
        mode,
        resultCount: results.length,
        durationMs: batch.durationMs,
      } as never);
      return batch;
    } catch (error) {
      emitTramaDiagnostic(this.diagnostics, {
        area: "index",
        event: "lente_search",
        generation: lease.generationId,
        mode,
        resultCount: 0,
        durationMs: elapsedMs(),
        cancelled: isCancelled(error),
        error: projectDiagnosticError(error),
      } as never);
      throw error;
    } finally {
      await lease.release();
    }
  }

  private canFallback(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return false;
    if (!error || typeof error !== "object") return false;
    return isQueryEmbeddingError(error);
  }

  private retrieve(
    lease: LenteRetrievalLease,
    query: string,
    mode: LenteRetrievalMode,
    signal?: AbortSignal
  ): Promise<readonly LenteHit[]> {
    if (lease.search) return lease.search(query, mode, signal);
    if (lease.retriever)
      return lease.retriever.search({
        query,
        mode,
        resultShape: "notes",
        limit: MAX_CANDIDATES,
        semanticCandidateLimit: MAX_CANDIDATES,
        lexicalCandidateLimit: MAX_CANDIDATES,
        lexicalProfile: "lente",
        feature: "lente",
        signal,
      });
    return Promise.reject(new Error("Lente retrieval lease is invalid."));
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

function appliedDisplayLimit(value: number | undefined): number {
  return Number.isSafeInteger(value)
    ? Math.max(0, Math.min(MAX_CANDIDATES, value as number))
    : MAX_RESULTS;
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
    if (result.generationId !== generationId) continue;
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
