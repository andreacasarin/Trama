import { StructuredError, type EmbeddingModel } from "@/domain/contracts";
import { compareCodeUnits } from "@/index/Ordering";
import { OramaProjection } from "@/index/orama/OramaProjection";
import type { OramaSearchHit } from "@/index/orama/OramaTypes";
import { QueryEmbeddingError, isQueryEmbeddingError } from "./QueryEmbeddingError";

export type RetrievalMode = "hybrid" | "semantic" | "related" | "lexical";
export type RetrievalShape = "chunks" | "notes";
export type LexicalProfile = "default" | "lente";

export { QueryEmbeddingError, isQueryEmbeddingError } from "./QueryEmbeddingError";

export interface RetrievalSnapshot {
  readonly projection: OramaProjection;
  readonly generationId: string;
  readonly fingerprint: string;
  close(): Promise<void>;
}

export interface RetrieverOptions {
  readonly projection: OramaProjection;
  readonly embedding?: Pick<EmbeddingModel, "embed"> & Partial<Pick<EmbeddingModel, "dimensions">>;
}

export interface RetrievalRequest {
  readonly query: string;
  readonly queryVector?: readonly number[];
  readonly mode?: RetrievalMode;
  readonly resultShape?: RetrievalShape;
  readonly limit?: number;
  readonly semanticCandidateLimit?: number;
  readonly lexicalCandidateLimit?: number;
  readonly lexicalProfile?: LexicalProfile;
  readonly feature?: "lente";
  readonly currentPath?: string | null;
  readonly excludePath?: string;
  readonly visiblePaths?: ReadonlySet<string> | readonly string[];
  readonly signal?: AbortSignal;
}

export interface RetrievalResult {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly excerpt: string;
  readonly generationId: string;
  readonly chunkId: string;
  readonly semanticScore?: number;
  readonly lexicalScore?: number;
  readonly fusedScore: number;
  readonly ordinal: number;
  readonly chunks?: readonly RetrievalResult[];
}

/** Product retrieval over one mutable Orama projection. */
export class Retriever {
  readonly snapshot: RetrievalSnapshot;
  private readonly embedding?: Pick<EmbeddingModel, "embed"> &
    Partial<Pick<EmbeddingModel, "dimensions">>;
  private closed = false;

  constructor(options: RetrieverOptions) {
    this.embedding = options.embedding;
    const projection = options.projection;
    this.snapshot = {
      projection,
      get generationId() {
        return projection.generationId;
      },
      get fingerprint() {
        return projection.fingerprint;
      },
      close: async () => undefined,
    } as RetrievalSnapshot;
  }

  async search(request: RetrievalRequest): Promise<readonly RetrievalResult[]> {
    if (this.closed) throw new StructuredError("internal", "Retriever is closed.", false);
    const projection = this.snapshot.projection;
    if (!projection.ready)
      throw new StructuredError("unavailable", "Semantic index is unavailable.", true);
    const mode = request.mode ?? "hybrid";
    const shape = request.resultShape ?? (mode === "related" ? "notes" : "chunks");
    const query = request.query.trim();
    if (!query)
      throw new StructuredError("invalid_request", "Search query must not be empty.", false);
    const limit = checkedLimit(
      request.limit ?? (mode === "related" || shape === "notes" ? 7 : 20),
      shape === "notes" ? (request.feature === "lente" ? 160 : 7) : mode === "related" ? 1000 : 20
    );
    const semanticLimit = checkedCandidate(
      request.semanticCandidateLimit ?? (mode === "related" ? 128 : 80)
    );
    const lexicalLimit = checkedCandidate(
      request.lexicalCandidateLimit ?? (mode === "related" ? 128 : 80)
    );
    const signal = request.signal;
    check(signal);

    let queryVector = request.queryVector;
    if (mode !== "lexical" && !queryVector)
      queryVector = await this.embedQuery(query, signal, projection.dimensions);
    check(signal);

    return projection
      .withGate(async () => {
        check(signal);
        if (!projection.ready)
          throw new StructuredError("unavailable", "Semantic index is unavailable.", true);
        const excluded =
          request.excludePath ??
          (mode === "related" ? (request.currentPath ?? undefined) : undefined);
        let semantic: readonly OramaSearchHit[] = [];
        let lexical: readonly OramaSearchHit[] = [];
        try {
          if (mode !== "lexical") {
            semantic = await projection.vectorSearch(queryVector!, {
              limit: semanticLimit,
              signal,
              excludePath: excluded,
              distinctPaths: request.feature === "lente" || mode === "related",
            });
          }
          if (mode !== "semantic" && mode !== "related") {
            lexical = await projection.lexicalSearch(query, {
              limit: lexicalLimit,
              candidateLimit: lexicalLimit,
              signal,
              excludePath: excluded,
              profile: request.lexicalProfile,
            });
          } else if (mode === "related") {
            // Related-note lookup is intentionally semantic-only and never embeds
            // the query text; Filo supplies the committed centroid as queryVector.
            lexical = [];
          }
        } catch (error) {
          throw normalizeError(error, signal);
        }
        const filteredSemantic = orderHits(filterHits(semantic, request, excluded)).slice(
          0,
          semanticLimit
        );
        const filteredLexical = orderHits(filterHits(lexical, request, excluded)).slice(
          0,
          lexicalLimit
        );
        const merged =
          request.feature === "lente"
            ? fuseLenteByPath(filteredSemantic, filteredLexical)
            : fuse(filteredSemantic, filteredLexical);
        const selected = shape === "notes" ? uniqueNotes(merged, limit) : merged.slice(0, limit);
        const hydrated: RetrievalResult[] = [];
        for (const hit of selected) {
          check(signal);
          const document = projection.getDocument(hit.id);
          if (!document) continue;
          hydrated.push({
            path: document.path,
            startLine: document.startLine,
            endLine: document.endLine,
            excerpt: document.body.slice(0, 500),
            generationId: projection.generationId,
            chunkId: document.chunkId,
            ordinal: document.ordinal,
            semanticScore: hit.semanticScore,
            lexicalScore: hit.lexicalScore,
            fusedScore: hit.fusedScore,
          });
        }
        return hydrated;
      })
      .catch((error) => {
        if (!projection.ready)
          throw new StructuredError("unavailable", "Semantic index is unavailable.", true);
        throw error;
      });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async embedQuery(
    query: string,
    signal: AbortSignal | undefined,
    dimensions: number
  ): Promise<readonly number[]> {
    if (!this.embedding) throw new QueryEmbeddingError();
    try {
      const values = await this.embedding.embed([query], signal ?? new AbortController().signal);
      check(signal);
      const vector = values[0];
      const expected = this.embedding.dimensions ?? dimensions;
      const normSquared = Array.isArray(vector)
        ? vector.reduce((sum, value) => sum + value * value, 0)
        : Number.NaN;
      if (
        !Array.isArray(vector) ||
        vector.length !== expected ||
        vector.some((value) => !Number.isFinite(value)) ||
        !(Math.sqrt(normSquared) > 1e-12)
      )
        throw new QueryEmbeddingError();
      return vector;
    } catch (error) {
      if (signal?.aborted) throw new StructuredError("cancelled", "Search cancelled.", true);
      if (error instanceof QueryEmbeddingError || isAbortError(error) || isCancellationError(error))
        throw error;
      throw new QueryEmbeddingError();
    }
  }
}

function checkedLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new StructuredError("invalid_request", "Invalid result limit.", false);
  return value;
}

function checkedCandidate(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000)
    throw new StructuredError("invalid_request", "Invalid candidate limit.", false);
  return value;
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StructuredError("cancelled", "Search cancelled.", true);
}

function toSet(value: RetrievalRequest["visiblePaths"]): ReadonlySet<string> | undefined {
  return value ? (value instanceof Set ? value : new Set(value)) : undefined;
}

function filterHits<T extends { path: string }>(
  hits: readonly T[],
  request: RetrievalRequest,
  excluded?: string
): T[] {
  const visible = toSet(request.visiblePaths);
  return hits.filter((hit) => (!visible || visible.has(hit.path)) && hit.path !== excluded);
}

function orderHits<
  T extends { path: string; ordinal: number; id: string; score: number; chunkId?: string },
>(hits: readonly T[]): T[] {
  return [...hits].sort(
    (a, b) =>
      b.score - a.score ||
      compareCodeUnits(a.path, b.path) ||
      a.ordinal - b.ordinal ||
      compareCodeUnits(a.chunkId ?? "", b.chunkId ?? "") ||
      compareCodeUnits(a.id, b.id)
  );
}

function normalizeError(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) return new StructuredError("cancelled", "Search cancelled.", true);
  return error instanceof Error
    ? error
    : new StructuredError("internal", "Retrieval failed.", false);
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError"
  );
}

function isCancellationError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: unknown }).code === "cancelled"
  );
}

interface Fused {
  readonly id: string;
  readonly path: string;
  readonly ordinal: number;
  readonly chunkId?: string;
  readonly semanticScore?: number;
  readonly lexicalScore?: number;
  readonly fusedScore: number;
  readonly evidenceRank?: number;
  readonly evidenceChannel?: 0 | 1;
  readonly evidenceScore?: number;
}

/** Lente collapses evidence by note path while retaining a deterministic passage. */
function fuseLenteByPath(
  semantic: readonly OramaSearchHit[],
  lexical: readonly OramaSearchHit[]
): Fused[] {
  const map = new Map<string, Fused>();
  const add = (hit: OramaSearchHit, rank: number, channel: 0 | 1): void => {
    const old = map.get(hit.path);
    const evidenceIsBetter =
      !old ||
      rank < (old.evidenceRank ?? Number.POSITIVE_INFINITY) ||
      (rank === old.evidenceRank &&
        (channel < (old.evidenceChannel ?? 1) ||
          (channel === old.evidenceChannel &&
            (hit.score > (old.evidenceScore ?? -Infinity) ||
              (hit.score === (old.evidenceScore ?? -Infinity) && hit.ordinal < old.ordinal)))));
    map.set(hit.path, {
      id: evidenceIsBetter ? hit.id : (old?.id ?? hit.id),
      path: hit.path,
      ordinal: evidenceIsBetter ? hit.ordinal : (old?.ordinal ?? hit.ordinal),
      chunkId: evidenceIsBetter ? hit.chunkId : old?.chunkId,
      fusedScore: (old?.fusedScore ?? 0) + 1 / (60 + rank + 1),
      ...(channel === 0
        ? { semanticScore: hit.score }
        : old?.semanticScore === undefined
          ? {}
          : { semanticScore: old.semanticScore }),
      ...(channel === 1
        ? { lexicalScore: hit.score }
        : old?.lexicalScore === undefined
          ? {}
          : { lexicalScore: old.lexicalScore }),
      ...(evidenceIsBetter
        ? { evidenceRank: rank, evidenceChannel: channel, evidenceScore: hit.score }
        : old?.evidenceRank === undefined
          ? { evidenceRank: rank, evidenceChannel: channel, evidenceScore: hit.score }
          : {}),
    });
  };
  semantic.forEach((hit, rank) => add(hit, rank, 0));
  lexical.forEach((hit, rank) => add(hit, rank, 1));
  return [...map.values()].sort(compareFused);
}

/** Product hybrid ranking: independent vector/BM25 channels with RRF k=60. */
function fuse(semantic: readonly OramaSearchHit[], lexical: readonly OramaSearchHit[]): Fused[] {
  const map = new Map<string, Fused>();
  semantic.forEach((hit, index) => {
    const key = `${hit.path}\0${hit.ordinal}`;
    const old = map.get(key);
    map.set(key, {
      id: hit.id,
      path: hit.path,
      ordinal: hit.ordinal,
      chunkId: hit.chunkId,
      semanticScore: hit.score,
      fusedScore: (old?.fusedScore ?? 0) + 1 / (60 + index + 1),
    });
  });
  lexical.forEach((hit, index) => {
    const key = `${hit.path}\0${hit.ordinal}`;
    const old = map.get(key);
    map.set(key, {
      id: old?.id ?? hit.id,
      path: hit.path,
      ordinal: hit.ordinal,
      chunkId: old?.chunkId ?? hit.chunkId,
      semanticScore: old?.semanticScore,
      lexicalScore: hit.score,
      fusedScore: (old?.fusedScore ?? 0) + 1 / (60 + index + 1),
    });
  });
  return [...map.values()].sort(compareFused);
}

function compareFused(a: Fused, b: Fused): number {
  return (
    b.fusedScore - a.fusedScore ||
    (b.semanticScore === undefined
      ? -1
      : a.semanticScore === undefined
        ? 1
        : b.semanticScore - a.semanticScore) ||
    (b.lexicalScore === undefined
      ? -1
      : a.lexicalScore === undefined
        ? 1
        : b.lexicalScore - a.lexicalScore) ||
    compareCodeUnits(a.path, b.path) ||
    a.ordinal - b.ordinal ||
    compareCodeUnits(a.chunkId ?? "", b.chunkId ?? "") ||
    compareCodeUnits(a.id, b.id)
  );
}

function uniqueNotes(hits: readonly Fused[], limit: number): Fused[] {
  const selected: Fused[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (seen.has(hit.path)) continue;
    seen.add(hit.path);
    selected.push(hit);
    if (selected.length >= limit) break;
  }
  return selected;
}
