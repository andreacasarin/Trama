import { projectDiagnosticError } from "@/diagnostics/TramaDiagnostics";
import type { IndexPathMutation } from "@/index/IndexManager";
import type { IndexOperationLease } from "@/ui/index/IndexStatus";
import { isRetryableError, type SchedulerHost, type SchedulerSource } from "@/plugin/scheduler";

export interface AutomaticLexicalHost extends SchedulerHost {
  getLifecycleSignal(): AbortSignal | undefined;
  pausePublication(): void;
  pauseSemantic(): void;
  markSemanticEligible(): void;
  scheduleSemantic(): void;
  refreshViews(changed: boolean): void;
  getLayoutReady(): boolean;
  getIndexLoaded(): boolean;
  setSchedulerSource(source: SchedulerSource): void;
  getSchedulerSource(): SchedulerSource;
  incrementVaultEventRevision(): void;
}

export class AutomaticLexicalController {
  abort?: AbortController;
  lease?: IndexOperationLease;
  reschedulePending = false;
  startupRecoveryStarted = false;
  eventTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  retryAttempt = 0;
  retryPaused = false;
  stopPaused = false;
  reconcilePromise?: Promise<void>;
  queuedWork = false;

  constructor(private readonly host: AutomaticLexicalHost) {}

  arm(): void {
    if (this.host.getSettings().filo.automaticLexicalDelayMs <= 0) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAttempt = 0;
    this.retryPaused = false;
    this.stopPaused = false;
    this.maybeScheduleStartupRecovery();
    if (this.queuedWork && this.host.isIndexReady()) this.schedule();
  }

  maybeScheduleStartupRecovery(): void {
    const manager = this.host.getIndex();
    if (
      !this.host.getLayoutReady() ||
      !this.host.getIndexLoaded() ||
      !manager ||
      this.startupRecoveryStarted ||
      this.host.getSettings().filo.automaticLexicalDelayMs <= 0
    )
      return;
    this.startupRecoveryStarted = true;
    manager.requestFullRecovery();
    this.queuedWork = true;
    if (this.host.isIndexReady()) this.schedule("startup");
  }

  stop(markStale = true, rescheduleAfterAbort = false): void {
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.abort) {
      this.abort.abort();
      this.abort = undefined;
      if (rescheduleAfterAbort) this.reschedulePending = true;
      this.queuedWork = true;
    }
    if (markStale && this.queuedWork) this.markStale();
  }

  cancelActive(): void {
    if (!this.lease) return;
    this.stopPaused = true;
    this.reschedulePending = false;
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.lease.abort();
  }

  markStale(): void {
    const status = this.host.getIndexStatus();
    if (!status) return;
    const manager = this.host.getIndex();
    status.markStale(manager?.hasUsableIndex?.() ?? this.host.isIndexReady());
  }

  queueMutation(mutation: IndexPathMutation): void {
    const manager = this.host.getIndex();
    if (!manager) return;
    this.host.pausePublication();
    this.host.markSemanticEligible();
    this.host.pauseSemantic();
    this.resetAfterEvent();
    this.host.incrementVaultEventRevision();
    manager.recordPathMutation(mutation);
    this.host.emitSchedulerTransition({
      channel: "lexical",
      stage: "queued",
      source: "event",
      delayMs: this.host.getSettings().filo.automaticLexicalDelayMs,
      counts: { events: 1, queued: manager.pendingChangeCount() },
    });
    this.queuedWork = true;
    if (this.host.isIndexReady() && this.host.getSettings().filo.automaticLexicalDelayMs > 0) {
      if (!manager.isBuilding() && manager.capabilities().semantic.activity !== "updating")
        this.host.getIndexStatus()?.setUpdating();
      this.schedule();
    } else if (
      this.host.isIndexReady() &&
      manager.capabilities().semantic.activity !== "updating"
    ) {
      this.markStale();
    }
    this.host.refreshSchedulerMessage();
  }

  requestFullRecovery(): void {
    const manager = this.host.getIndex();
    if (!manager) return;
    this.host.pausePublication();
    this.host.markSemanticEligible();
    this.host.pauseSemantic();
    this.resetAfterEvent();
    this.host.incrementVaultEventRevision();
    manager.requestFullRecovery();
    this.queuedWork = true;
    this.host.emitSchedulerTransition({
      channel: "lexical",
      stage: "queued",
      source: "event",
      delayMs: this.host.getSettings().filo.automaticLexicalDelayMs,
      counts: { events: 1, queued: manager.pendingChangeCount(), fullRecovery: 1 },
    });
    if (this.host.isIndexReady() && this.host.getSettings().filo.automaticLexicalDelayMs > 0)
      this.schedule();
    else if (this.host.isIndexReady()) this.markStale();
    this.host.refreshSchedulerMessage();
  }

  private resetAfterEvent(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAttempt = 0;
    this.retryPaused = false;
    this.stopPaused = false;
  }

  schedule(source: SchedulerSource = "event"): void {
    const delay = this.host.getSettings().filo.automaticLexicalDelayMs;
    if (delay <= 0 || !this.queuedWork || this.stopPaused) return;
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.host.emitSchedulerTransition({
      channel: "lexical",
      stage: "delayed",
      source,
      delayMs: delay,
      counts: { queued: this.host.getIndex()?.pendingChangeCount() ?? 0 },
    });
    this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined;
      void this.reconcile("automatic", undefined, source).catch(() => undefined);
    }, delay);
    this.host.refreshSchedulerMessage();
  }

  private scheduleRetry(error: unknown): void {
    if (
      !isRetryableError(error) ||
      this.host.getSettings().filo.automaticLexicalDelayMs <= 0 ||
      this.stopPaused
    )
      return;
    const delays = [5_000, 15_000, 60_000];
    if (this.retryAttempt >= delays.length) {
      this.retryPaused = true;
      this.host.emitSchedulerTransition({
        channel: "lexical",
        stage: "failed",
        source: "retry",
        retryAttempt: this.retryAttempt,
        counts: { queued: this.host.getIndex()?.pendingChangeCount() ?? 0 },
      });
      this.host.refreshSchedulerMessage();
      return;
    }
    const delay = delays[this.retryAttempt++];
    this.host.emitSchedulerTransition({
      channel: "lexical",
      stage: "retrying",
      source: "retry",
      delayMs: delay,
      retryAttempt: this.retryAttempt,
      counts: { queued: this.host.getIndex()?.pendingChangeCount() ?? 0 },
    });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.queuedWork || this.host.getSettings().filo.automaticLexicalDelayMs <= 0) return;
      if (this.eventTimer) clearTimeout(this.eventTimer);
      this.eventTimer = undefined;
      void this.reconcile("automatic", undefined, "retry").catch(() => undefined);
    }, delay);
    this.host.refreshSchedulerMessage();
  }

  reconcile(
    source: "automatic" | "explicit" = "explicit",
    explicitSignal?: AbortSignal,
    trigger: SchedulerSource = source === "automatic" ? "event" : "explicit"
  ): Promise<void> {
    if (source === "automatic" && this.host.getSettings().filo.automaticLexicalDelayMs <= 0)
      return Promise.resolve();
    const manager = this.host.getIndex();
    const lifecycleSignal = this.host.getLifecycleSignal();
    if (!manager || !this.host.isIndexReady() || !lifecycleSignal) return Promise.resolve();
    if (manager.isBuilding()) return Promise.resolve();
    if (manager.capabilities().semantic.activity === "updating") {
      this.queuedWork = true;
      return Promise.resolve();
    }
    if (this.reconcilePromise) {
      this.queuedWork = true;
      return this.reconcilePromise;
    }
    const eventRevision = this.host.getVaultEventRevision();
    const journal = manager.journalSnapshot();
    const changes = journal.changes;
    const queuedCount = manager.pendingChangeCount();
    this.queuedWork = false;
    this.host.pausePublication();
    const automaticLease =
      source === "automatic"
        ? this.host.getIndexStatus()?.acquireExternalLease("lexical")
        : undefined;
    if (source === "automatic" && !automaticLease) {
      this.queuedWork = true;
      return Promise.resolve();
    }
    if (source === "automatic") {
      this.lease = automaticLease;
      this.abort = automaticLease!.controller;
    }
    const operationSignal =
      source === "automatic" ? automaticLease!.signal : (explicitSignal ?? lifecycleSignal);
    let completed = false;
    const startedAt = Date.now();
    const previousSource = this.host.getSchedulerSource();
    this.host.setSchedulerSource(trigger);
    if (source === "automatic")
      this.host.emitSchedulerTransition({
        channel: "lexical",
        stage: "running",
        source: trigger,
        counts: { queued: queuedCount },
      });
    this.reconcilePromise = (async () => {
      try {
        const fullRecovery = journal.fullRecovery || changes.length === 0 || !manager.isComplete();
        const result = fullRecovery
          ? await manager.synchronize(operationSignal)
          : await manager.reconcileChanges(changes, operationSignal);
        if (operationSignal.aborted) throw new Error("Lexical indexing cancelled.");
        if (result.converged) manager.clearJournalIfCurrent(journal.revision);
        const current =
          result.converged &&
          manager.isComplete() &&
          eventRevision === this.host.getVaultEventRevision() &&
          !manager.hasPendingWork();
        if (current) {
          this.queuedWork = false;
          this.retryAttempt = 0;
          this.retryPaused = false;
          if (this.retryTimer) clearTimeout(this.retryTimer);
          this.retryTimer = undefined;
        } else {
          this.queuedWork = true;
        }
        completed = true;
        if (source === "automatic")
          this.host.emitSchedulerTransition({
            channel: "lexical",
            stage: result.converged ? "completed" : "incomplete",
            source: trigger,
            durationMs: Date.now() - startedAt,
            counts: { queued: queuedCount },
          });
        this.host.updateIndexCapabilities(manager);
        if (current) this.host.getIndexStatus()?.setReady();
        else
          this.host
            .getIndexStatus()
            ?.markStale(manager.hasUsableIndex?.() ?? this.host.isIndexReady());
        this.host.refreshViews(result.changed);
        if (result.converged && manager.isComplete()) {
          this.host.markSemanticEligible();
          this.host.scheduleSemantic();
        }
      } catch (error) {
        if (source === "automatic")
          this.host.emitSchedulerTransition({
            channel: "lexical",
            stage: operationSignal.aborted ? "cancelled" : "failed",
            source: trigger,
            durationMs: Date.now() - startedAt,
            counts: { queued: queuedCount },
            error: projectDiagnosticError(error),
          });
        this.queuedWork = true;
        if (this.host.getIndex() === manager) this.host.getIndexStatus()?.markStale(true);
        if (operationSignal.aborted) {
          if (this.stopPaused) {
            this.reschedulePending = false;
            if (this.retryTimer) clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
          }
        } else this.scheduleRetry(error);
        throw error;
      } finally {
        this.reconcilePromise = undefined;
        automaticLease?.release();
        if (this.lease === automaticLease) this.lease = undefined;
        const shouldResume = source === "automatic" && this.reschedulePending;
        if (
          source === "automatic" &&
          (completed || shouldResume) &&
          !this.stopPaused &&
          this.queuedWork &&
          this.host.isIndexReady() &&
          this.host.getSettings().filo.automaticLexicalDelayMs > 0
        ) {
          this.reschedulePending = false;
          this.schedule();
        }
        if (source === "automatic" && this.abort?.signal === operationSignal)
          this.abort = undefined;
        this.host.setSchedulerSource(previousSource);
        this.host.refreshSchedulerMessage();
      }
    })();
    this.host.refreshSchedulerMessage();
    return this.reconcilePromise;
  }
}
