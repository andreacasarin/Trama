import type { TramaSettings } from "@/settings/Settings";

export interface SchedulerStatusSnapshot {
  readonly settings: TramaSettings["filo"];
  readonly lexical: {
    readonly queued: boolean;
    readonly running: boolean;
    readonly retryPaused: boolean;
    readonly retryScheduled: boolean;
    readonly retryAttempt: number;
    readonly delayed: boolean;
  };
  readonly semantic: {
    readonly running: boolean;
    readonly retryScheduled: boolean;
    readonly retryAttempt: number;
    readonly delayed: boolean;
    readonly indexComplete: boolean;
    readonly eligible: boolean;
    readonly searchable: boolean;
  };
  readonly publication: {
    readonly running: boolean;
    readonly retryScheduled: boolean;
    readonly retryAttempt: number;
    readonly retryPaused: boolean;
    readonly delayed: boolean;
    readonly pending: boolean;
  };
}

export function schedulerStatusMessage(snapshot: SchedulerStatusSnapshot): string {
  const { settings } = snapshot;
  const lexical =
    settings.automaticLexicalDelayMs <= 0
      ? snapshot.lexical.queued
        ? "paused"
        : "Off"
      : snapshot.lexical.running
        ? "running"
        : snapshot.lexical.retryPaused
          ? "failed"
          : snapshot.lexical.retryScheduled
            ? `retrying (attempt ${snapshot.lexical.retryAttempt})`
            : snapshot.lexical.delayed
              ? `scheduled (${settings.automaticLexicalDelayMs / 1000} sec)`
              : snapshot.lexical.queued
                ? "queued"
                : "idle";
  const semantic =
    settings.automaticSemanticDelayMs <= 0
      ? "Off"
      : snapshot.semantic.running
        ? "running"
        : snapshot.semantic.retryScheduled
          ? `retrying (attempt ${snapshot.semantic.retryAttempt})`
          : snapshot.semantic.delayed
            ? `scheduled (${settings.automaticSemanticDelayMs / 1000} sec)`
            : snapshot.semantic.indexComplete && !snapshot.semantic.eligible
              ? snapshot.semantic.searchable
                ? "up to date"
                : "incomplete"
              : "idle";
  const publication =
    settings.automaticPublicationDelayMs <= 0
      ? "Off"
      : snapshot.publication.running
        ? "running"
        : snapshot.publication.retryScheduled
          ? `retrying (attempt ${snapshot.publication.retryAttempt})`
          : snapshot.publication.retryPaused
            ? "failed"
            : snapshot.publication.delayed
              ? `scheduled (${settings.automaticPublicationDelayMs / 1000} sec)`
              : snapshot.publication.pending
                ? "pending"
                : "idle";
  return `Automatic updates — lexical ${lexical}; semantic ${semantic}; publication ${publication}.`;
}
