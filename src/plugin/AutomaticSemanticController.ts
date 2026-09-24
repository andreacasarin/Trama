import { projectDiagnosticError } from "@/diagnostics/TramaDiagnostics";
import type { IndexManager } from "@/index/IndexManager";
import type { IndexOperationLease } from "@/ui/index/IndexOperationLease";
import { isRetryableError, type SchedulerHost, type SchedulerSource } from "@/plugin/scheduler";

type SemanticDeferralReason =
  | "index-unavailable"
  | "index-incomplete"
  | "manager-maintenance"
  | "lexical-pending"
  | "lexical-reconciliation"
  | "lexical-lease"
  | "semantic-lease"
  | "retry-paused"
  | "stopped";

export interface AutomaticSemanticHost extends SchedulerHost {
  hasQueuedLexicalWork(): boolean;
  hasActiveLexicalReconciliation(): boolean;
  getSchedulerSource(): SchedulerSource;
  setSchedulerSource(source: SchedulerSource): void;
}

export class AutomaticSemanticController {
  private timer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;
  private lease?: IndexOperationLease;
  private promise?: Promise<void>;
  private retryAttempt = 0;
  private retryPaused = false;
  private eligible = false;
  /** A scheduling request remains owned here until it is run or explicitly cleared. */
  private pendingIntent = false;
  private deferredReason?: SemanticDeferralReason;
  private lastDeferredReason?: SemanticDeferralReason;
  private stopPaused = false;
  private delayElapsed = false;

  constructor(private readonly host: AutomaticSemanticHost) {}

  hasWork(manager?: IndexManager): boolean {
    return manager?.hasPendingSemanticWork() ?? false;
  }

  snapshot(): {
    running: boolean;
    retryScheduled: boolean;
    retryAttempt: number;
    delayed: boolean;
    eligible: boolean;
    retryPaused: boolean;
    pending: boolean;
    deferred: boolean;
    deferredReason?: SemanticDeferralReason;
  } {
    return {
      running: Boolean(this.promise),
      retryScheduled: Boolean(this.retryTimer),
      retryAttempt: this.retryAttempt,
      delayed: Boolean(this.timer),
      eligible: this.eligible,
      retryPaused: this.retryPaused,
      pending: this.pendingIntent,
      deferred:
        this.pendingIntent &&
        !this.promise &&
        !this.timer &&
        !this.retryTimer &&
        Boolean(this.deferredReason),
      deferredReason: this.deferredReason,
    };
  }

  activeWork(): Promise<void> | undefined {
    return this.promise;
  }

  markEligibleIfPending(manager?: IndexManager): void {
    if (this.hasWork(manager)) {
      this.eligible = true;
      this.pendingIntent = true;
    }
  }

  replaceEligibility(manager?: IndexManager): void {
    this.eligible = this.hasWork(manager);
    this.pendingIntent = this.eligible;
    if (!this.eligible) this.clearDeferred();
  }

  clearEligibility(): void {
    this.eligible = false;
    this.pendingIntent = false;
    this.clearDeferred();
  }

  resetForManualOperation(): void {
    this.stopPaused = false;
  }

  resetForSettings(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.delayElapsed = false;
    this.clearDeferred();
    this.retryAttempt = 0;
    this.retryPaused = false;
    this.stopPaused = false;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.abort?.abort();
    this.abort = undefined;
    this.delayElapsed = false;
    this.clearDeferred();
  }

  pauseForLexicalWork(): void {
    this.stop();
    this.stopPaused = false;
    this.retryAttempt = 0;
    this.retryPaused = false;
    if (this.pendingIntent) this.defer("event", "lexical-pending");
  }

  cancelActive(): void {
    if (!this.lease) return;
    this.stopPaused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.lease.abort();
    this.defer("event", "stopped");
  }

  /** Wakes a sticky request after a composition-owned blocker has settled. */
  notifyBlockerCleared(source: SchedulerSource = "event"): void {
    if (!this.pendingIntent || !this.eligible || this.stopPaused) return;
    if (this.promise || this.timer || this.retryTimer) return;
    this.schedule(source);
  }

  schedule(source: SchedulerSource = "event"): void {
    const delay = this.host.getSettings().filo.automaticSemanticDelayMs;
    const manager = this.host.getIndex();
    if (!this.eligible && this.hasWork(manager)) {
      this.eligible = true;
      this.pendingIntent = true;
    }
    if (delay <= 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.clearDeferred();
      this.host.emitSchedulerTransition({ channel: "semantic", stage: "disabled", source });
      return;
    }
    if (!this.eligible) {
      return;
    }
    if (this.promise || this.timer || this.retryTimer) return;
    if (!manager) {
      this.defer(source, "index-unavailable");
      return;
    }
    this.pendingIntent = true;
    const reason = this.blocker(manager);
    if (reason) {
      this.defer(source, reason);
      return;
    }
    this.clearDeferred();
    if (this.delayElapsed) {
      this.delayElapsed = false;
      void this.runBatch(source);
      return;
    }
    if (this.timer || this.retryTimer) return;
    this.host.emitSchedulerTransition({
      channel: "semantic",
      stage: "delayed",
      source,
      delayMs: delay,
    });
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.delayElapsed = true;
      void this.runBatch(source === "retry" ? "retry" : source);
    }, delay);
    this.host.refreshSchedulerMessage();
  }

  private scheduleRetry(error: unknown): void {
    if (
      !isRetryableError(error) ||
      this.host.getSettings().filo.automaticSemanticDelayMs <= 0 ||
      this.host.hasQueuedLexicalWork() ||
      this.stopPaused
    )
      return;
    const delays = [5_000, 15_000, 60_000];
    if (this.retryAttempt >= delays.length) {
      this.retryPaused = true;
      return;
    }
    const delay = delays[this.retryAttempt++];
    this.host.emitSchedulerTransition({
      channel: "semantic",
      stage: "retrying",
      source: "retry",
      delayMs: delay,
      retryAttempt: this.retryAttempt,
    });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.delayElapsed = false;
      void this.runBatch("retry");
    }, delay);
    this.host.refreshSchedulerMessage();
  }

  runBatch(source: SchedulerSource = "event"): Promise<void> {
    if (this.promise)
      return this.promise.then(() => {
        if (this.eligible && !this.host.hasQueuedLexicalWork()) this.schedule();
      });
    const manager = this.host.getIndex();
    if (!manager || this.host.getSettings().filo.automaticSemanticDelayMs <= 0) {
      if (this.pendingIntent) this.defer(source, "index-unavailable");
      return Promise.resolve();
    }
    const reason = this.blocker(manager);
    if (reason) {
      if (this.pendingIntent || this.eligible) this.defer(source, reason);
      return Promise.resolve();
    }
    if (!this.eligible) return Promise.resolve();

    const lease = this.host.getIndexStatus()?.acquireExternalLease("semantic");
    if (!lease) {
      this.defer(source, "semantic-lease");
      return Promise.resolve();
    }
    this.lease = lease;
    this.delayElapsed = false;
    const controller = lease.controller;
    this.abort = controller;
    const startedAt = Date.now();
    const previousSource = this.host.getSchedulerSource();
    this.host.setSchedulerSource(source);
    this.host.emitSchedulerTransition({ channel: "semantic", stage: "running", source });
    this.promise = (async () => {
      let continueCatchup = false;
      try {
        const result = await manager.prepareSemanticCacheBatch(controller.signal);
        if (controller.signal.aborted) throw new Error("Semantic indexing cancelled.");
        if (this.host.getIndex() !== manager) return;
        this.host.emitSchedulerTransition({
          channel: "semantic",
          stage: result.converged ? "completed" : "incomplete",
          source,
          durationMs: Date.now() - startedAt,
          counts: { stored: result.stored, skipped: result.skipped },
        });
        if (result.converged) {
          this.eligible = false;
          this.pendingIntent = false;
          this.retryAttempt = 0;
          this.retryPaused = false;
          this.clearDeferred();
        } else if (
          !controller.signal.aborted &&
          !this.stopPaused &&
          !this.host.hasQueuedLexicalWork() &&
          manager.isComplete()
        ) {
          continueCatchup = true;
        }
      } catch (error) {
        this.host.emitSchedulerTransition({
          channel: "semantic",
          stage: controller.signal.aborted ? "cancelled" : "failed",
          source,
          durationMs: Date.now() - startedAt,
          error: projectDiagnosticError(error),
        });
        if (controller.signal.aborted) {
          if (this.stopPaused) {
            if (this.retryTimer) clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
          }
        } else if (isRetryableError(error)) {
          const current = this.host.getIndex();
          const blocker = current ? this.blocker(current) : "index-unavailable";
          if (blocker) this.defer(source, blocker);
          else this.scheduleRetry(error);
        } else {
          this.eligible = false;
          this.pendingIntent = false;
          this.retryPaused = true;
          this.clearDeferred();
          this.host.getIndexStatus()?.markError(error);
        }
      } finally {
        if (this.host.getIndex() === manager && !continueCatchup)
          this.host.updateIndexCapabilities(manager);
        if (this.abort === controller) this.abort = undefined;
        this.promise = undefined;
        lease.release();
        if (this.lease === lease) this.lease = undefined;
        this.host.setSchedulerSource(previousSource);
        if (continueCatchup && !this.stopPaused) {
          this.timer = setTimeout(() => {
            this.timer = undefined;
            this.delayElapsed = false;
            void this.runBatch();
          }, 100);
        }
        if (this.pendingIntent && !this.stopPaused) this.notifyBlockerCleared(source);
      }
    })();
    this.host.refreshSchedulerMessage();
    return this.promise;
  }

  private blocker(manager: IndexManager): SemanticDeferralReason | undefined {
    if (!this.host.isIndexReady()) return "index-unavailable";
    if (!manager.isComplete()) return "index-incomplete";
    if (manager.isBuilding() || manager.isInMaintenance?.()) return "manager-maintenance";
    if (this.host.hasQueuedLexicalWork()) return "lexical-pending";
    if (this.host.hasActiveLexicalReconciliation()) return "lexical-reconciliation";
    if (this.host.getIndexStatus()?.hasActiveOperation("lexical")) return "lexical-lease";
    if (this.retryPaused) return "retry-paused";
    if (this.stopPaused) return "stopped";
    return undefined;
  }

  private defer(source: SchedulerSource, reason: SemanticDeferralReason): void {
    this.pendingIntent = true;
    this.deferredReason = reason;
    if (this.lastDeferredReason !== reason) {
      this.lastDeferredReason = reason;
      this.host.emitSchedulerTransition({
        channel: "semantic",
        stage: "deferred",
        source,
        deferredReason: reason,
      });
    }
    this.host.refreshSchedulerMessage();
  }

  private clearDeferred(): void {
    this.deferredReason = undefined;
    this.lastDeferredReason = undefined;
  }
}
