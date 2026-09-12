import { Notice, Plugin } from "obsidian";
import {
  emitTramaDiagnostic,
  NOOP_TRAMA_DIAGNOSTICS,
  startDiagnosticTimer,
  TramaDiagnostics,
  TramaDiagnosticRecord,
} from "@/diagnostics/TramaDiagnostics";
import type { IndexProgress } from "@/domain/contracts";

export type IndexStatusKind =
  | "loading"
  | "index-required"
  | "ready"
  | "updating"
  | "stale"
  | "building"
  | "cancelling"
  | "cancelled"
  | "error"
  | "empty";

export interface IndexStatus {
  readonly kind: IndexStatusKind;
  readonly revision: number;
  readonly hasLastGood: boolean;
  readonly progress?: IndexProgress;
  readonly etaSeconds?: number;
  readonly message?: string;
  readonly canIndex: boolean;
  readonly canReindex: boolean;
  readonly canCancel: boolean;
}

const PHASE_LABELS: Record<IndexProgress["phase"], string> = {
  discover: "Finding notes",
  read: "Estimating index size",
  chunk: "Preparing text chunks",
  embed: "Creating embeddings",
  "encode-write": "Writing index",
  validate: "Validating index",
  "build-vector": "Preparing semantic search",
  "build-lexical": "Preparing keyword search",
  activate: "Activating index",
  GC: "Cleaning up old index data",
};

export function formatIndexProgress(progress: IndexProgress, etaSeconds?: number): string {
  const count =
    progress.total === undefined
      ? `${progress.completed} ${progress.unit}`
      : `${progress.completed} of ${progress.estimated ? "about " : ""}${progress.total} ${progress.unit}`;
  const eta =
    etaSeconds === undefined
      ? ""
      : etaSeconds < 60
        ? ` · about ${Math.max(1, Math.ceil(etaSeconds))} sec remaining`
        : ` · about ${Math.ceil(etaSeconds / 60)} min remaining`;
  return `${PHASE_LABELS[progress.phase]} — ${count}${eta}`;
}

interface StatusActions {
  index(signal: AbortSignal): Promise<void>;
  reindex(signal: AbortSignal): Promise<void>;
  cancel(): void;
}
interface StatusTiming {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

/** Owns the observable index state and the three user-facing index actions. */
export class IndexStatusController {
  private revision = 0;
  private controller?: AbortController;
  private readonly listeners = new Set<(status: IndexStatus) => void>();
  private progressTimer?: ReturnType<typeof setTimeout>;
  private pendingProgress?: IndexProgress;
  private progressAt = -Infinity;
  private rateKey?: string;
  private rateStartedAt = 0;
  private rateStartedCompleted = 0;
  private status: IndexStatus = this.make("loading", false, "Loading index…");

  constructor(
    private readonly plugin: Plugin,
    private readonly actions: StatusActions,
    private readonly diagnostics: TramaDiagnostics = NOOP_TRAMA_DIAGNOSTICS,
    private readonly timing: StatusTiming = {
      now: () => Date.now(),
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timer) => clearTimeout(timer),
    }
  ) {}

  register(): void {
    this.plugin.addCommand({
      id: "index-filo-vault",
      name: "Update index",
      callback: () => void this.start("index"),
      checkCallback: (checking: boolean) => {
        if (!this.status.canIndex) return false;
        if (!checking) void this.start("index");
        return true;
      },
    });
    this.plugin.addCommand({
      id: "reindex-filo-vault",
      name: "Rebuild index",
      callback: () => void this.start("reindex"),
      checkCallback: (checking: boolean) => {
        if (!this.status.canReindex) return false;
        if (!checking) void this.start("reindex");
        return true;
      },
    });
    this.plugin.addCommand({
      id: "cancel-filo-indexing",
      name: "Cancel indexing",
      callback: () => this.cancel(),
      checkCallback: (checking: boolean) => {
        if (!this.status.canCancel) return false;
        if (!checking) this.cancel();
        return true;
      },
    });
  }

  getStatus(): IndexStatus {
    return this.status;
  }
  subscribe(listener: (status: IndexStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }
  setLoading(): void {
    this.set("loading", false, "Loading index…");
  }
  setIndexRequired(silent = false): void {
    this.set("index-required", false, "Indexing required.", !silent);
  }
  setEmpty(hasLastGood = false, silent = false): void {
    this.set("empty", hasLastGood, "No Markdown notes are indexed.", !silent);
  }
  setReady(silent = false): void {
    this.set("ready", true, undefined, !silent);
  }
  setUpdating(): void {
    this.set("updating", true, "Updating index…");
  }
  markStale(hasLastGood = this.status.hasLastGood): void {
    this.set("stale", hasLastGood, "Index has changes; update required.");
  }
  markError(error: unknown): void {
    this.set(
      "error",
      this.status.hasLastGood,
      error instanceof Error ? error.message : String(error)
    );
  }

  /** Accepts progress from the current index operation for the observable UI state. */
  reportProgress(progress: IndexProgress): void {
    if (
      this.status.kind !== "building" &&
      this.status.kind !== "cancelling" &&
      this.status.kind !== "updating"
    )
      return;
    const previous = this.status.progress;
    if (
      previous?.generationId &&
      progress.generationId &&
      previous.generationId !== progress.generationId
    )
      return;
    if (
      previous &&
      previous.operation === progress.operation &&
      previous.phase === progress.phase &&
      previous.generationId === progress.generationId &&
      progress.completed < previous.completed
    )
      return;
    const phaseChanged =
      !previous ||
      previous.phase !== progress.phase ||
      previous.operation !== progress.operation ||
      previous.generationId !== progress.generationId;
    const elapsed = this.timing.now() - this.progressAt;
    if (!phaseChanged && elapsed < 125) {
      this.pendingProgress = progress;
      if (!this.progressTimer)
        this.progressTimer = this.timing.setTimeout(
          () => {
            this.progressTimer = undefined;
            const pending = this.pendingProgress;
            this.pendingProgress = undefined;
            if (pending) this.applyProgress(pending);
          },
          125 - Math.max(0, elapsed)
        );
      return;
    }
    this.pendingProgress = undefined;
    if (this.progressTimer) this.timing.clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    this.applyProgress(progress);
  }

  private applyProgress(progress: IndexProgress): void {
    const now = this.timing.now();
    this.progressAt = now;
    const rateKey = `${progress.operation}:${progress.phase}:${progress.generationId ?? ""}`;
    if (this.rateKey !== rateKey || progress.completed === 0) {
      this.rateKey = rateKey;
      this.rateStartedAt = now;
      this.rateStartedCompleted = progress.completed;
    }
    const elapsedSeconds = (now - this.rateStartedAt) / 1_000;
    const completedSinceStart = progress.completed - this.rateStartedCompleted;
    const etaSeconds =
      progress.total !== undefined &&
      progress.completed < progress.total &&
      elapsedSeconds >= 1 &&
      completedSinceStart > 0
        ? ((progress.total - progress.completed) * elapsedSeconds) / completedSinceStart
        : undefined;
    const message = formatIndexProgress(progress, etaSeconds);
    this.status = {
      ...this.status,
      progress,
      message,
      etaSeconds,
      revision: ++this.revision,
    };
    this.emitDiagnostic({
      area: "index",
      event: "index_operation",
      operation: progress.operation === "startup" ? "startup" : progress.operation,
      stage: "started",
      phase: progress.phase,
      completed: progress.completed,
      ...(progress.total === undefined ? {} : { total: progress.total }),
      unit: progress.unit,
      determinate: progress.determinate,
      ...(progress.generationId ? { generation: progress.generationId } : {}),
    });
    for (const listener of [...this.listeners]) listener(this.status);
  }

  cancel(): void {
    if (!this.controller) return;
    this.set("cancelling", this.status.hasLastGood, "Cancelling index…");
    this.controller.abort();
    this.actions.cancel();
  }

  private set(
    kind: IndexStatusKind,
    hasLastGood: boolean,
    message?: string,
    emitDiagnostic = true
  ): void {
    this.pendingProgress = undefined;
    if (this.progressTimer) this.timing.clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    this.status = {
      kind,
      revision: ++this.revision,
      hasLastGood,
      message,
      canIndex:
        kind === "ready" ||
        kind === "stale" ||
        kind === "cancelled" ||
        kind === "error" ||
        kind === "empty",
      canReindex:
        kind === "index-required" ||
        kind === "ready" ||
        kind === "stale" ||
        ((kind === "cancelled" || kind === "error" || kind === "empty") && hasLastGood),
      canCancel: kind === "building",
    };
    if (emitDiagnostic)
      this.emitDiagnostic({
        area: "index",
        event: "index_status",
        status: kind,
        revision: this.status.revision,
        hasLastGood,
      });
    for (const listener of [...this.listeners]) listener(this.status);
  }
  private make(kind: IndexStatusKind, hasLastGood: boolean, message?: string): IndexStatus {
    return {
      kind,
      revision: ++this.revision,
      hasLastGood,
      message,
      canIndex: false,
      canReindex: false,
      canCancel: false,
    };
  }
  private emitDiagnostic(record: TramaDiagnosticRecord): void {
    emitTramaDiagnostic(this.diagnostics, record);
  }
  private async start(kind: "index" | "reindex"): Promise<void> {
    if (this.controller) return;
    const elapsedMs = startDiagnosticTimer(() => this.timing.now());
    this.controller = new AbortController();
    this.set("building", this.status.hasLastGood, "Building index…");
    try {
      await (kind === "index"
        ? this.actions.index(this.controller.signal)
        : this.actions.reindex(this.controller.signal));
      if (this.status.kind === "building") this.set("ready", true);
      this.emitDiagnostic({
        area: "index",
        event: "index_operation",
        operation: kind === "index" ? "incremental" : "full",
        stage: "user-completed",
        durationMs: elapsedMs(),
      });
    } catch (error) {
      const cancelled = this.controller.signal.aborted;
      this.set(
        cancelled ? "cancelled" : "error",
        this.status.hasLastGood,
        cancelled ? "Indexing cancelled." : error instanceof Error ? error.message : String(error)
      );
      if (!cancelled) new Notice(this.status.message ?? "Indexing failed.");
    } finally {
      this.controller = undefined;
    }
  }

  /** Starts the requested operation when its command is currently available. */
  run(kind: "index" | "reindex"): Promise<void> {
    if (kind === "index" && !this.status.canIndex) return Promise.resolve();
    if (kind === "reindex" && !this.status.canReindex) return Promise.resolve();
    return this.start(kind);
  }
}
