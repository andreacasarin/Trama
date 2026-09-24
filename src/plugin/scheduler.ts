import { projectDiagnosticError, type TramaDiagnostics } from "@/diagnostics/TramaDiagnostics";
import type { IndexManager } from "@/index/IndexManager";
import type { TramaSettings } from "@/settings/Settings";
import type { IndexStatusController } from "@/ui/index/IndexStatus";

export type SchedulerChannel = "lexical" | "semantic" | "publication";
export type SchedulerSource = "startup" | "event" | "explicit" | "retry" | "quit";

export interface SchedulerTransition {
  readonly channel: SchedulerChannel;
  readonly stage: string;
  readonly source: SchedulerSource;
  readonly delayMs?: number;
  readonly retryAttempt?: number;
  readonly durationMs?: number;
  readonly counts?: Readonly<Record<string, number>>;
  readonly publicationSizeBytes?: number;
  /** Publication phase; error.phase retains the Worker RPC phase. */
  readonly phase?: string;
  /** Metadata for a deferred automatic request; never shown as user content. */
  readonly deferredReason?: string;
  readonly error?: ReturnType<typeof projectDiagnosticError>;
}

export interface SchedulerHost {
  readonly diagnostics: TramaDiagnostics;
  getSettings(): TramaSettings;
  getIndex(): IndexManager | undefined;
  getIndexStatus(): IndexStatusController | undefined;
  isIndexReady(): boolean;
  getVaultEventRevision(): number;
  emitSchedulerTransition(transition: SchedulerTransition): void;
  refreshSchedulerMessage(): void;
  updateIndexCapabilities(manager: IndexManager): void;
}

export function isRetryableError(error: unknown): boolean {
  if (projectDiagnosticError(error).retryable === true) return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { retryable?: unknown; error?: { retryable?: unknown } };
  return value.retryable === true || value.error?.retryable === true;
}
