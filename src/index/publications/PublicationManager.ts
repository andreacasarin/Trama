import { StructuredError, type IndexCapabilities } from "@/domain/contracts";
import { sha256Hex } from "@/index/Identity";
import {
  SqliteProtocolError,
  type PublicationInspection,
  type PublicationPrepared,
  type SqliteState,
} from "@/index/sqlite/protocol";
import { PublicationStore, type PublicationDataAdapter } from "./PublicationStore";

export interface PublicationIndexPort {
  publishPublication<T>(
    publicationId: string,
    install: (
      prepared: PublicationPrepared,
      inspect?: (bytes: ArrayBuffer, transferOwnership?: boolean) => Promise<PublicationInspection>
    ) => Promise<T>,
    settle?: (committed: boolean) => Promise<void>
  ): Promise<{ prepared: PublicationPrepared; installed: T }>;
  inspectPublication(
    bytes: ArrayBuffer,
    transferOwnership?: boolean
  ): Promise<PublicationInspection>;
  adoptPublication(
    bytes: ArrayBuffer,
    expectedPublicationId?: string,
    inspection?: PublicationInspection
  ): Promise<SqliteState>;
  getState?(): Promise<SqliteState | undefined>;
  capabilities?(): IndexCapabilities;
}

export interface PublicationWarning {
  readonly phase: "prepare" | "stage" | "replace" | "finalize" | "inspect" | "adopt";
  readonly code?: string;
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
  readonly replacementRequired?: boolean;
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
}

/**
 * Executes publication and adoption transactions. Timing and serialization are
 * owned by MaintenanceScheduler; the index port fences mutations once started.
 */
export class PublicationManager {
  private readonly idFactory: () => string;
  private readonly onWarning?: (warning: PublicationWarning) => void;
  private readonly onMetrics?: (metrics: PublicationResourceMetrics) => void;
  private lastMetrics?: PublicationResourceMetrics;
  private replacementTargetDigest?: string;

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
  }

  get metrics(): PublicationResourceMetrics | undefined {
    return this.lastMetrics;
  }

  async publish(): Promise<PublicationResult> {
    return this.publishSerialized();
  }

  /** Inspect and adopt the exact configured file without publishing directly. */
  async adoptCurrent(): Promise<AdoptionResult> {
    return this.adoptSerialized();
  }

  private async publishSerialized(): Promise<PublicationResult> {
    const started = Date.now();
    const id = this.idFactory();
    let phase: PublicationWarning["phase"] = "prepare";
    let hadPrevious: boolean | undefined;
    try {
      const { prepared, installed } = await this.index.publishPublication(
        id,
        async (candidate, inspect) => {
          phase = "stage";
          const stageStarted = Date.now();
          const staged = await this.store.stage(candidate.bytes, id);
          const stageDurationMs = Date.now() - stageStarted;
          try {
            phase = "inspect";
            const inspection = await (inspect ?? this.index.inspectPublication.bind(this.index))(
              staged.bytes,
              true
            );
            if (inspection.publicationId !== id)
              throw new StructuredError("internal", "Publication ID changed in staged copy.", true);
            phase = "replace";
            await this.verifyReplacementTarget();
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
      this.lastMetrics = metrics;
      this.replacementTargetDigest = undefined;
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
    if (!bytes) {
      this.replacementTargetDigest = undefined;
      return { adopted: false, ignored: "missing" };
    }
    return this.adoptBytesSerialized(bytes);
  }

  private async adoptBytesSerialized(bytes: ArrayBuffer): Promise<AdoptionResult> {
    let inspection: PublicationInspection;
    try {
      inspection = await this.index.inspectPublication(bytes);
    } catch (error) {
      if (publicationErrorDetails(error).code === "incompatible_state") {
        this.replacementTargetDigest = await sha256Hex(bytes);
        return { adopted: false, replacementRequired: true };
      }
      return { adopted: false, warning: this.warn("inspect", error) };
    }
    this.replacementTargetDigest = undefined;
    let current: string | undefined;
    try {
      current = await this.currentPublicationId();
    } catch (error) {
      return { adopted: false, warning: this.warn("inspect", error) };
    }
    if (current === inspection.publicationId)
      return { adopted: false, ignored: "same-id", publicationId: current };
    try {
      const state = await this.index.adoptPublication(bytes, inspection.publicationId, inspection);
      // An adopted candidate is authoritative as loaded data. Never publish or reconcile here.
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

  /** Refuse to overwrite a synchronized target that changed during local convergence. */
  private async verifyReplacementTarget(): Promise<void> {
    const expected = this.replacementTargetDigest;
    if (!expected) return;
    const current = await this.store.read();
    if (!current || (await sha256Hex(current)) === expected) return;
    try {
      await this.index.inspectPublication(current);
    } catch (error) {
      if (publicationErrorDetails(error).code === "upgrade_required") throw error;
    }
    throw new StructuredError(
      "busy",
      "The synchronized index changed while its replacement was being prepared. Check it again.",
      true
    );
  }

  private failed(phase: PublicationWarning["phase"], error: unknown): PublicationResult {
    const warning = this.warn(phase, error);
    return { published: false, warning };
  }

  private warn(phase: PublicationWarning["phase"], error: unknown): PublicationWarning {
    const details = publicationErrorDetails(error);
    const warning: PublicationWarning = {
      phase,
      ...(details.code ? { code: details.code } : {}),
      error,
      message: error instanceof Error ? error.message : String(error),
      retryable: isRetryable(error),
    };
    try {
      this.onWarning?.(warning);
    } catch {
      // A view/diagnostic warning sink cannot change publication semantics.
    }
    return warning;
  }
}

function isRetryable(error: unknown): boolean {
  const details = publicationErrorDetails(error);
  if (details.code && PERMANENT_PUBLICATION_CODES.has(details.code)) return false;
  if (details.retryable !== undefined) return details.retryable;
  if (details.code === "busy") return true;
  return true;
}

interface PublicationErrorDetails {
  readonly code?: string;
  readonly retryable?: boolean;
  readonly phase?: string;
}

const PERMANENT_PUBLICATION_CODES = new Set([
  "integrity_failed",
  "invalid_request",
  "incompatible_state",
  "upgrade_required",
  "limit_exceeded",
]);

/** Reads direct and nested RPC errors without assuming a same-realm Error instance. */
function publicationErrorDetails(error: unknown): PublicationErrorDetails {
  const seen = new Set<object>();
  let current: unknown = error;
  let result: PublicationErrorDetails = {};
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as {
      code?: unknown;
      retryable?: unknown;
      phase?: unknown;
      error?: unknown;
    };
    const code = typeof value.code === "string" ? value.code : undefined;
    const retryable = typeof value.retryable === "boolean" ? value.retryable : undefined;
    const phase = typeof value.phase === "string" ? value.phase : undefined;
    if (code !== undefined || retryable !== undefined || phase !== undefined) {
      result = {
        code: code ?? result.code,
        retryable: retryable ?? result.retryable,
        phase: phase ?? result.phase,
      };
    }
    if (current instanceof SqliteProtocolError || value.error !== undefined) {
      current = value.error;
      continue;
    }
    break;
  }
  return result;
}

function randomPublicationId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
