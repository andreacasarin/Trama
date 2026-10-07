import { Notice, Plugin } from "obsidian";
import {
  emitTramaDiagnostic,
  diagnosticsEnabled,
  NOOP_TRAMA_DIAGNOSTICS,
  TramaDiagnostics,
  TramaDiagnosticInput,
} from "@/diagnostics/TramaDiagnostics";
import type { IndexProgress } from "@/domain/contracts";
import type { IndexCapabilities, IndexFreshness } from "@/domain/contracts";
import type { MaintenanceSnapshot } from "@/index/MaintenanceScheduler";

export type IndexStatusKind =
  | "loading"
  | "index-required"
  | "ready"
  | "stale"
  | "building"
  | "preparing"
  | "cancelled"
  | "error"
  | "empty";

export interface IndexStatus {
  readonly kind: IndexStatusKind;
  readonly channel?: "lexical" | "semantic";
  readonly revision: number;
  readonly hasLastGood: boolean;
  readonly progress?: IndexProgress;
  readonly changeCounter?: number;
  readonly etaSeconds?: number;
  readonly message?: string;
  readonly canIndex: boolean;
  readonly canReindex: boolean;
  readonly canCancel: boolean;
  /** Latest orthogonal capability snapshot, independent of the operation kind. */
  readonly capabilities?: IndexCapabilities;
  readonly freshness?: IndexFreshness;
  readonly publicationWarning?: string;
  readonly maintenance?: MaintenanceSnapshot;
}

const PHASE_LABELS: Record<IndexProgress["phase"], string> = {
  discover: "Finding lexical index notes",
  read: "Estimating lexical index size",
  chunk: "Chunking lexical index",
  embed: "Embedding semantic index chunks",
  "encode-write": "Writing lexical index",
  validate: "Validating lexical index",
  "build-vector": "Updating embeddings",
  "build-lexical": "Preparing lexical index",
  activate: "Activating lexical index",
  GC: "Cleaning up lexical index data",
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
  const label =
    progress.phase === "build-vector" && progress.operation === "full"
      ? "Rebuilding embeddings"
      : PHASE_LABELS[progress.phase];
  return `${label} — ${count}${eta}`;
}

interface StatusActions {
  update(): Promise<void>;
  rebuild(): Promise<void>;
  reset(): Promise<void>;
  clearShared?(): Promise<void>;
  share?(): Promise<void>;
  importShared?(): Promise<void>;
  stop(): void;
}
interface StatusTiming {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

type IndexAction = "index" | "reindex";

/** Projects index state and forwards user actions to the maintenance owner. */
export class IndexStatusController {
  private revision = 0;
  private operationChannel?: "lexical" | "semantic";
  private maintenance?: MaintenanceSnapshot;
  private readonly listeners = new Set<(status: IndexStatus) => void>();
  private progressTimer?: ReturnType<typeof setTimeout>;
  private pendingProgress?: IndexProgress;
  private progressAt = -Infinity;
  private readonly rates = new Map<string, { startedAt: number; startedCompleted: number }>();
  private status: IndexStatus = this.make(
    "loading",
    false,
    "Loading lexical and semantic indexes…"
  );

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
      id: "update-index",
      name: "Update search indexes",
      callback: () => void this.run("index"),
      checkCallback: (checking: boolean) => {
        if (!this.status.canIndex) return false;
        if (!checking) void this.run("index");
        return true;
      },
    });
    this.plugin.addCommand({
      id: "clear-indexes-and-shared-cache",
      name: "Clear local search data and shared embeddings",
      callback: () => {
        void this.actions.clearShared?.().catch((error) => {
          new Notice(
            `Trama index clear failed: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      },
    });
    this.plugin.addCommand({
      id: "rebuild-index",
      name: "Rebuild embeddings",
      callback: () => void this.run("reindex"),
      checkCallback: (checking: boolean) => {
        if (!this.status.canReindex) return false;
        if (!checking) void this.run("reindex");
        return true;
      },
    });
    this.plugin.addCommand({
      id: "reset-all-indexes",
      name: "Reset local search data",
      callback: () => {
        void this.actions.reset().catch((error) => {
          new Notice(
            `Trama index reset failed: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      },
    });
    for (const [id, name, action] of [
      ["publish-embeddings", "Share embeddings", this.actions.share],
      ["import-shared-embeddings", "Import shared embeddings", this.actions.importShared],
    ] as const) {
      if (!action) continue;
      this.plugin.addCommand({
        id,
        name,
        callback: () => {
          void action().catch(
            (error) =>
              new Notice(
                `Trama ${name.toLowerCase()} failed: ${error instanceof Error ? error.message : String(error)}`
              )
          );
        },
      });
    }
    this.plugin.addCommand({
      id: "stop-index-maintenance",
      name: "Stop index maintenance",
      callback: () => this.actions.stop(),
      checkCallback: (checking: boolean) => {
        if (!this.status.canCancel) return false;
        if (!checking) this.actions.stop();
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
  setIndexRequired(silent = false): void {
    this.set("index-required", false, "Lexical index required.", !silent);
  }
  setEmpty(hasLastGood = false, silent = false): void {
    this.set("empty", hasLastGood, "Lexical index has no Markdown notes.", !silent);
  }
  setReady(silent = false): void {
    this.set("ready", true, undefined, !silent);
  }
  setCapabilities(capabilities: IndexCapabilities): void {
    this.status = {
      ...this.status,
      capabilities,
      hasLastGood: capabilities.lexical.searchable || capabilities.semantic.searchable,
      freshness: capabilities.freshness,
      revision: ++this.revision,
    };
    for (const listener of [...this.listeners]) listener(this.status);
  }
  setPublicationWarning(message?: string): void {
    this.status = {
      ...this.status,
      ...(message ? { publicationWarning: message } : { publicationWarning: undefined }),
      revision: ++this.revision,
    };
    for (const listener of [...this.listeners]) listener(this.status);
  }
  markStale(
    hasLastGood = this.status.hasLastGood,
    message = "Index has changes; update required."
  ): void {
    this.set("stale", hasLastGood, message);
  }
  markError(error: unknown): void {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
    this.set("error", this.status.hasLastGood, message);
  }

  /** Accepts progress from the current index operation for the observable UI state. */
  reportProgress(progress: IndexProgress): void {
    if (this.status.kind !== "building" && this.status.kind !== "preparing") return;
    const previous = this.status.progress;
    if (
      previous?.changeCounter !== undefined && progress.changeCounter !== undefined
        ? progress.changeCounter < previous.changeCounter
        : previous?.generationId &&
          progress.generationId &&
          previous.generationId !== progress.generationId
    )
      return;
    if (
      previous &&
      previous.operation === progress.operation &&
      previous.phase === progress.phase &&
      previous.changeCounter === progress.changeCounter &&
      previous.generationId === progress.generationId &&
      progress.completed < previous.completed
    )
      return;
    const phaseChanged =
      !previous ||
      previous.phase !== progress.phase ||
      previous.operation !== progress.operation ||
      previous.changeCounter !== progress.changeCounter ||
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
    const rateKey = `${progress.operation}:${progress.phase}`;
    if (!this.rates.has(rateKey) || progress.completed === 0)
      this.rates.set(rateKey, { startedAt: now, startedCompleted: progress.completed });
    const rate = this.rates.get(rateKey)!;
    const elapsedSeconds = (now - rate.startedAt) / 1_000;
    const completedSinceStart = progress.completed - rate.startedCompleted;
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
      changeCounter: progress.changeCounter,
      message,
      etaSeconds,
      revision: ++this.revision,
    };
    for (const listener of [...this.listeners]) listener(this.status);
  }

  setMaintenance(snapshot: MaintenanceSnapshot, capabilities?: IndexCapabilities): void {
    this.maintenance = snapshot;
    if (capabilities)
      this.status = {
        ...this.status,
        capabilities,
        hasLastGood: capabilities.lexical.searchable || capabilities.semantic.searchable,
        freshness: capabilities.freshness,
      };
    if (snapshot.lane === "adoption") {
      this.set(
        "stale",
        this.status.hasLastGood,
        snapshot.phase === "queued"
          ? "Search update queued; finishing the current shared embeddings import…"
          : "Importing shared embeddings…",
        false
      );
      return;
    }
    if (snapshot.lane === "idle") {
      if (snapshot.error !== undefined) {
        this.markError(snapshot.error);
        return;
      }
      if (snapshot.suspended) {
        this.set("cancelled", this.status.hasLastGood, "Index maintenance stopped.");
        return;
      }
      if (snapshot.pending) {
        this.markStale(this.status.hasLastGood);
        return;
      }
      this.projectCompletedMaintenance();
      return;
    }
    if (snapshot.phase === "semantic") this.operationChannel = "semantic";
    else if (snapshot.phase !== "publication") this.operationChannel = "lexical";
    const kind = this.operationChannel === "semantic" ? "preparing" : "building";
    const label =
      snapshot.phase === "reset"
        ? "Resetting local search data…"
        : snapshot.phase === "results"
          ? "Updating related notes…"
          : snapshot.phase === "publication"
            ? "Sharing embeddings…"
            : snapshot.phase === "semantic"
              ? "Updating embeddings…"
              : snapshot.lane === "rebuild"
                ? "Rebuilding index…"
                : "Updating index…";
    this.set(kind, this.status.hasLastGood, label, false);
  }

  private projectCompletedMaintenance(): void {
    const lexical = this.status.capabilities?.lexical;
    if (!lexical) {
      this.setReady();
      return;
    }
    if (lexical.state === "empty") {
      this.setEmpty(this.status.hasLastGood);
      return;
    }
    if (lexical.state === "unavailable" || lexical.state === "incompatible") {
      this.setIndexRequired();
      return;
    }
    if (lexical.state === "partial") {
      this.markStale(this.status.hasLastGood, "Lexical index is incomplete; update required.");
      return;
    }
    if (this.status.freshness !== undefined && this.status.freshness !== "locally-reconciled") {
      this.markStale(
        this.status.hasLastGood,
        "Index snapshot loaded; local reconciliation required."
      );
      return;
    }
    this.setReady();
  }

  private set(
    kind: IndexStatusKind,
    hasLastGood: boolean,
    message?: string,
    emitDiagnostic = true
  ): void {
    this.pendingProgress = undefined;
    this.rates.clear();
    if (this.progressTimer) this.timing.clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    this.status = {
      kind,
      channel: this.operationChannel,
      revision: ++this.revision,
      hasLastGood,
      changeCounter: this.status.changeCounter,
      message,
      canIndex: kind !== "loading",
      canReindex: kind !== "loading",
      canCancel:
        kind === "building" ||
        kind === "preparing" ||
        this.maintenance?.lane === "adoption" ||
        (this.maintenance?.pending === true && !this.maintenance.suspended),
      capabilities: this.status.capabilities,
      freshness: this.status.freshness,
      publicationWarning: this.status.publicationWarning,
      maintenance: this.maintenance,
    };
    if (emitDiagnostic && diagnosticsEnabled(this.diagnostics, "detailed"))
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
  private emitDiagnostic(record: TramaDiagnosticInput): void {
    emitTramaDiagnostic(this.diagnostics, record);
  }
  /** Starts the requested operation when its command is currently available. */
  run(kind: IndexAction): Promise<void> {
    if (kind === "index" && !this.status.canIndex) return Promise.resolve();
    if (kind === "reindex" && !this.status.canReindex) return Promise.resolve();
    const action = kind === "index" ? this.actions.update() : this.actions.rebuild();
    return action.catch((error) => {
      new Notice(
        `Trama index ${kind === "index" ? "update" : "rebuild"} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
}
