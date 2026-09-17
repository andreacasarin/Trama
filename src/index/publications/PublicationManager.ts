import { StructuredError, type IndexCapabilities } from "@/domain/contracts";
import type { IndexOperationResult, SemanticPrepareResult } from "@/index/IndexManager";
import type {
  PublicationInspection,
  PublicationPrepared,
  SqliteState,
} from "@/index/sqlite/protocol";
import { PublicationStore, type PublicationDataAdapter } from "./PublicationStore";

export interface PublicationIndexPort {
  publishPublication<T>(
    publicationId: string,
    install: (prepared: PublicationPrepared) => Promise<T>,
    settle?: (committed: boolean) => Promise<void>
  ): Promise<{ prepared: PublicationPrepared; installed: T }>;
  inspectPublication(
    bytes: ArrayBuffer,
    transferOwnership?: boolean
  ): Promise<PublicationInspection>;
  adoptPublication(bytes: ArrayBuffer, expectedPublicationId?: string): Promise<SqliteState>;
  getState?(): Promise<SqliteState | undefined>;
  capabilities?(): IndexCapabilities;
}

export interface PublicationWarning {
  readonly phase: "prepare" | "stage" | "replace" | "finalize" | "inspect" | "adopt";
  readonly message: string;
  readonly error: unknown;
  readonly retryable: boolean;
}

export interface PublicationResourceMetrics {
  readonly publicationId?: string;
  readonly byteSize: number;
  readonly copyBytes: number;
  readonly durationMs: number;
  readonly stageDurationMs?: number;
  readonly replaceDurationMs?: number;
}

export interface PublicationResult {
  readonly published: boolean;
  readonly publicationId?: string;
  readonly metrics?: PublicationResourceMetrics;
  readonly warning?: PublicationWarning;
}

export interface AdoptionResult {
  readonly adopted: boolean;
  readonly ignored?: "missing" | "same-id";
  readonly publicationId?: string;
  readonly state?: SqliteState;
  readonly warning?: PublicationWarning;
}

export interface PublicationManagerOptions {
  readonly directory?: unknown;
  readonly temporaryToken?: () => string;
  readonly idFactory?: () => string;
  readonly onWarning?: (warning: PublicationWarning) => void;
  readonly onMetrics?: (metrics: PublicationResourceMetrics) => void;
  readonly debounceMs?: number;
}

type SuccessfulOperation = IndexOperationResult | SemanticPrepareResult;

/**
 * Serializes publication and adoption around the IndexManager maintenance
 * seam. It intentionally has no merge, timestamp, hash, manifest, or ordering
 * policy: the synchronized provider chooses which valid single file arrives.
 */
export class PublicationManager {
  private readonly idFactory: () => string;
  private readonly onWarning?: (warning: PublicationWarning) => void;
  private readonly onMetrics?: (metrics: PublicationResourceMetrics) => void;
  private readonly debounceMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private eventPending = false;
  private eventTimer?: ReturnType<typeof setTimeout>;
  private eventPromise?: Promise<AdoptionResult>;
  private lastWarning?: PublicationWarning;
  private lastMetrics?: PublicationResourceMetrics;

  readonly store: PublicationStore;

  constructor(
    private readonly index: PublicationIndexPort,
    storeOrAdapter: PublicationStore | PublicationDataAdapter,
    options: PublicationManagerOptions = {}
  ) {
    this.store =
      storeOrAdapter instanceof PublicationStore
        ? storeOrAdapter
        : new PublicationStore(storeOrAdapter, {
            directory: options.directory,
            temporaryToken: options.temporaryToken,
          });
    this.idFactory = options.idFactory ?? (() => randomPublicationId());
    this.onWarning = options.onWarning;
    this.onMetrics = options.onMetrics;
    this.debounceMs = Math.max(0, options.debounceMs ?? 0);
  }

  get warning(): PublicationWarning | undefined {
    return this.lastWarning;
  }

  get metrics(): PublicationResourceMetrics | undefined {
    return this.lastMetrics;
  }

  /** Publish after a converged Build, Update, Rebuild, or semantic Prepare. */
  async publishAfterSuccessfulOperation(result: SuccessfulOperation): Promise<PublicationResult> {
    if (!isPublishableOperation(result) || !result.converged) return { published: false };
    return this.publish();
  }

  async publish(): Promise<PublicationResult> {
    return this.serialize(() => this.publishSerialized());
  }

  /** Inspect and adopt the exact configured file. Adoption never publishes. */
  async adoptCurrent(): Promise<AdoptionResult> {
    return this.serialize(() => this.adoptSerialized());
  }

  /** Coalesce duplicate/out-of-order vault events for the exact target only. */
  notifyFileEvent(path = this.store.path): void {
    if (path !== this.store.path) return;
    this.eventPending = true;
    if (this.eventTimer) return;
    this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined;
      if (!this.eventPending) return;
      this.eventPending = false;
      this.eventPromise = this.adoptCurrent().finally(() => {
        this.eventPromise = undefined;
      });
    }, this.debounceMs);
  }

  async flushPendingEvents(): Promise<AdoptionResult | undefined> {
    if (this.eventTimer) {
      clearTimeout(this.eventTimer);
      this.eventTimer = undefined;
    }
    if (this.eventPending) {
      this.eventPending = false;
      this.eventPromise = this.adoptCurrent().finally(() => {
        this.eventPromise = undefined;
      });
    }
    return this.eventPromise;
  }

  private async publishSerialized(): Promise<PublicationResult> {
    const started = Date.now();
    const id = this.idFactory();
    let phase: PublicationWarning["phase"] = "prepare";
    let hadPrevious: boolean | undefined;
    try {
      const { prepared, installed } = await this.index.publishPublication(
        id,
        async (candidate) => {
          phase = "stage";
          const stageStarted = Date.now();
          const staged = await this.store.stage(candidate.bytes, id);
          const stageDurationMs = Date.now() - stageStarted;
          try {
            phase = "inspect";
            const inspection = await this.index.inspectPublication(staged.bytes, true);
            if (inspection.publicationId !== id)
              throw new StructuredError("internal", "Publication ID changed in staged copy.", true);
            phase = "replace";
            const replaceStarted = Date.now();
            hadPrevious = await this.store.replace(staged, true);
            phase = "finalize";
            return { staged, stageDurationMs, replaceDurationMs: Date.now() - replaceStarted };
          } catch (error) {
            await this.store.removeTemporary(staged.temporaryPath);
            throw error;
          }
        },
        async (committed) => {
          if (hadPrevious === undefined) return;
          if (committed) await this.store.finishReplacement();
          else await this.store.rollbackReplacement(hadPrevious);
        }
      );
      const metrics: PublicationResourceMetrics = {
        publicationId: id,
        byteSize: installed.staged.byteSize,
        copyBytes: (prepared.copyBytes ?? 0) + installed.staged.copyBytes,
        durationMs: Date.now() - started,
        stageDurationMs: installed.stageDurationMs,
        replaceDurationMs: installed.replaceDurationMs,
      };
      this.lastWarning = undefined;
      this.lastMetrics = metrics;
      try {
        this.onMetrics?.(metrics);
      } catch {
        // Resource reporting is observational and cannot invalidate a commit.
      }
      return { published: true, publicationId: id, metrics };
    } catch (error) {
      return this.failed(phase, error);
    }
  }

  private async adoptSerialized(): Promise<AdoptionResult> {
    let bytes: ArrayBuffer | undefined;
    try {
      bytes = await this.store.read();
    } catch (error) {
      return { adopted: false, warning: this.warn("inspect", error) };
    }
    if (!bytes) return { adopted: false, ignored: "missing" };
    return this.adoptBytesSerialized(bytes);
  }

  private async adoptBytesSerialized(bytes: ArrayBuffer): Promise<AdoptionResult> {
    let inspection: PublicationInspection;
    try {
      inspection = await this.index.inspectPublication(bytes);
    } catch (error) {
      return { adopted: false, warning: this.warn("inspect", error) };
    }
    let current: string | undefined;
    try {
      current = await this.currentPublicationId();
    } catch (error) {
      return { adopted: false, warning: this.warn("inspect", error) };
    }
    if (current === inspection.publicationId)
      return { adopted: false, ignored: "same-id", publicationId: current };
    try {
      const state = await this.index.adoptPublication(bytes, inspection.publicationId);
      // An adopted candidate is authoritative as loaded data. Never call
      // publishAfterSuccessfulOperation or reconcile here.
      return { adopted: true, publicationId: inspection.publicationId, state };
    } catch (error) {
      return {
        adopted: false,
        publicationId: inspection.publicationId,
        warning: this.warn("adopt", error),
      };
    }
  }

  private async currentPublicationId(): Promise<string | undefined> {
    const state = await this.index.getState?.();
    if (state?.publicationId) return state.publicationId;
    return this.index.capabilities?.().publicationId;
  }

  private failed(phase: PublicationWarning["phase"], error: unknown): PublicationResult {
    const warning = this.warn(phase, error);
    return { published: false, warning };
  }

  private warn(phase: PublicationWarning["phase"], error: unknown): PublicationWarning {
    const warning: PublicationWarning = {
      phase,
      error,
      message: error instanceof Error ? error.message : String(error),
      retryable: isRetryable(error),
    };
    this.lastWarning = warning;
    try {
      this.onWarning?.(warning);
    } catch {
      // A view/diagnostic warning sink cannot change publication semantics.
    }
    return warning;
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function isPublishableOperation(result: SuccessfulOperation): boolean {
  return (
    result.operation === "build" ||
    result.operation === "update" ||
    result.operation === "rebuild" ||
    result.operation === "prepare"
  );
}

function isRetryable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "retryable" in error
    ? (error as { retryable?: unknown }).retryable !== false
    : true;
}

function randomPublicationId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
