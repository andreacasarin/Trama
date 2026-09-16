import { RelatedIndexHit, RelatedIndexState } from "@/index/IndexManager";
import type { IndexFreshness } from "@/domain/contracts";
import { compareCodeUnits } from "@/index/Identity";
import {
  emitTramaDiagnostic,
  NOOP_TRAMA_DIAGNOSTICS,
  projectDiagnosticError,
  TramaDiagnosticRecord,
  TramaDiagnostics,
} from "@/diagnostics/TramaDiagnostics";

export interface RelatedNotesSource {
  relatedState(path: string): RelatedIndexState | null;
  findRelated(
    path: string,
    signal: AbortSignal,
    limit: number
  ): Promise<readonly RelatedIndexHit[]>;
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
  readonly changeCounter?: number;
  readonly generationId?: string;
  readonly currentPath: string;
  readonly contentHash: string;
  readonly freshness?: IndexFreshness;
  readonly semanticPartial?: boolean;
  readonly publicationId?: string;
  readonly unavailableReason?: "semantic-unavailable" | "incomplete-vectors";
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
    const state = this.index.relatedState(path);
    return state ? this.key(state) : undefined;
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
    const state = this.index.relatedState(currentPath);
    if (!state || cap === 0) {
      const result = {
        changeCounter: state?.changeCounter ?? 0,
        generationId: state?.generationId ?? `counter:${state?.changeCounter ?? 0}`,
        currentPath: state?.currentPath ?? currentPath,
        contentHash: state?.contentHash ?? "",
        results: [],
        ...(state?.freshness ? { freshness: state.freshness } : {}),
        ...(state?.semantic?.state === "partial" ? { semanticPartial: true } : {}),
        ...(state?.publicationId ? { publicationId: state.publicationId } : {}),
      };
      this.publish(result, state ? this.key(state) : "");
      return result;
    }
    const readiness = this.relatedReadiness(state);
    if (readiness) {
      const result: RelatedNotesResult = {
        changeCounter: state.changeCounter,
        generationId: state.generationId,
        currentPath: state.currentPath,
        contentHash: state.contentHash,
        ...(state.freshness ? { freshness: state.freshness } : {}),
        ...(state.semantic?.state === "partial" ? { semanticPartial: true } : {}),
        ...(state.publicationId ? { publicationId: state.publicationId } : {}),
        unavailableReason: readiness,
        results: [],
      };
      this.publish(result, this.key(state));
      return result;
    }
    const key = this.key(state);
    if (refresh) this.cancelAll();
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
      generation: state.generationId,
      resultCount: 0,
    });
    const run = this.compute(state, controller.signal, RelatedNotes.MAX_RESULTS)
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
            resultCount: result.results.length,
            durationMs: Date.now() - started,
          });
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
          if (!signal.aborted) resolve({ ...result, results: result.results.slice(0, limit) });
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
    state: RelatedIndexState,
    signal: AbortSignal,
    limit: number
  ): Promise<RelatedNotesResult> {
    if (signal.aborted) throw new Error("Operation cancelled");
    const retrieveStarted = Date.now();
    const hits = await this.index.findRelated(state.currentPath, signal, 128);
    this.emitDiagnostic({
      area: "filo",
      event: "related_search",
      stage: "retrieve-completed",
      path: state.currentPath,
      generation: state.generationId,
      resultCount: hits.length,
      durationMs: Date.now() - retrieveStarted,
    });
    const best = new Map<string, RelatedNoteResult>();
    for (const hit of hits) {
      if (hit.path === state.currentPath) continue;
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
      changeCounter: state.changeCounter,
      generationId: state.generationId,
      currentPath: state.currentPath,
      contentHash: state.contentHash,
      results,
      ...(state.freshness ? { freshness: state.freshness } : {}),
      ...(state.semantic?.state === "partial" ? { semanticPartial: true } : {}),
      ...(state.publicationId ? { publicationId: state.publicationId } : {}),
    };
  }

  private relatedReadiness(state: RelatedIndexState): RelatedNotesResult["unavailableReason"] {
    if (!state.semantic || state.semantic.searchable) return undefined;
    return state.semantic.state === "partial" ? "incomplete-vectors" : "semantic-unavailable";
  }

  private key(state: RelatedIndexState): string {
    return `${state.changeCounter ?? state.generationId ?? 0}\0${state.currentPath}\0${state.contentHash}\0${state.freshness ?? ""}\0${state.publicationId ?? ""}`;
  }

  private keyOf(result: RelatedNotesResult): string {
    return `${result.changeCounter ?? result.generationId ?? 0}\0${result.currentPath}\0${result.contentHash}\0${result.freshness ?? ""}\0${result.publicationId ?? ""}`;
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
