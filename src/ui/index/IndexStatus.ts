import { Notice, Plugin } from "obsidian";
import {
  emitTramaDiagnostic,
  NOOP_TRAMA_DIAGNOSTICS,
  projectDiagnosticError,
  startDiagnosticTimer,
  TramaDiagnostics,
  TramaDiagnosticRecord,
} from "@/diagnostics/TramaDiagnostics";
import type { IndexProgress } from "@/domain/contracts";
import type { IndexCapabilities, IndexFreshness } from "@/domain/contracts";

export type IndexStatusKind =
  | "loading"
  | "index-required"
  | "ready"
  | "updating"
  | "stale"
  | "building"
  | "preparing"
  | "cancelling"
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
  readonly canPrepare: boolean;
  readonly canCancel: boolean;
  /** Latest orthogonal capability snapshot, independent of the operation kind. */
  readonly capabilities?: IndexCapabilities;
  readonly freshness?: IndexFreshness;
  readonly publicationId?: string;
  readonly publicationWarning?: string;
  /** Current automatic-work detail, independent of lexical readiness. */
  readonly schedulerMessage?: string;
}

const PHASE_LABELS: Record<IndexProgress["phase"], string> = {
  discover: "Finding lexical index notes",
  read: "Estimating lexical index size",
  chunk: "Chunking lexical index",
  embed: "Embedding semantic index chunks",
  "encode-write": "Writing lexical index",
  validate: "Validating lexical index",
  "build-vector": "Updating semantic index",
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
      ? "Rebuilding semantic index"
      : PHASE_LABELS[progress.phase];
  return `${label} — ${count}${eta}`;
}

interface StatusActions {
  index(signal: AbortSignal): Promise<void>;
  reindex(signal: AbortSignal): Promise<void>;
  forceUpdate?(signal: AbortSignal): Promise<void>;
  prepare?(signal: AbortSignal): Promise<void>;
  rebuildSemantic?(signal: AbortSignal): Promise<void>;
  rebuildBoth?(signal: AbortSignal): Promise<void>;
  publishNow?(): Promise<void>;
  cancel(): void;
}
interface StatusTiming {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

type IndexAction =
  "index" | "reindex" | "force-update" | "prepare" | "rebuild-semantic" | "rebuild-both";

export type IndexOperationChannel = "lexical" | "semantic";

/** Shared ownership fence for one manual or automatic index operation. */
export class IndexOperationLease {
  readonly signal: AbortSignal;
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private released = false;
  private releaseHandler?: (lease: IndexOperationLease) => void;

  constructor(
    readonly channel: IndexOperationChannel,
    readonly controller = new AbortController(),
    releaseHandler?: (lease: IndexOperationLease) => void
  ) {
    this.signal = controller.signal;
    this.releaseHandler = releaseHandler;
    this.done = new Promise<void>((resolve) => (this.resolveDone = resolve));
  }

  abort(): void {
    if (!this.signal.aborted) this.controller.abort();
  }

  attachRelease(handler: (lease: IndexOperationLease) => void): void {
    this.releaseHandler = handler;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.resolveDone();
    const handler = this.releaseHandler;
    this.releaseHandler = undefined;
    handler?.(this);
  }

  get isReleased(): boolean {
    return this.released;
  }
}

/** Owns the observable index state and user-facing index actions. */
export class IndexStatusController {
  private revision = 0;
  private controller?: AbortController;
  private activeLease?: IndexOperationLease;
  private operationChannel?: IndexOperationChannel;
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
      id: "index-filo-vault",
      name: "Update lexical index",
      callback: () => void this.run("index"),
      checkCallback: (checking: boolean) => {
        if (!this.status.canIndex) return false;
        if (!checking) void this.run("index");
        return true;
      },
    });
    this.plugin.addCommand({
      id: "reindex-filo-vault",
      name: "Rebuild lexical index",
      callback: () => void this.run("reindex"),
      checkCallback: (checking: boolean) => {
        if (!this.status.canReindex) return false;
        if (!checking) void this.run("reindex");
        return true;
      },
    });
    this.plugin.addCommand({
      id: "prepare-semantic-index",
      name: "Update semantic index",
      callback: () => void this.run("prepare"),
      checkCallback: (checking: boolean) => {
        if (!this.status.canPrepare || !this.actions.prepare) return false;
        if (!checking) void this.run("prepare");
        return true;
      },
    });
    this.plugin.addCommand({
      id: "rebuild-semantic-index",
      name: "Rebuild semantic index",
      callback: () => void this.run("rebuild-semantic"),
      checkCallback: (checking: boolean) => {
        if (!this.status.canPrepare || !this.actions.rebuildSemantic) return false;
        if (!checking) void this.run("rebuild-semantic");
        return true;
      },
    });
    this.plugin.addCommand({
      id: "rebuild-both-indexes",
      name: "Rebuild lexical and semantic indexes",
      callback: () => void this.run("rebuild-both"),
      checkCallback: (checking: boolean) => {
        if ((!this.status.canReindex && !this.status.canIndex) || !this.actions.rebuildBoth)
          return false;
        if (!checking) void this.run("rebuild-both");
        return true;
      },
    });
    this.plugin.addCommand({
      id: "force-update-indexes",
      name: "Update lexical and semantic indexes now",
      callback: () => void this.run("force-update"),
      checkCallback: (checking: boolean) => {
        if ((!this.status.canReindex && !this.status.canIndex) || !this.actions.forceUpdate)
          return false;
        if (!checking) void this.run("force-update");
        return true;
      },
    });
    this.plugin.addCommand({
      id: "publish-index-now",
      name: "Publish index now",
      callback: () => void this.actions.publishNow?.(),
      checkCallback: (checking: boolean) => {
        if (!this.actions.publishNow) return false;
        if (!checking) void this.actions.publishNow();
        return true;
      },
    });
    this.plugin.addCommand({
      id: "cancel-filo-indexing",
      name: "Cancel lexical or semantic indexing",
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
  getActiveLease(): IndexOperationLease | undefined {
    return this.activeLease;
  }
  /** Acquires the single shared operation slot for automatic work. */
  acquireExternalLease(
    channel: IndexOperationChannel,
    message = channel === "semantic" ? "Updating semantic index…" : "Updating lexical index…"
  ): IndexOperationLease | undefined {
    if (this.activeLease || this.controller) return undefined;
    const lease = new IndexOperationLease(channel, new AbortController(), (released) => {
      this.releaseExternalLease(released);
    });
    this.activeLease = lease;
    this.operationChannel = channel;
    this.set(channel === "semantic" ? "preparing" : "updating", this.status.hasLastGood, message);
    return lease;
  }
  /** Attaches an already-created automatic lease to this controller. */
  attachExternalLease(lease: IndexOperationLease, message?: string): boolean {
    if (this.activeLease || this.controller) return false;
    lease.attachRelease((released) => this.releaseExternalLease(released));
    this.activeLease = lease;
    this.operationChannel = lease.channel;
    this.set(
      lease.channel === "semantic" ? "preparing" : "updating",
      this.status.hasLastGood,
      message ??
        (lease.channel === "semantic" ? "Updating semantic index…" : "Updating lexical index…")
    );
    return true;
  }
  releaseExternalLease(lease: IndexOperationLease): void {
    if (this.activeLease !== lease) return;
    this.activeLease = undefined;
    this.controller = undefined;
    const channel = this.operationChannel;
    this.operationChannel = undefined;
    if (this.status.kind === "cancelling")
      this.set(
        "cancelled",
        this.status.hasLastGood,
        `${channel === "semantic" ? "Semantic" : "Lexical"} indexing cancelled.`
      );
    else if (
      this.status.kind === "building" ||
      this.status.kind === "updating" ||
      this.status.kind === "preparing"
    )
      this.set("ready", true);
  }
  hasActiveOperation(channel?: IndexOperationChannel): boolean {
    return Boolean(this.activeLease && (!channel || this.activeLease.channel === channel));
  }
  subscribe(listener: (status: IndexStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }
  setLoading(): void {
    this.set("loading", false, "Loading lexical and semantic indexes…");
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
      freshness: capabilities.freshness,
      publicationId: capabilities.publicationId,
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
  setSchedulerMessage(message?: string): void {
    this.status = {
      ...this.status,
      schedulerMessage: message,
      revision: ++this.revision,
    };
    for (const listener of [...this.listeners]) listener(this.status);
  }
  setUpdating(): void {
    this.set("updating", true, "Updating lexical index…");
  }
  markStale(
    hasLastGood = this.status.hasLastGood,
    message = "Lexical index has changes; update required."
  ): void {
    this.set("stale", hasLastGood, message);
  }
  markError(_error: unknown): void {
    this.emitDiagnostic({
      area: "index",
      event: "index_operation",
      operation: "status",
      stage: "failed",
      error: projectDiagnosticError(_error),
    });
    this.set(
      "error",
      this.status.hasLastGood,
      this.operationChannel === "semantic"
        ? "Unable to update the semantic index."
        : "Unable to build the lexical index."
    );
  }

  /** Accepts progress from the current index operation for the observable UI state. */
  reportProgress(progress: IndexProgress): void {
    if (
      this.status.kind !== "building" &&
      this.status.kind !== "preparing" &&
      this.status.kind !== "cancelling" &&
      this.status.kind !== "updating"
    )
      return;
    const previous = this.status.progress;
    if (
      previous?.changeCounter !== undefined && progress.changeCounter !== undefined
        ? previous.changeCounter !== progress.changeCounter
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

  cancel(): Promise<void> {
    const lease = this.activeLease;
    if (!lease) return Promise.resolve();
    const channel = this.operationChannel ?? "lexical";
    if (this.status.kind === "cancelling") return lease.done;
    this.set("cancelling", this.status.hasLastGood, `Cancelling ${channel} index…`);
    lease.abort();
    this.actions.cancel();
    return lease.done;
  }

  /** Starts explicit semantic preparation through the same controller used by
   * Build/Update/Rebuild, so progress and cancellation share one fence. */
  prepare(): Promise<void> {
    return this.run("prepare");
  }

  beginSemanticRebuild(): void {
    if (this.controller) {
      this.operationChannel = "semantic";
      this.set("preparing", true, "Rebuilding semantic index…");
    }
  }

  beginSemanticPreparation(): void {
    if (this.controller) {
      this.operationChannel = "semantic";
      this.set("preparing", true, "Updating semantic index…");
    }
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
      schedulerMessage: this.status.schedulerMessage,
      canIndex:
        kind === "index-required" ||
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
      canPrepare:
        kind === "ready" ||
        kind === "stale" ||
        (kind === "cancelled" && hasLastGood) ||
        (kind === "error" && hasLastGood),
      canCancel: kind === "building" || kind === "preparing" || kind === "updating",
      capabilities: this.status.capabilities,
      freshness: this.status.freshness,
      publicationId: this.status.publicationId,
      publicationWarning: this.status.publicationWarning,
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
      canPrepare: false,
      canCancel: false,
    };
  }
  private emitDiagnostic(record: TramaDiagnosticRecord): void {
    emitTramaDiagnostic(this.diagnostics, record);
  }
  private async start(kind: IndexAction): Promise<void> {
    if (this.activeLease || this.controller) return;
    if (kind === "prepare" && !this.actions.prepare) return;
    if (kind === "rebuild-semantic" && !this.actions.rebuildSemantic) return;
    if (kind === "rebuild-both" && !this.actions.rebuildBoth) return;
    if (kind === "force-update" && !this.actions.forceUpdate) return;
    const elapsedMs = startDiagnosticTimer(() => this.timing.now());
    this.operationChannel =
      kind === "prepare" || kind === "rebuild-semantic" ? "semantic" : "lexical";
    const lease = new IndexOperationLease(
      this.operationChannel,
      new AbortController(),
      (released) => {
        this.releaseExternalLease(released);
      }
    );
    this.activeLease = lease;
    this.controller = lease.controller;
    this.set(
      kind === "prepare" || kind === "rebuild-semantic" ? "preparing" : "building",
      this.status.hasLastGood,
      kind === "prepare"
        ? "Updating semantic index…"
        : kind === "rebuild-semantic"
          ? "Rebuilding semantic index…"
          : kind === "force-update"
            ? "Updating lexical and semantic indexes…"
            : kind === "index"
              ? "Updating lexical index…"
              : "Rebuilding lexical index…"
    );
    try {
      await (kind === "index"
        ? this.actions.index(lease.signal)
        : kind === "reindex"
          ? this.actions.reindex(lease.signal)
          : kind === "prepare"
            ? this.actions.prepare!(lease.signal)
            : kind === "rebuild-semantic"
              ? this.actions.rebuildSemantic!(lease.signal)
              : kind === "rebuild-both"
                ? this.actions.rebuildBoth!(lease.signal)
                : this.actions.forceUpdate!(lease.signal));
      this.emitDiagnostic({
        area: "index",
        event: "index_operation",
        operation:
          kind === "index" || kind === "prepare" || kind === "force-update"
            ? "incremental"
            : "full",
        stage: "user-completed",
        durationMs: elapsedMs(),
      });
    } catch (error) {
      const cancelled = lease.signal.aborted;
      const channel = this.operationChannel === "semantic" ? "Semantic" : "Lexical";
      const operation =
        kind === "index" || kind === "prepare" || kind === "force-update" ? "incremental" : "full";
      if (!cancelled)
        this.emitDiagnostic({
          area: "index",
          event: "index_operation",
          operation,
          stage: "failed",
          error: projectDiagnosticError(error),
        });
      const userMessage = cancelled
        ? `${channel} indexing cancelled.`
        : kind === "prepare"
          ? "Unable to update the semantic index."
          : kind === "rebuild-semantic"
            ? "Unable to rebuild the semantic index."
            : kind === "rebuild-both" || kind === "force-update"
              ? "Unable to update the lexical and semantic indexes."
              : "Unable to build the lexical index.";
      this.set(cancelled ? "cancelled" : "error", this.status.hasLastGood, userMessage);
      if (!cancelled) new Notice(this.status.message ?? "Indexing failed.");
    } finally {
      lease.release();
    }
  }

  /** Starts the requested operation when its command is currently available. */
  run(kind: IndexAction): Promise<void> {
    if (kind === "index" && !this.status.canIndex) return Promise.resolve();
    if (kind === "reindex" && !this.status.canReindex) return Promise.resolve();
    if (kind === "prepare" && !this.status.canPrepare) return Promise.resolve();
    if (kind === "rebuild-semantic" && !this.status.canPrepare) return Promise.resolve();
    if (kind === "rebuild-both" && !this.status.canReindex && !this.status.canIndex)
      return Promise.resolve();
    if (kind === "force-update" && !this.status.canReindex && !this.status.canIndex)
      return Promise.resolve();
    return this.start(kind);
  }
}
