import type {
  IndexOperationResult,
  SemanticPrepareResult,
  IndexSyncResult,
} from "@/index/IndexManager";
import type { PublicationResult, AdoptionResult } from "@/index/publications/PublicationManager";
import { StructuredError } from "@/domain/contracts";
import { SemanticProviderError } from "./manager/contracts";

const AUTOMATIC_MAINTENANCE_BASE_MS = 3_000;
const AUTOMATIC_MAINTENANCE_MULTIPLIER = 3;
const AUTOMATIC_MAINTENANCE_QUIET_CAP_MS = 20_000;
const AUTOMATIC_MAINTENANCE_MAX_START_MS = 60_000;
const SEMANTIC_PROVIDER_RETRY_MS = 60_000;

export interface MaintenanceClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface MaintenancePort {
  readonly semanticConfigured: boolean;
  synchronize(signal: AbortSignal): Promise<IndexSyncResult>;
  prepareSemantic(signal: AbortSignal, shouldYield?: () => boolean): Promise<SemanticPrepareResult>;
  rebuildSemantic(signal: AbortSignal, shouldYield?: () => boolean): Promise<SemanticPrepareResult>;
  rebuild(signal: AbortSignal): Promise<IndexOperationResult>;
  refreshRelated?(signal: AbortSignal): Promise<void>;
  publish(shouldYield?: () => boolean): Promise<PublicationResult>;
  adoptCurrent(shouldYield?: () => boolean): Promise<AdoptionResult>;
}

export type MaintenanceLane = "idle" | "automatic" | "update" | "rebuild" | "adoption";

export interface MaintenanceSnapshot {
  readonly lane: MaintenanceLane;
  readonly phase?: string;
  readonly pending: boolean;
  readonly suspended: boolean;
  readonly error?: unknown;
}

interface MaintenanceSchedulerOptions {
  readonly clock?: MaintenanceClock;
  readonly onChange?: (snapshot: MaintenanceSnapshot) => void;
}

interface ExplicitRequest {
  readonly kind: "update" | "rebuild";
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

const systemClock: MaintenanceClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Owns automatic maintenance timing, phase handoff, and its single active lane. */
export class MaintenanceScheduler {
  private readonly clock: MaintenanceClock;
  private readonly onChange?: (snapshot: MaintenanceSnapshot) => void;
  private lane: MaintenanceLane = "idle";
  private phase?: string;
  private pending = false;
  private suspended = false;
  private automatic = false;
  private timer?: unknown;
  private active?: AbortController;
  private activeCompletion?: Promise<void>;
  private resolveActiveCompletion?: () => void;
  private lastEditAt?: number;
  private firstOutstandingAt?: number;
  private invalidatedAttempts = 0;
  private invalidatedCurrentAttempt = false;
  private publicationRequired = false;
  private disposed = false;
  private disposal?: Promise<void>;
  private error?: unknown;
  private explicit: ExplicitRequest[] = [];
  private idleWaiters: Array<() => void> = [];
  private queuedFenceCancels = new Set<() => void>();
  private exclusiveReset = false;
  private resetStopped = false;
  private resetIncomplete = false;
  private semanticRetryAt?: number;
  private manualRevision = 0;
  private manualFenceWaiting = false;

  constructor(
    private readonly port: MaintenancePort,
    options: MaintenanceSchedulerOptions = {}
  ) {
    this.clock = options.clock ?? systemClock;
    this.onChange = options.onChange;
  }

  get snapshot(): MaintenanceSnapshot {
    return {
      lane: this.lane,
      ...(this.phase ? { phase: this.phase } : {}),
      pending: this.pending,
      suspended: this.suspended,
      ...(this.error !== undefined ? { error: this.error } : {}),
    };
  }

  setAutomaticEnabled(enabled: boolean): void {
    if (this.disposed) return;
    if (this.automatic === enabled) return;
    this.automatic = enabled;
    if (enabled) {
      if (this.resetIncomplete) {
        this.emit();
        return;
      }
      this.suspended = false;
      this.error = undefined;
      this.schedule();
    } else {
      this.clearTimer();
      if (this.lane === "automatic" && this.phase !== "publication") this.active?.abort();
    }
    this.emit();
  }

  /** Call on each vault edit affecting eligible Markdown. */
  invalidate(publicationRequired = false): void {
    if (this.disposed) return;
    // New Markdown work must not wait for an earlier provider retry deadline.
    this.semanticRetryAt = undefined;
    const now = this.clock.now();
    this.pending = true;
    this.publicationRequired ||= publicationRequired;
    this.lastEditAt = now;
    this.firstOutstandingAt ??= now;
    if (this.lane !== "idle") this.invalidatedCurrentAttempt = true;
    this.schedule();
    this.emit();
  }

  update(): Promise<void> {
    return this.enqueue("update");
  }
  rebuild(): Promise<void> {
    return this.enqueue("rebuild");
  }

  /** Clears persistent index stores while excluding maintenance and explicit work. */
  async resetExclusive(run: () => Promise<void>): Promise<void> {
    if (this.disposed || this.exclusiveReset)
      throw new StructuredError("busy", "Index maintenance is active; retry reset.", true);

    this.interruptForManual();
    this.exclusiveReset = true;
    this.resetStopped = false;
    this.clearTimer();
    for (const cancel of this.queuedFenceCancels) cancel();
    this.queuedFenceCancels.clear();
    const activeCompletion = this.activeCompletion;
    if (activeCompletion) await activeCompletion;
    if (this.disposed) {
      this.exclusiveReset = false;
      throw new StructuredError("busy", "Index maintenance is active; retry reset.", true);
    }
    this.beginActive();
    this.lane = "update";
    this.phase = "reset";
    this.error = undefined;
    this.emit();
    let completed = false;
    try {
      await run();
      this.pending = true;
      this.publicationRequired = true;
      this.lastEditAt = this.clock.now();
      this.firstOutstandingAt ??= this.lastEditAt;
      this.invalidatedCurrentAttempt = false;
      this.resetIncomplete = false;
      if (!this.resetStopped) this.suspended = false;
      completed = true;
    } catch (error) {
      this.error = error;
      this.suspended = true;
      this.resetIncomplete = true;
      throw error;
    } finally {
      this.exclusiveReset = false;
      this.lane = "idle";
      this.phase = undefined;
      this.emit();
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      this.finishActive();
      if (completed && !this.disposed) this.schedule();
    }
  }

  /** Shares computed embeddings without repeating local indexing work. */
  async publishCurrent(): Promise<void> {
    if (this.disposed) return;
    if (this.resetIncomplete)
      throw new StructuredError("busy", "Index reset is incomplete; retry reset first.", true);
    if (this.exclusiveReset)
      throw new StructuredError("busy", "Index reset is in progress; retry later.", true);
    const revision = this.interruptForManual();
    this.manualFenceWaiting = true;
    this.suspended = false;
    this.error = undefined;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    this.queuedFenceCancels.add(cancel);
    try {
      while (this.lane !== "idle") {
        if (this.disposed || cancelled) return;
        await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
      }
      if (this.disposed || cancelled) return;
      const result = await this.runFenced("update", "publication", { published: false }, () =>
        this.port.publish(() => cancelled || revision !== this.manualRevision || this.disposed)
      );
      if (cancelled || revision !== this.manualRevision || this.disposed) return;
      if (result.warning)
        throw result.warning.error instanceof Error
          ? result.warning.error
          : new Error(result.warning.message);
      if (!result.published) throw new Error("Sharing embeddings did not complete.");
    } finally {
      this.queuedFenceCancels.delete(cancel);
      if (revision === this.manualRevision) {
        this.manualFenceWaiting = false;
        for (const resolve of this.idleWaiters.splice(0)) resolve();
        this.schedule();
      }
    }
  }

  /** Stop aborts cancellable work and leaves outstanding edits pending. */
  stop(): void {
    this.suspended = true;
    this.error = undefined;
    this.clearTimer();
    if (this.exclusiveReset) {
      this.resetStopped = true;
      this.emit();
      return;
    }
    this.active?.abort();
    for (const cancel of this.queuedFenceCancels) cancel();
    this.queuedFenceCancels.clear();
    for (const request of this.explicit.splice(0)) request.resolve();
    this.emit();
  }

  /** Permanently closes the scheduler and waits for its current lane to settle. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.clearTimer();
    this.active?.abort();
    for (const request of this.explicit.splice(0)) request.resolve();
    this.emit();
    this.disposal = this.activeCompletion ?? Promise.resolve();
    return this.disposal;
  }

  /** Check adopts a compatible file or converges and replaces a non-newer incompatible one. */
  async checkPublication(manual = false): Promise<AdoptionResult> {
    if (this.disposed) return { adopted: false, ignored: "missing" };
    if (this.resetIncomplete)
      throw new StructuredError("busy", "Index reset is incomplete; retry reset first.", true);
    if (this.exclusiveReset)
      throw new StructuredError("busy", "Index reset is in progress; retry later.", true);
    const revision = manual ? this.interruptForManual() : this.manualRevision;
    if (manual) {
      this.manualFenceWaiting = true;
      this.suspended = false;
      this.error = undefined;
    }
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    this.queuedFenceCancels.add(cancel);
    try {
      while (this.lane !== "idle" || (!manual && this.manualFenceWaiting)) {
        if (this.disposed || cancelled) return { adopted: false, ignored: "missing" };
        await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
      }
      if (this.disposed || cancelled) return { adopted: false, ignored: "missing" };
      const result = await this.runFenced(
        "adoption",
        "adopt",
        { adopted: false, ignored: "missing" },
        () =>
          this.port.adoptCurrent(
            () => cancelled || revision !== this.manualRevision || this.suspended || this.disposed
          )
      );
      return result;
    } finally {
      this.queuedFenceCancels.delete(cancel);
      if (manual && revision === this.manualRevision) {
        this.manualFenceWaiting = false;
        for (const resolve of this.idleWaiters.splice(0)) resolve();
        this.schedule();
      }
    }
  }

  private enqueue(kind: "update" | "rebuild"): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.resetIncomplete)
      return Promise.reject(
        new StructuredError("busy", "Index reset is incomplete; retry reset first.", true)
      );
    if (this.exclusiveReset)
      return Promise.reject(
        new StructuredError("busy", "Index reset is in progress; retry later.", true)
      );
    this.interruptForManual();
    this.suspended = false;
    this.error = undefined;
    this.pending = true;
    this.lastEditAt ??= this.clock.now();
    this.firstOutstandingAt ??= this.clock.now();
    const promise = new Promise<void>((resolve, reject) =>
      this.explicit.push({ kind, resolve, reject })
    );
    if (this.lane === "adoption") this.phase = "queued";
    this.clearTimer();
    void this.drain();
    this.emit();
    return promise;
  }

  /** A newer manual command supersedes cancellable work and queued commands. */
  private interruptForManual(): number {
    this.clearTimer();
    this.semanticRetryAt = undefined;
    this.manualFenceWaiting = false;
    this.active?.abort();
    for (const cancel of this.queuedFenceCancels) cancel();
    this.queuedFenceCancels.clear();
    for (const request of this.explicit.splice(0)) request.resolve();
    return ++this.manualRevision;
  }

  private schedule(): void {
    if (
      !this.automatic ||
      this.suspended ||
      this.exclusiveReset ||
      this.resetIncomplete ||
      this.manualFenceWaiting ||
      !this.pending ||
      this.lane !== "idle" ||
      this.explicit.length
    )
      return;
    this.clearTimer();
    const now = this.clock.now();
    const quiet = Math.min(
      AUTOMATIC_MAINTENANCE_BASE_MS * AUTOMATIC_MAINTENANCE_MULTIPLIER ** this.invalidatedAttempts,
      AUTOMATIC_MAINTENANCE_QUIET_CAP_MS
    );
    const quietAt = (this.lastEditAt ?? now) + quiet;
    const deadline =
      this.firstOutstandingAt === undefined
        ? now + AUTOMATIC_MAINTENANCE_MAX_START_MS
        : this.firstOutstandingAt + AUTOMATIC_MAINTENANCE_MAX_START_MS;
    const retryAt = this.semanticRetryAt;
    const delay = Math.max(
      0,
      (retryAt !== undefined ? Math.max(quietAt, retryAt) : Math.min(quietAt, deadline)) - now
    );
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.drain(true);
    }, delay);
  }

  private async drain(automatic = false): Promise<void> {
    if (this.disposed || this.exclusiveReset || this.manualFenceWaiting) return;
    if (this.lane !== "idle") return;
    const request = this.explicit.shift();
    if (!request && (!automatic || !this.automatic || this.suspended || !this.pending)) {
      this.schedule();
      return;
    }
    const lane: MaintenanceLane = request?.kind ?? "automatic";
    if (request) {
      this.suspended = false;
      this.error = undefined;
    }
    const controller = new AbortController();
    this.active = controller;
    this.beginActive();
    this.lane = lane;
    this.error = undefined;
    this.invalidatedCurrentAttempt = false;
    if (lane === "automatic") this.firstOutstandingAt = undefined;
    this.emit();
    try {
      if (lane === "update" || lane === "rebuild") {
        let completed = false;
        let semanticRebuildStarted = false;
        const shouldYieldSemantic = () =>
          this.explicit.length > 0 ||
          this.invalidatedCurrentAttempt ||
          this.disposed ||
          this.suspended ||
          controller.signal.aborted;
        while (!controller.signal.aborted && !this.suspended) {
          this.firstOutstandingAt = undefined;
          this.invalidatedCurrentAttempt = false;
          let lexicalConverged = false;
          while (!lexicalConverged && !controller.signal.aborted && !this.suspended) {
            this.phase = "lexical";
            this.emit();
            const lexical =
              lane === "rebuild"
                ? await this.port.rebuild(controller.signal)
                : await this.port.synchronize(controller.signal);
            if (controller.signal.aborted || this.suspended) break;
            if (this.invalidatedCurrentAttempt) break;
            lexicalConverged = lexical.converged;
          }
          if (controller.signal.aborted || this.suspended) break;
          if (this.invalidatedCurrentAttempt) continue;
          if (!lexicalConverged) continue;

          let semanticConverged = !this.port.semanticConfigured;
          if (lane === "rebuild" && this.port.semanticConfigured && !semanticRebuildStarted) {
            this.phase = "semantic";
            this.emit();
            const semantic = await this.port.rebuildSemantic(
              controller.signal,
              shouldYieldSemantic
            );
            semanticRebuildStarted = true;
            if (controller.signal.aborted || this.suspended) break;
            if (this.invalidatedCurrentAttempt) continue;
            semanticConverged = semantic.converged;
          }
          while (
            this.port.semanticConfigured &&
            !semanticConverged &&
            !controller.signal.aborted &&
            !this.suspended
          ) {
            this.phase = "semantic";
            this.emit();
            const semantic = await this.port.prepareSemantic(
              controller.signal,
              shouldYieldSemantic
            );
            if (controller.signal.aborted || this.suspended) break;
            if (this.invalidatedCurrentAttempt) break;
            semanticConverged = semantic.converged;
          }
          if (controller.signal.aborted || this.suspended) break;
          if (this.invalidatedCurrentAttempt) continue;
          if (!semanticConverged) continue;

          const published = await this.publish();
          if (controller.signal.aborted || this.suspended) break;
          if (this.invalidatedCurrentAttempt) continue;
          if (published) {
            completed = true;
            break;
          }
          break;
        }
        if (
          completed &&
          !this.invalidatedCurrentAttempt &&
          !controller.signal.aborted &&
          !this.suspended
        )
          this.clearPending();
        else this.noteInvalidation();
      } else if (lane === "automatic") {
        this.phase = "lexical";
        this.emit();
        const lexical = await this.port.synchronize(controller.signal);
        this.publicationRequired ||= lexical.changed;
        if (controller.signal.aborted) return;
        if (this.explicit.length) return;
        if (!lexical.converged || this.invalidatedCurrentAttempt) {
          if (!lexical.converged && !this.invalidatedCurrentAttempt) {
            this.firstOutstandingAt = this.clock.now();
            this.lastEditAt = this.clock.now();
          }
          this.noteInvalidation(true);
          return;
        }
        this.phase = "semantic";
        this.emit();
        const semantic = this.port.semanticConfigured
          ? await this.port.prepareSemantic(
              controller.signal,
              () =>
                this.explicit.length > 0 ||
                this.invalidatedCurrentAttempt ||
                this.disposed ||
                this.suspended ||
                controller.signal.aborted
            )
          : { converged: true };
        this.publicationRequired ||= "changed" in semantic && semantic.changed;
        if (controller.signal.aborted) return;
        if (this.explicit.length) return;
        const published =
          semantic.converged && !this.invalidatedCurrentAttempt && this.publicationRequired
            ? await this.publish()
            : !this.publicationRequired;
        if (semantic.converged && !this.invalidatedCurrentAttempt && published && !this.suspended)
          this.clearPending();
        else {
          if (!semantic.converged && !this.invalidatedCurrentAttempt) {
            this.firstOutstandingAt = this.clock.now();
            this.lastEditAt = this.clock.now();
          }
          this.noteInvalidation(true);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof SemanticProviderError) {
          try {
            if (!this.invalidatedCurrentAttempt) await this.publish();
            if (controller.signal.aborted) return;
            this.pending = true;
            this.semanticRetryAt = this.invalidatedCurrentAttempt
              ? undefined
              : this.clock.now() + SEMANTIC_PROVIDER_RETRY_MS;
            this.error = error;
            this.suspended = false;
          } catch (publicationError) {
            if (controller.signal.aborted) return;
            this.error = publicationError;
            this.suspended = true;
          }
          request?.reject(error);
        } else {
          this.error = error;
          this.suspended = true;
          request?.reject(error);
        }
      }
    } finally {
      this.active = undefined;
      this.lane = "idle";
      this.phase = undefined;
      this.emit();
      if (!this.error || controller.signal.aborted) request?.resolve();
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      this.finishActive();
      if (!this.disposed && !this.exclusiveReset) {
        if (this.explicit.length) void this.drain();
        else this.schedule();
      }
    }
  }

  private async publish(): Promise<boolean> {
    if (this.invalidatedCurrentAttempt || this.suspended) return false;
    if (this.port.refreshRelated && this.active) {
      this.phase = "results";
      this.emit();
      const signal = this.active.signal;
      let abort!: () => void;
      const interrupted = new Promise<void>((resolve) => {
        abort = resolve;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) resolve();
      });
      try {
        await Promise.race([this.port.refreshRelated(signal), interrupted]);
      } catch {
        // A failed visible-results refresh must not prevent sharing embeddings.
      } finally {
        signal.removeEventListener("abort", abort);
      }
      if (signal.aborted || this.invalidatedCurrentAttempt || this.suspended || this.disposed)
        return false;
    }
    this.phase = "publication";
    this.emit();
    const publication = await this.port.publish(
      () => this.active?.signal.aborted === true || this.disposed || this.exclusiveReset
    );
    if (this.active?.signal.aborted || this.disposed || this.exclusiveReset) return false;
    if (publication.warning) {
      throw publication.warning;
    }
    if (!publication.published) throw new Error("Sharing embeddings did not complete.");
    this.error = undefined;
    return true;
  }

  private noteInvalidation(automatic = false): void {
    if (automatic && this.invalidatedCurrentAttempt) this.invalidatedAttempts += 1;
    this.invalidatedCurrentAttempt = false;
  }

  private clearPending(): void {
    this.pending = false;
    this.lastEditAt = undefined;
    this.firstOutstandingAt = undefined;
    this.invalidatedAttempts = 0;
    this.publicationRequired = false;
    this.semanticRetryAt = undefined;
  }

  private async runFenced<T>(
    lane: MaintenanceLane,
    phase: string,
    cancelled: T,
    run: () => Promise<T>
  ): Promise<T> {
    while (this.lane !== "idle" || this.exclusiveReset) {
      if (this.disposed) return cancelled;
      if (this.exclusiveReset) return cancelled;
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
    if (this.disposed || this.exclusiveReset) return cancelled;
    this.beginActive();
    this.lane = lane;
    this.phase = phase;
    this.emit();
    try {
      return await run();
    } finally {
      this.lane = "idle";
      this.phase = undefined;
      this.emit();
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      this.finishActive();
      if (!this.disposed && !this.exclusiveReset) {
        if (this.explicit.length) void this.drain();
        else this.schedule();
      }
    }
  }

  private beginActive(): void {
    this.activeCompletion = new Promise<void>((resolve) => {
      this.resolveActiveCompletion = resolve;
    });
  }

  private finishActive(): void {
    const resolve = this.resolveActiveCompletion;
    this.resolveActiveCompletion = undefined;
    this.activeCompletion = undefined;
    resolve?.();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
  private emit(): void {
    this.onChange?.(this.snapshot);
  }
}
