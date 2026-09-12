import { RelatedIndexSnapshot } from "@/index/IndexManager";
import { compareCodeUnits } from "@/index/order";
import {
  emitTramaDiagnostic,
  NOOP_TRAMA_DIAGNOSTICS,
  projectDiagnosticError,
  TramaDiagnosticRecord,
  TramaDiagnostics,
} from "@/diagnostics/TramaDiagnostics";

export interface RelatedNotesSource {
  relatedSnapshot(path: string): RelatedIndexSnapshot | null;
}
export interface RelatedNoteResult {
  readonly path: string;
  readonly score: number;
  readonly similarity?: number;
  readonly excerpt?: string;
  readonly startLine?: number;
  readonly endLine?: number;
}
export interface RelatedNotesResult {
  readonly generationId: string;
  readonly currentPath: string;
  readonly contentHash: string;
  readonly results: readonly RelatedNoteResult[];
}

/** Shared, cancellable related-note lookup used by Filo and Voce. */
export class RelatedNotes {
  static readonly MAX_RESULTS = 20;

  private readonly cache = new Map<string, RelatedNotesResult>();
  private readonly inFlight = new Map<
    string,
    { promise: Promise<RelatedNotesResult>; controller: AbortController }
  >();
  private latestResult?: RelatedNotesResult;
  private readonly listeners = new Set<(result: RelatedNotesResult) => void>();

  constructor(
    private readonly index: RelatedNotesSource,
    private readonly diagnostics: TramaDiagnostics = NOOP_TRAMA_DIAGNOSTICS
  ) {}

  subscribe(listener: (result: RelatedNotesResult) => void): () => void {
    this.listeners.add(listener);
    if (this.latestResult) listener(this.latestResult);
    return () => this.listeners.delete(listener);
  }

  latest(currentPath?: string): readonly string[] {
    if (!this.latestResult) return [];
    const path = currentPath ?? this.latestResult.currentPath;
    if (this.latestResult.currentPath !== path) return [];
    const currentKey = this.snapshotKey(path);
    if (!currentKey || currentKey !== this.keyOf(this.latestResult)) return [];
    return this.latestResult.results.map((result) => result.path);
  }

  snapshotKey(path: string): string | undefined {
    const snapshot = this.index.relatedSnapshot(path);
    return snapshot ? this.key(snapshot) : undefined;
  }

  async find(
    currentPath: string,
    signal: AbortSignal,
    limit = 7,
    refresh = false
  ): Promise<RelatedNotesResult> {
    const started = Date.now();
    if (signal.aborted) throw new Error("Operation cancelled");
    const cap = Math.max(0, Math.min(RelatedNotes.MAX_RESULTS, Math.floor(limit)));
    const snapshot = this.index.relatedSnapshot(currentPath);
    if (!snapshot || cap === 0) {
      const result = {
        generationId: snapshot?.generationId ?? "",
        currentPath: snapshot?.currentPath ?? currentPath,
        contentHash: snapshot?.contentHash ?? "",
        results: [],
      };
      this.publish(result, snapshot ? this.key(snapshot) : "");
      return result;
    }
    const key = this.key(snapshot);
    if (refresh) this.cancelAll();
    else if ([...this.inFlight.keys()].some((activeKey) => activeKey !== key)) this.cancelAll();
    const cached = this.cache.get(key);
    if (cached && !refresh) {
      if (this.snapshotKey(currentPath) !== key) throw new Error("Operation cancelled");
      return { ...cached, results: cached.results.slice(0, cap) };
    }
    const existing = this.inFlight.get(key);
    if (existing && !existing.controller.signal.aborted && !refresh)
      return this.forConsumer(existing.promise, signal, cap, key, currentPath);
    if (existing?.controller.signal.aborted) this.inFlight.delete(key);
    const controller = new AbortController();
    this.emitDiagnostic({
      area: "filo",
      event: "related_search",
      stage: "started",
      path: currentPath,
      generation: snapshot.generationId,
      resultCount: 0,
    });
    const run = this.compute(snapshot, controller.signal, RelatedNotes.MAX_RESULTS)
      .then((result) => {
        if (controller.signal.aborted) throw new Error("Operation cancelled");
        if (this.snapshotKey(result.currentPath) === key) {
          this.cache.set(key, result);
          this.publish(result, key);
          this.emitDiagnostic({
            area: "filo",
            event: "related_search",
            stage: "completed",
            path: result.currentPath,
            generation: result.generationId,
            resultCount: result.results.length,
            durationMs: Date.now() - started,
          });
        } else {
          this.emitDiagnostic({
            area: "filo",
            event: "related_search",
            path: result.currentPath,
            generation: result.generationId,
            resultCount: 0,
            durationMs: Date.now() - started,
            error: { name: "Error", code: "cancelled", retryable: true, cancelled: true },
          });
          throw new Error("Operation cancelled");
        }
        return result;
      })
      .finally(() => {
        if (this.inFlight.get(key)?.promise === run) this.inFlight.delete(key);
      });
    this.inFlight.set(key, { promise: run, controller });
    return this.forConsumer(run, signal, cap, key, currentPath);
  }

  cancel(): void {
    this.cancelAll();
  }

  private cancelAll(): void {
    for (const entry of this.inFlight.values()) entry.controller.abort();
    this.inFlight.clear();
  }

  private forConsumer(
    shared: Promise<RelatedNotesResult>,
    signal: AbortSignal,
    limit: number,
    expectedKey?: string,
    expectedPath?: string
  ): Promise<RelatedNotesResult> {
    if (signal.aborted) return Promise.reject(new Error("Operation cancelled"));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.emitDiagnostic({
          area: "filo",
          event: "related_search",
          path: expectedPath,
          generation: expectedKey?.split("\0")[0],
          resultCount: 0,
          cancelled: true,
          error: { name: "Error", code: "cancelled", retryable: true, cancelled: true },
        });
        reject(new Error("Operation cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      shared.then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          if (
            !signal.aborted &&
            (!expectedKey ||
              this.snapshotKey(expectedPath ?? result.currentPath) === expectedKey) &&
            (!expectedKey || this.keyOf(result) === expectedKey)
          )
            resolve({ ...result, results: result.results.slice(0, limit) });
          else if (!signal.aborted) reject(new Error("Operation cancelled"));
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          if (!signal.aborted) {
            this.emitDiagnostic({
              area: "filo",
              event: "related_search",
              path: expectedPath,
              resultCount: 0,
              error: {
                ...projectDiagnosticError(error),
              },
            });
            reject(error);
          }
        }
      );
    });
  }

  private async compute(
    snapshot: RelatedIndexSnapshot,
    signal: AbortSignal,
    limit: number
  ): Promise<RelatedNotesResult> {
    if (signal.aborted) throw new Error("Operation cancelled");
    const prepareStarted = Date.now();
    const prepared = await snapshot.prepareQuery(signal);
    this.emitDiagnostic({
      area: "filo",
      event: "related_search",
      stage: "prepare-completed",
      path: snapshot.currentPath,
      generation: snapshot.generationId,
      resultCount: 0,
      durationMs: Date.now() - prepareStarted,
    });
    if (!prepared || !prepared.text) {
      return {
        generationId: snapshot.generationId,
        currentPath: snapshot.currentPath,
        contentHash: snapshot.contentHash,
        results: [],
      };
    }
    const retrieveStarted = Date.now();
    const hits = await snapshot.search(prepared.text, prepared.vector, signal, 128);
    this.emitDiagnostic({
      area: "filo",
      event: "related_search",
      stage: "retrieve-completed",
      path: snapshot.currentPath,
      generation: snapshot.generationId,
      resultCount: hits.length,
      durationMs: Date.now() - retrieveStarted,
    });
    const best = new Map<string, RelatedNoteResult>();
    for (const hit of hits) {
      if (hit.path === snapshot.currentPath) continue;
      const previous = best.get(hit.path);
      const similarity =
        hit.similarity === undefined
          ? previous?.similarity
          : Math.max(hit.similarity, previous?.similarity ?? -Infinity);
      if (!previous || hit.score > previous.score) {
        best.set(hit.path, {
          path: hit.path,
          score: hit.score,
          ...(similarity === undefined ? {} : { similarity }),
          ...(hit.excerpt === undefined ? {} : { excerpt: hit.excerpt }),
          ...(hit.startLine === undefined ? {} : { startLine: hit.startLine }),
          ...(hit.endLine === undefined ? {} : { endLine: hit.endLine }),
        });
      } else if (similarity !== previous.similarity) {
        best.set(hit.path, { ...previous, similarity });
      }
    }
    const results = [...best.values()]
      .sort((a, b) => b.score - a.score || compareCodeUnits(a.path, b.path))
      .slice(0, limit);
    return {
      generationId: snapshot.generationId,
      currentPath: snapshot.currentPath,
      contentHash: snapshot.contentHash,
      results,
    };
  }

  private key(snapshot: RelatedIndexSnapshot): string {
    return `${snapshot.generationId}\0${snapshot.currentPath}\0${snapshot.contentHash}`;
  }

  private keyOf(result: RelatedNotesResult): string {
    return `${result.generationId}\0${result.currentPath}\0${result.contentHash}`;
  }

  private publish(result: RelatedNotesResult, expectedKey: string): void {
    if (this.snapshotKey(result.currentPath) !== expectedKey) return;
    this.latestResult = result;
    for (const listener of this.listeners) listener(result);
  }

  private emitDiagnostic(record: TramaDiagnosticRecord): void {
    emitTramaDiagnostic(this.diagnostics, record);
  }
}
