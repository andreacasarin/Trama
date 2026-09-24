import type { IndexOperationResult } from "@/index/IndexManager";
import { projectDiagnosticError } from "@/diagnostics/TramaDiagnostics";
import {
  PublicationManager,
  type PublicationWarning,
} from "@/index/publications/PublicationManager";
import type { SchedulerHost, SchedulerSource } from "@/plugin/scheduler";

interface PublicationIntent {
  readonly eventRevision: number;
}

export interface AutomaticPublicationHost extends SchedulerHost {
  getPublicationManager(): PublicationManager | undefined;
  hasQueuedLexicalWork(): boolean;
  hasActiveLexicalReconciliation(): boolean;
  getSchedulerSource(): SchedulerSource;
  setPublicationWarning(warning: PublicationWarning | undefined): void;
}

export class AutomaticPublicationController {
  private timer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryAttempt = 0;
  private retryPaused = false;
  private pending?: PublicationIntent;
  private promise?: Promise<void>;
  private activePromise?: ReturnType<PublicationManager["publish"]>;

  constructor(private readonly host: AutomaticPublicationHost) {}

  snapshot(): {
    running: boolean;
    retryScheduled: boolean;
    retryAttempt: number;
    retryPaused: boolean;
    delayed: boolean;
    pending: boolean;
  } {
    return {
      running: Boolean(this.promise),
      retryScheduled: Boolean(this.retryTimer),
      retryAttempt: this.retryAttempt,
      retryPaused: this.retryPaused,
      delayed: Boolean(this.timer),
      pending: Boolean(this.pending),
    };
  }

  resetForSettings(): void {
    this.clearRetry();
    this.retryAttempt = 0;
    this.retryPaused = false;
  }

  recordIntent(publication: PublicationManager | undefined, result: IndexOperationResult): void {
    if (!publication || !result.converged || !result.changed || result.state.incomplete) return;
    const source = this.host.getSchedulerSource();
    if (this.host.getSettings().filo.automaticPublicationDelayMs <= 0) {
      this.host.emitSchedulerTransition({ channel: "publication", stage: "disabled", source });
      return;
    }
    this.clearTimer();
    this.clearRetry();
    this.retryAttempt = 0;
    this.retryPaused = false;
    this.pending = { eventRevision: this.host.getVaultEventRevision() };
    this.host.emitSchedulerTransition({
      channel: "publication",
      stage: "pending",
      source,
      delayMs: this.host.getSettings().filo.automaticPublicationDelayMs,
    });
    this.schedule();
  }

  schedule(
    delay = this.host.getSettings().filo.automaticPublicationDelayMs,
    source: SchedulerSource = this.host.getSchedulerSource()
  ): void {
    this.clearTimer();
    const pending = this.pending;
    if (!pending || delay <= 0 || this.retryPaused) return;
    this.host.emitSchedulerTransition({
      channel: "publication",
      stage: "delayed",
      source,
      delayMs: delay,
    });
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.publishAutomatically(pending, source);
    }, delay);
    this.host.refreshSchedulerMessage();
  }

  async retryExplicit(publication: PublicationManager | undefined): Promise<void> {
    if (!publication) return;
    this.clearTimer();
    this.clearRetry();
    this.retryAttempt = 0;
    this.retryPaused = false;
    const pending = this.pending;
    const startedAt = Date.now();
    this.host.emitSchedulerTransition({
      channel: "publication",
      stage: "running",
      source: "explicit",
    });
    try {
      const result = await this.publishOnce(publication);
      if (result.warning) {
        this.host.setPublicationWarning(result.warning);
        this.host.emitSchedulerTransition({
          channel: "publication",
          stage: "failed",
          source: "explicit",
          durationMs: Date.now() - startedAt,
          phase: result.warning.phase,
          error: projectDiagnosticError(result.warning.error),
        });
        this.scheduleRetry(pending, result.warning.retryable, publication);
      } else if (result.published) {
        this.host.setPublicationWarning(undefined);
        if (pending && this.pending === pending && this.isCurrent(pending))
          this.pending = undefined;
        this.host.emitSchedulerTransition({
          channel: "publication",
          stage: "completed",
          source: "explicit",
          durationMs: Date.now() - startedAt,
          publicationSizeBytes: publication.metrics?.byteSize,
        });
      }
    } catch (error) {
      this.host.emitSchedulerTransition({
        channel: "publication",
        stage: "failed",
        source: "explicit",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      this.host.refreshSchedulerMessage();
    }
  }

  publishOnQuit(publication: PublicationManager | undefined): Promise<void> | undefined {
    const manager = this.host.getIndex();
    const pending = this.pending;
    if (
      !manager ||
      !publication ||
      !pending ||
      this.host.getSettings().filo.automaticPublicationDelayMs <= 0 ||
      !this.host.isIndexReady() ||
      this.host.hasQueuedLexicalWork() ||
      this.host.hasActiveLexicalReconciliation() ||
      !this.isCurrent(pending) ||
      !manager.isComplete() ||
      manager.isBuilding() ||
      manager.isInMaintenance()
    )
      return undefined;
    this.clearTimer();
    this.clearRetry();
    return (
      this.promise ??
      (async () => {
        const startedAt = Date.now();
        this.host.emitSchedulerTransition({
          channel: "publication",
          stage: "running",
          source: "quit",
        });
        const result = await this.publishOnce(publication);
        if (this.host.getIndex() !== manager) return;
        if (result.published) {
          if (this.pending === pending && this.isCurrent(pending)) this.pending = undefined;
          this.host.setPublicationWarning(undefined);
          this.host.emitSchedulerTransition({
            channel: "publication",
            stage: "completed",
            source: "quit",
            durationMs: Date.now() - startedAt,
            publicationSizeBytes: publication.metrics?.byteSize,
          });
        } else if (result.warning) {
          this.host.setPublicationWarning(result.warning);
          this.host.emitSchedulerTransition({
            channel: "publication",
            stage: "failed",
            source: "quit",
            durationMs: Date.now() - startedAt,
            phase: result.warning.phase,
            error: projectDiagnosticError(result.warning.error),
          });
          this.scheduleRetry(pending, result.warning.retryable, publication);
        }
      })()
    );
  }

  private async publishAutomatically(
    pending: PublicationIntent,
    source: SchedulerSource,
    publication = this.host.getPublicationManager()
  ): Promise<void> {
    if (this.promise) return;
    const manager = this.host.getIndex();
    if (
      !manager ||
      !publication ||
      this.pending !== pending ||
      this.host.getSettings().filo.automaticPublicationDelayMs <= 0
    )
      return;
    if (this.host.hasQueuedLexicalWork() || !this.isCurrent(pending) || !manager.isComplete())
      return;
    if (
      manager.isBuilding() ||
      manager.isInMaintenance() ||
      manager.capabilities().semantic.activity === "updating" ||
      publication.isBusy
    ) {
      this.host.emitSchedulerTransition({
        channel: "publication",
        stage: "delayed",
        source,
        delayMs: 1_000,
      });
      this.schedule(1_000, source);
      return;
    }
    const attempt = this.publishOnce(publication);
    const startedAt = Date.now();
    this.host.emitSchedulerTransition({ channel: "publication", stage: "running", source });
    this.promise = (async () => {
      const result = await attempt;
      if (this.host.getIndex() !== manager) return;
      if (result.published) {
        if (this.pending === pending && this.isCurrent(pending)) {
          this.pending = undefined;
          this.clearRetry();
          this.retryAttempt = 0;
          this.retryPaused = false;
        }
        this.host.setPublicationWarning(undefined);
        this.host.emitSchedulerTransition({
          channel: "publication",
          stage: "completed",
          source,
          durationMs: Date.now() - startedAt,
          publicationSizeBytes: publication.metrics?.byteSize,
        });
      } else if (result.warning) {
        this.host.setPublicationWarning(result.warning);
        this.host.emitSchedulerTransition({
          channel: "publication",
          stage: "failed",
          source,
          durationMs: Date.now() - startedAt,
          phase: result.warning.phase,
          error: projectDiagnosticError(result.warning.error),
        });
        this.scheduleRetry(pending, result.warning.retryable, publication);
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.promise = undefined;
        this.host.refreshSchedulerMessage();
      });
    this.host.refreshSchedulerMessage();
    return this.promise;
  }

  private publishOnce(publication: PublicationManager): ReturnType<PublicationManager["publish"]> {
    if (this.activePromise) return this.activePromise;
    const wrapped = publication.publish().finally(() => {
      if (this.activePromise === wrapped) this.activePromise = undefined;
    });
    this.activePromise = wrapped;
    return wrapped;
  }

  private isCurrent(pending: PublicationIntent): boolean {
    return this.pending === pending && pending.eventRevision === this.host.getVaultEventRevision();
  }

  private scheduleRetry(
    pending: PublicationIntent | undefined,
    retryable: boolean,
    publication?: PublicationManager
  ): void {
    this.clearRetry();
    if (
      !retryable ||
      this.host.getSettings().filo.automaticPublicationDelayMs <= 0 ||
      !pending ||
      this.pending !== pending ||
      !this.isCurrent(pending)
    ) {
      if (!retryable) this.retryPaused = true;
      return;
    }
    const delays = [5_000, 15_000, 60_000];
    if (this.retryAttempt >= delays.length) {
      this.retryPaused = true;
      return;
    }
    const delay = delays[this.retryAttempt++];
    this.host.emitSchedulerTransition({
      channel: "publication",
      stage: "retrying",
      source: "retry",
      delayMs: delay,
      retryAttempt: this.retryAttempt,
    });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.publishAutomatically(pending, "retry", publication);
    }, delay);
    this.host.refreshSchedulerMessage();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  pauseForIndexing(): void {
    this.clearTimer();
    this.clearRetry();
  }

  stop(): void {
    this.clearTimer();
    this.clearRetry();
    this.pending = undefined;
    this.retryAttempt = 0;
    this.retryPaused = false;
  }
}
