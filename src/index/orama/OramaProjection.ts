import type { AnyOrama } from "@orama/orama";
import { compareCodeUnits } from "@/index/Ordering";
import { oramaDocumentId } from "@/index/Identity";
import {
  countOramaDocuments,
  getOramaDocument,
  mapOramaHit,
  searchOrama,
  type OramaRawResults,
} from "./OramaDatabase";
import type {
  OramaCatalog,
  OramaDocument,
  OramaSearchHit,
  OramaProjectionState,
} from "./OramaTypes";

/** A small serialized gate shared by live queries and mutation batches. */
export class ProjectionGate {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/**
 * Stable object leased by all consumers. Its database and catalog are mutable;
 * leases never retain an old generation or a detached backend.
 */
export class OramaProjection {
  readonly gate = new ProjectionGate();
  private state: OramaProjectionState | null = null;
  // Leased consumers may still inspect diagnostic metadata after the manager
  // has been detached. Keep the last published values stable while making the
  // database itself unavailable for reads and searches.
  private detachedCatalog: OramaCatalog = emptyCatalog();
  private detachedFingerprint = "";
  private detachedDimensions = 0;
  private detachedRevision = 0;

  get ready(): boolean {
    return this.state !== null;
  }

  get db(): AnyOrama {
    if (!this.state) throw new Error("Orama projection is unavailable");
    return this.state.db;
  }

  get catalog(): OramaCatalog {
    return this.state?.catalog ?? this.detachedCatalog;
  }

  get fingerprint(): string {
    return this.state?.fingerprint ?? this.detachedFingerprint;
  }

  get dimensions(): number {
    return this.state?.dimensions ?? this.detachedDimensions;
  }

  get revision(): number {
    return this.state?.revision ?? this.detachedRevision;
  }

  get complete(): boolean {
    return this.state?.complete ?? false;
  }

  get dirty(): boolean {
    return this.state?.dirty ?? false;
  }

  get generationId(): string {
    return String(this.revision);
  }

  attach(
    db: AnyOrama,
    catalog: OramaCatalog,
    fingerprint: string,
    dimensions: number,
    revision: number,
    complete = false,
    dirty = false
  ): void {
    this.detachedCatalog = catalog;
    this.detachedFingerprint = fingerprint;
    this.detachedDimensions = dimensions;
    this.detachedRevision = revision;
    this.state = {
      db,
      catalog,
      fingerprint,
      dimensions,
      revision,
      complete,
      dirty,
      ...this.methods(),
    };
  }

  update(catalog: OramaCatalog, revision: number, complete: boolean, dirty: boolean): void {
    if (!this.state) throw new Error("Orama projection is unavailable");
    this.detachedCatalog = catalog;
    this.detachedFingerprint = this.state.fingerprint;
    this.detachedDimensions = this.state.dimensions;
    this.detachedRevision = revision;
    this.state = { ...this.state, catalog, revision, complete, dirty };
  }

  detach(): void {
    this.state = null;
  }

  async withGate<T>(operation: () => Promise<T> | T): Promise<T> {
    if (!this.state) throw new Error("Orama projection is unavailable");
    return this.gate.run(operation);
  }

  getDocument(id: string): OramaDocument | undefined {
    return getOramaDocument(this.db, id);
  }

  document(path: string, ordinal: number): OramaDocument | undefined {
    return getOramaDocument(this.db, oramaDocumentId(path, ordinal));
  }

  documentsForPath(path: string): readonly OramaDocument[] {
    const note = this.catalog.notes.find((candidate) => candidate.path === path);
    if (!note) return [];
    return note.documentIds
      .map((id) => getOramaDocument(this.db, id))
      .filter((document): document is OramaDocument => Boolean(document))
      .sort((a, b) => a.ordinal - b.ordinal || compareCodeUnits(a.id, b.id));
  }

  async vectorSearch(
    vector: readonly number[],
    options: {
      readonly limit: number;
      readonly signal?: AbortSignal;
      readonly excludePath?: string;
      readonly distinctPaths?: boolean;
    }
  ): Promise<readonly OramaSearchHit[]> {
    if (vector.length !== this.dimensions) throw new Error("Query vector dimensions mismatch");
    const limit = boundedLimit(options.limit);
    check(options.signal);
    if (!limit || !countOramaDocuments(this.db)) return [];
    return collectBoundaryHits(
      (searchLimit) =>
        searchOrama(this.db, {
          mode: "vector",
          vector: { value: [...vector], property: "embedding" },
          similarity: -1,
          limit: searchLimit,
        }),
      limit,
      options
    );
  }

  async lexicalSearch(
    query: string,
    options: {
      readonly limit: number;
      readonly candidateLimit?: number;
      readonly signal?: AbortSignal;
      readonly excludePath?: string;
      readonly profile?: "default" | "lente";
    }
  ): Promise<readonly OramaSearchHit[]> {
    const limit = boundedLimit(options.limit);
    check(options.signal);
    if (!query.trim() || !limit || !countOramaDocuments(this.db)) return [];
    const profile = options.profile ?? "default";
    const candidateLimit = Math.max(limit, boundedLimit(options.candidateLimit ?? limit));
    const properties = profile === "lente" ? ["filename", "pathText", "body"] : ["body"];
    const hits = await collectBoundaryHits(
      (searchLimit) =>
        searchOrama(this.db, {
          term: query,
          properties,
          ...(profile === "lente" ? { boost: { filename: 3, pathText: 2, body: 1 } } : {}),
          limit: searchLimit,
        }),
      candidateLimit,
      {
        signal: options.signal,
        excludePath: options.excludePath,
        distinctPaths: profile === "lente",
      }
    );
    return hits.slice(0, limit);
  }

  private methods(): Pick<OramaProjectionState, "getDocument" | "document" | "documentsForPath"> {
    return {
      getDocument: (id) => this.getDocument(id),
      document: (path, ordinal) => this.document(path, ordinal),
      documentsForPath: (path) => this.documentsForPath(path),
    };
  }
}

function emptyCatalog(): OramaCatalog {
  return {
    schema: 1,
    fingerprint: "",
    dimensions: 0,
    noteCount: 0,
    chunkCount: 0,
    notes: [],
  };
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Operation cancelled");
}

function compareHit(a: OramaSearchHit, b: OramaSearchHit): number {
  return (
    b.score - a.score ||
    compareCodeUnits(a.path, b.path) ||
    a.ordinal - b.ordinal ||
    compareCodeUnits(a.chunkId ?? "", b.chunkId ?? "") ||
    compareCodeUnits(a.id, b.id)
  );
}

function boundedLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

async function collectBoundaryHits(
  run: (limit: number) => Promise<OramaRawResults>,
  requestedLimit: number,
  options: {
    readonly signal?: AbortSignal;
    readonly excludePath?: string;
    readonly distinctPaths?: boolean;
  }
): Promise<readonly OramaSearchHit[]> {
  const desired = boundedLimit(requestedLimit);
  if (!desired) return [];
  check(options.signal);
  let searchLimit = Math.max(1, desired);
  let result = await run(searchLimit);
  let hits = mapAndFilter(result, options.excludePath);
  while (result.hits.length < result.count) {
    check(options.signal);
    const selected = selectHits(hits, desired, options.distinctPaths === true);
    const cutoff = selected[desired - 1]?.score;
    const minimumScore = result.hits.reduce(
      (minimum, hit) => Math.min(minimum, Number.isFinite(hit.score) ? hit.score : 0),
      Number.POSITIVE_INFINITY
    );
    if (cutoff !== undefined && minimumScore < cutoff) break;
    const nextLimit = Math.min(result.count, Math.max(searchLimit + 1, searchLimit * 2));
    if (nextLimit <= searchLimit) break;
    searchLimit = nextLimit;
    result = await run(searchLimit);
    hits = mapAndFilter(result, options.excludePath);
  }
  check(options.signal);
  return selectHits(hits, desired, options.distinctPaths === true);
}

function mapAndFilter(result: OramaRawResults, excludePath?: string): OramaSearchHit[] {
  return result.hits
    .map(mapOramaHit)
    .filter((hit) => hit.path !== excludePath)
    .sort(compareHit);
}

function selectHits(
  hits: readonly OramaSearchHit[],
  limit: number,
  distinctPaths: boolean
): OramaSearchHit[] {
  const sorted = [...hits].sort(compareHit);
  if (!distinctPaths) return sorted.slice(0, limit);
  const selected: OramaSearchHit[] = [];
  const seen = new Set<string>();
  for (const hit of sorted) {
    if (seen.has(hit.path)) continue;
    seen.add(hit.path);
    selected.push(hit);
    if (selected.length >= limit) break;
  }
  return selected;
}
