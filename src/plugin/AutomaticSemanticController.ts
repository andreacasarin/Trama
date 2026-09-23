import { projectDiagnosticError } from "@/diagnostics/TramaDiagnostics";
import type { IndexManager } from "@/index/IndexManager";
import type { IndexOperationLease } from "@/ui/index/IndexOperationLease";
import { isRetryableError, type SchedulerHost, type SchedulerSource } from "@/plugin/scheduler";

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
  private stopPaused = false;

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
  } {
    return {
      running: Boolean(this.promise),
      retryScheduled: Boolean(this.retryTimer),
      retryAttempt: this.retryAttempt,
      delayed: Boolean(this.timer),
      eligible: this.eligible,
      retryPaused: this.retryPaused,
    };
  }

  activeWork(): Promise<void> | undefined {
    return this.promise;
  }

  markEligibleIfPending(manager?: IndexManager): void {
    this.eligible ||= this.hasWork(manager);
  }

  replaceEligibility(manager?: IndexManager): void {
    this.eligible = this.hasWork(manager);
  }

  clearEligibility(): void {
    this.eligible = false;
  }

  resetForManualOperation(): void {
    this.stopPaused = false;
  }

  resetForSettings(): void {
    this.retryAttempt = 0;
    this.retryPaused = false;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.abort?.abort();
    this.abort = undefined;
  }

  pauseForLexicalWork(): void {
    this.stop();
    this.stopPaused = false;
    this.retryAttempt = 0;
    this.retryPaused = false;
  }

  cancelActive(): void {
    if (!this.lease) return;
    this.stopPaused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.lease.abort();
  }

  schedule(source: SchedulerSource = "event"): void {
    const delay = this.host.getSettings().filo.automaticSemanticDelayMs;
    const manager = this.host.getIndex();
    if (delay <= 0) {
      this.host.emitSchedulerTransition({ channel: "semantic", stage: "disabled", source });
      return;
    }
    if (
      !manager ||
      !this.host.isIndexReady() ||
      !manager.isComplete() ||
      this.host.hasQueuedLexicalWork() ||
      !this.eligible ||
      this.retryPaused ||
      this.stopPaused ||
      this.host.hasActiveLexicalReconciliation() ||
      this.host.getIndexStatus()?.hasActiveOperation("lexical")
    ) {
      if (manager?.isComplete() && !this.eligible)
        this.host.emitSchedulerTransition({
          channel: "semantic",
          stage: "incomplete",
          source,
          delayMs: delay,
        });
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.host.emitSchedulerTransition({
      channel: "semantic",
      stage: "delayed",
      source,
      delayMs: delay,
    });
    this.timer = setTimeout(() => {
      this.timer = undefined;
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
    if (
      !manager ||
      this.host.getSettings().filo.automaticSemanticDelayMs <= 0 ||
      !this.host.isIndexReady() ||
      !manager.isComplete() ||
      manager.isBuilding() ||
      this.host.hasQueuedLexicalWork() ||
      !this.eligible ||
      this.retryPaused ||
      this.stopPaused ||
      this.host.hasActiveLexicalReconciliation() ||
      this.host.getIndexStatus()?.hasActiveOperation("lexical")
    )
      return Promise.resolve();

    const lease = this.host.getIndexStatus()?.acquireExternalLease("semantic");
    if (!lease) return Promise.resolve();
    this.lease = lease;
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
          this.retryAttempt = 0;
          this.retryPaused = false;
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
        } else if (isRetryableError(error)) this.scheduleRetry(error);
        else {
          this.eligible = false;
          this.retryPaused = true;
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
            void this.runBatch();
          }, 100);
        }
      }
    })();
    this.host.refreshSchedulerMessage();
    return this.promise;
  }
}
