import { StructuredError, type EmbeddingModel } from "@/domain/contracts";
import type {
  IndexRevision,
  RetrievalChunk,
  RetrievalNote,
  RetrievalRepository,
  RetrievalRow,
} from "@/index/contracts";
import { compareCodeUnits } from "@/index/order";
import { chunkId } from "@/index/corpus/Hash";
import type { LexicalHit, LexicalIndex, LexicalProfile } from "@/index/lexical/LexicalIndex";
import type { VectorIndex, VectorSearchHit } from "@/index/vector/VectorIndex";
import { QueryEmbeddingError, isQueryEmbeddingError } from "./QueryEmbeddingError";

export type RetrievalMode = "hybrid" | "semantic" | "related" | "lexical";
export type RetrievalShape = "chunks" | "notes";

export { QueryEmbeddingError, isQueryEmbeddingError } from "./QueryEmbeddingError";

export interface RetrievalSnapshot {
  readonly corpus: RetrievalSource;
  readonly vector: VectorIndex;
  readonly lexical: LexicalIndex;
  readonly generationId: string;
  readonly revision?: IndexRevision;
  readonly fingerprint: string;
  close(): Promise<void>;
}

/** Legacy immutable corpus shape retained while the concrete backend migrates. */
export interface LegacyRetrievalSource {
  readonly generationId: string;
  readonly revision?: IndexRevision;
  readonly fingerprint: string;
  readonly notes: readonly RetrievalNote[];
  pin(): LegacyRetrievalSource;
  release(): Promise<void>;
  getNote(path: string): RetrievalNote | undefined;
  hydrateChunk(path: string, ordinal: number): Promise<RetrievalChunk | undefined>;
}
export type RetrievalSource = LegacyRetrievalSource | RetrievalRepository;

export interface RetrieverOptions {
  /** Transitional CorpusSnapshot-compatible source. */
  readonly snapshot?: LegacyRetrievalSource;
  /** Mutable Tala-neutral source; preferred by new backends. */
  readonly repository?: RetrievalRepository;
  readonly vector: VectorIndex;
  readonly lexical: LexicalIndex;
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
  /** Explicit feature contract; only Lente may request more than seven notes. */
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
  readonly rowId?: string;
  readonly semanticScore?: number;
  readonly lexicalScore?: number;
  readonly fusedScore: number;
  readonly ordinal: number;
  readonly chunks?: readonly RetrievalResult[];
}

export class Retriever {
  readonly snapshot: RetrievalSnapshot;
  private closed = false;
  private readonly embedding?: Pick<EmbeddingModel, "embed"> &
    Partial<Pick<EmbeddingModel, "dimensions">>;

  constructor(options: RetrieverOptions) {
    const source = options.repository ?? options.snapshot;
    if (!source) throw new StructuredError("internal", "Retrieval source is missing.", false);
    const generationId = source.generationId;
    const fingerprint = source.fingerprint;
    const revision = source.revision;
    const { vector, lexical } = options;
    const legacyVectorSnapshot = (vector as { readonly snapshot?: unknown }).snapshot;
    if (options.snapshot && legacyVectorSnapshot && legacyVectorSnapshot !== options.snapshot)
      throw new StructuredError(
        "internal",
        "Vector index is not bound to the corpus snapshot.",
        false
      );
    if (
      !sameGeneration(vector, generationId, revision) ||
      !sameGeneration(lexical, generationId, revision)
    )
      throw new StructuredError(
        "internal",
        "Retrieval backends belong to different generations.",
        false
      );
    if (!sameFingerprint(vector, fingerprint) || !sameFingerprint(lexical, fingerprint))
      throw new StructuredError(
        "internal",
        "Retrieval backends belong to a different corpus.",
        false
      );
    const pinned = source.pin?.() ?? source;
    this.snapshot = Object.freeze({
      corpus: pinned,
      vector,
      lexical,
      generationId,
      revision,
      fingerprint,
      close: () => this.close(),
    });
    this.embedding = options.embedding;
  }

  async search(request: RetrievalRequest): Promise<readonly RetrievalResult[]> {
    if (this.closed) throw new StructuredError("internal", "Retriever is closed.", false);
    const mode = request.mode ?? "hybrid";
    const shape = request.resultShape ?? (mode === "related" ? "notes" : "chunks");
    const query = request.query.trim();
    if (!query)
      throw new StructuredError("invalid_request", "Search query must not be empty.", false);
    const limit = checkedLimit(
      request.limit ?? (mode === "related" || shape === "notes" ? 7 : 20),
      shape === "notes" ? (request.feature === "lente" ? 160 : 7) : mode === "related" ? 1_000 : 20
    );
    const semanticLimit = checkedCandidate(
      request.semanticCandidateLimit ?? (mode === "related" ? 128 : 80)
    );
    const lexicalLimit = checkedCandidate(
      request.lexicalCandidateLimit ?? (mode === "related" ? 128 : 80)
    );
    const signal = request.signal;
    check(signal);
    this.validateGeneration();
    let vector = request.queryVector;
    if (mode !== "lexical" && !vector) {
      if (!this.embedding) throw new QueryEmbeddingError();
      let embedded: readonly (readonly number[])[];
      try {
        embedded = await this.embedding.embed([query], signal ?? new AbortController().signal);
      } catch (error) {
        if (signal?.aborted) throw new StructuredError("cancelled", "Search cancelled.", true);
        if (isAbortError(error) || isCancellationError(error)) throw error;
        throw new QueryEmbeddingError();
      }
      check(signal);
      if (!Array.isArray(embedded) || embedded.length === 0) throw new QueryEmbeddingError();
      vector = embedded[0];
      const expectedDimensions = this.embedding.dimensions ?? this.snapshot.vector.dimensions;
      const normSquared = Array.isArray(vector)
        ? vector.reduce((sum, value) => sum + value * value, 0)
        : Number.NaN;
      const norm = Math.sqrt(normSquared);
      if (
        !Array.isArray(vector) ||
        (expectedDimensions !== undefined && vector.length !== expectedDimensions) ||
        vector.some((value) => !Number.isFinite(value)) ||
        !(norm > 1e-12)
      )
        throw new QueryEmbeddingError();
    }
    const visible = request.visiblePaths;
    const excluded =
      request.excludePath ?? (mode === "related" ? (request.currentPath ?? undefined) : undefined);
    const vectorPromise =
      mode === "lexical"
        ? Promise.resolve([] as readonly VectorSearchHit[])
        : this.snapshot.vector.search(vector!, {
            signal,
            limit: semanticLimit,
            visiblePaths: toSet(visible),
            excludePath: excluded,
            distinctPaths: request.feature === "lente",
          });
    const lexicalPromise =
      mode === "semantic"
        ? Promise.resolve([] as readonly LexicalHit[])
        : this.snapshot.lexical.search(query, {
            signal,
            limit: lexicalLimit,
            candidateLimit: lexicalLimit,
            visiblePaths: visible,
            excludePath: excluded,
            profile: request.lexicalProfile,
          });
    let semantic: readonly VectorSearchHit[];
    let lexical: readonly LexicalHit[];
    try {
      [semantic, lexical] = await Promise.all([vectorPromise, lexicalPromise]);
      check(signal);
      this.validateGeneration();
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
    try {
      for (const hit of selected) {
        check(signal);
        const record = await hydrateChunk(this.snapshot.corpus, hit);
        check(signal);
        this.validateGeneration();
        // A mutable repository may delete a ranked row before hydration. It is
        // a normal race: omit that result and continue with the next candidate.
        if (!record) continue;
        hydrated.push(toResult(this.snapshot, hit, record));
      }
    } catch (error) {
      throw normalizeError(error, signal);
    }
    return hydrated;
  }

  private validateGeneration(): void {
    if (
      this.snapshot.corpus.generationId !== this.snapshot.generationId ||
      this.snapshot.corpus.fingerprint !== this.snapshot.fingerprint ||
      !sameGeneration(this.snapshot.vector, this.snapshot.generationId) ||
      !sameFingerprint(this.snapshot.vector, this.snapshot.fingerprint) ||
      !sameGeneration(this.snapshot.lexical, this.snapshot.generationId) ||
      !sameFingerprint(this.snapshot.lexical, this.snapshot.fingerprint)
    )
      throw new StructuredError("internal", "Retrieval generation changed.", false);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([
      this.snapshot.vector.close(),
      this.snapshot.lexical.close(),
      this.snapshot.corpus.release?.() ?? Promise.resolve(),
    ]);
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
function orderHits<T extends { path: string; ordinal: number; id: string; score: number }>(
  hits: readonly T[]
): T[] {
  return [...hits].sort(
    (a, b) =>
      b.score - a.score ||
      compareCodeUnits(a.path, b.path) ||
      a.ordinal - b.ordinal ||
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
  id: string;
  rowId?: string;
  canonicalId?: string;
  path: string;
  ordinal: number;
  semanticScore?: number;
  lexicalScore?: number;
  fusedScore: number;
  evidenceRank?: number;
  evidenceChannel?: 0 | 1;
  evidenceScore?: number;
}

/** Lente fuses channel ranks by note path, retaining one deterministic passage. */
function fuseLenteByPath(
  semantic: readonly VectorSearchHit[],
  lexical: readonly LexicalHit[]
): Fused[] {
  const map = new Map<string, Fused>();
  const add = (hit: VectorSearchHit | LexicalHit, rank: number, channel: 0 | 1): void => {
    const old = map.get(hit.path);
    const evidenceIsBetter =
      !old ||
      rank < (old.evidenceRank ?? Number.POSITIVE_INFINITY) ||
      (rank === old.evidenceRank &&
        (channel < (old.evidenceChannel ?? 1) ||
          (channel === old.evidenceChannel &&
            (hit.score > (old.evidenceScore ?? -Infinity) ||
              (hit.score === (old.evidenceScore ?? -Infinity) && hit.ordinal < old.ordinal)))));
    const next: Fused = {
      ...old,
      id: evidenceIsBetter ? hit.id : (old?.id ?? hit.id),
      rowId: evidenceIsBetter ? hit.rowId : (old?.rowId ?? hit.rowId),
      canonicalId: evidenceIsBetter ? hit.canonicalId : (old?.canonicalId ?? hit.canonicalId),
      path: hit.path,
      ordinal: evidenceIsBetter ? hit.ordinal : (old?.ordinal ?? hit.ordinal),
      fusedScore: (old?.fusedScore ?? 0) + 1 / (60 + rank + 1),
      ...(evidenceIsBetter
        ? { evidenceRank: rank, evidenceChannel: channel, evidenceScore: hit.score }
        : old?.evidenceRank === undefined
          ? { evidenceRank: rank, evidenceChannel: channel, evidenceScore: hit.score }
          : {}),
    };
    if (channel === 0) next.semanticScore = hit.score;
    else next.lexicalScore = hit.score;
    map.set(hit.path, next);
  };
  semantic.forEach((hit, rank) => add(hit, rank, 0));
  lexical.forEach((hit, rank) => add(hit, rank, 1));
  return [...map.values()].sort(compareFused);
}
function fuse(semantic: readonly VectorSearchHit[], lexical: readonly LexicalHit[]): Fused[] {
  const map = new Map<string, Fused>();
  semantic.forEach((hit, i) => {
    const key = `${hit.path}\0${hit.ordinal}`;
    map.set(key, {
      ...map.get(key),
      id: hit.id,
      rowId: hit.rowId,
      canonicalId: hit.canonicalId,
      path: hit.path,
      ordinal: hit.ordinal,
      semanticScore: hit.score,
      fusedScore: (map.get(key)?.fusedScore ?? 0) + 1 / (60 + i + 1),
    });
  });
  lexical.forEach((hit, i) => {
    const key = `${hit.path}\0${hit.ordinal}`;
    const old = map.get(key);
    map.set(key, {
      ...old,
      id: old?.id ?? hit.id,
      rowId: old?.rowId ?? hit.rowId,
      canonicalId: old?.canonicalId ?? hit.canonicalId,
      path: hit.path,
      ordinal: hit.ordinal,
      lexicalScore: hit.score,
      fusedScore: (old?.fusedScore ?? 0) + 1 / (60 + i + 1),
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
    compareCodeUnits(a.id, b.id)
  );
}
function uniqueNotes(hits: readonly Fused[], limit: number): Fused[] {
  const seen = new Set<string>();
  return hits.filter((hit) => !seen.has(hit.path) && (seen.add(hit.path), true)).slice(0, limit);
}
function toResult(
  snapshot: RetrievalSnapshot,
  hit: Fused,
  record: RetrievalChunk
): RetrievalResult {
  const note = snapshot.corpus.getNote?.(hit.path);
  let canonicalId = hit.canonicalId ?? record.canonicalId ?? hit.id;
  if (note && hit.canonicalId === undefined && record.canonicalId === undefined) {
    try {
      canonicalId = chunkId(note.contentId, hit.ordinal);
    } catch {
      // Test/fake snapshots may use non-content-addressed IDs; retain the backend ID.
    }
  }
  return {
    path: hit.path,
    startLine: record.startLine,
    endLine: record.endLine,
    excerpt: record.text.slice(0, 500),
    generationId: snapshot.generationId,
    chunkId: canonicalId,
    rowId: hit.rowId ?? record.rowId,
    ordinal: hit.ordinal,
    semanticScore: hit.semanticScore,
    lexicalScore: hit.lexicalScore,
    fusedScore: hit.fusedScore,
  };
}

function sameGeneration(
  backend: {
    readonly generationId?: string;
    readonly revision?: IndexRevision;
    readonly fingerprint?: string;
  },
  generationId: string,
  revision?: IndexRevision
): boolean {
  const legacySnapshot = (
    backend as {
      readonly snapshot?: {
        readonly generationId?: string;
        readonly fingerprint?: string;
        readonly revision?: IndexRevision;
      };
    }
  ).snapshot;
  const actualGeneration = backend.generationId ?? legacySnapshot?.generationId;
  const actualRevision = backend.revision ?? legacySnapshot?.revision;
  return (
    (actualGeneration === undefined || actualGeneration === generationId) &&
    (revision === undefined || actualRevision === undefined || actualRevision === revision)
  );
}

function sameFingerprint(backend: { readonly fingerprint?: string }, fingerprint: string): boolean {
  const legacySnapshot = (backend as { readonly snapshot?: { readonly fingerprint?: string } })
    .snapshot;
  const actualFingerprint = backend.fingerprint ?? legacySnapshot?.fingerprint;
  return actualFingerprint === undefined || actualFingerprint === fingerprint;
}

async function hydrateChunk(
  source: RetrievalSource,
  hit: Fused
): Promise<RetrievalChunk | undefined> {
  if (isMutableRepository(source)) {
    const row: RetrievalRow = {
      ...(hit.rowId === undefined ? {} : { rowId: hit.rowId }),
      ...(hit.canonicalId === undefined ? {} : { canonicalId: hit.canonicalId }),
      ...(hit.id === undefined ? {} : { id: hit.id }),
      path: hit.path,
      ordinal: hit.ordinal,
    };
    if (source.hydrateRow) return source.hydrateRow(row);
    return source.hydrateChunk?.(hit.rowId ?? hit.canonicalId ?? hit.id);
  }
  return source.hydrateChunk(hit.path, hit.ordinal);
}

function isMutableRepository(source: RetrievalSource): source is RetrievalRepository & {
  hydrateRow?: (row: RetrievalRow) => Promise<RetrievalChunk | undefined>;
} {
  return "revision" in source;
}
