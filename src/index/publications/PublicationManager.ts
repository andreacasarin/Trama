import { StructuredError, type IndexCapabilities } from "@/domain/contracts";
import { sha256Hex } from "@/index/Identity";
import {
  SqliteProtocolError,
  type PublicationInspection,
  type PublicationPrepared,
  type SqliteState,
} from "@/index/sqlite/protocol";
import { PublicationStore, type PublicationDataAdapter } from "./PublicationStore";
import type { CacheShardResult } from "@/index/sqlite/cache-shards";

export interface PublicationIndexPort {
  prepareCacheShard?(
    afterActionKey?: string,
    taskKind?: "document" | "query",
    profile?: string,
    sourceDigests?: readonly string[],
    presentDigests?: readonly string[],
    maxPayloadBytes?: number,
    now?: number
  ): Promise<CacheShardResult | undefined>;
  ingestCacheShard?(
    bytes: ArrayBuffer,
    digest: string
  ): Promise<{
    imported: number;
    duplicate: boolean;
    profile: string;
    taskKind: "document" | "query";
  }>;
  extractLegacyCacheShard?(
    bytes: ArrayBuffer | undefined,
    digest: string,
    afterActionKey?: string
  ): Promise<CacheShardResult | undefined>;
  hasLegacyCacheSource?(digest: string): Promise<boolean>;
  markLegacyCacheSource?(digest: string): Promise<void>;
  maintainCache?(now: number): Promise<unknown>;
  recordCacheRetirements?(
    sourceDigests: readonly string[],
    replacementDigests: readonly string[],
    now: number
  ): Promise<void>;
  listCacheRetirements?(): Promise<import("@/index/sqlite/cache-shards").CacheRetirement[]>;
  completeCacheRetirement?(sourceDigest: string, now: number): Promise<void>;
  recordCacheShard?(
    digest: string,
    profile: string,
    taskKind: "document" | "query",
    actionKeys: readonly string[]
  ): Promise<void>;
  publishPublication?<T>(
    publicationId: string,
    install: (
      prepared: PublicationPrepared,
      inspect?: (bytes: ArrayBuffer, transferOwnership?: boolean) => Promise<PublicationInspection>
    ) => Promise<T>,
    settle?: (committed: boolean) => Promise<void>
  ): Promise<{ prepared: PublicationPrepared; installed: T }>;
  inspectPublication?(
    bytes: ArrayBuffer,
    transferOwnership?: boolean
  ): Promise<PublicationInspection>;
  adoptPublication?(
    bytes: ArrayBuffer,
    expectedPublicationId?: string,
    inspection?: PublicationInspection
  ): Promise<SqliteState>;
  getState?(): Promise<SqliteState | undefined>;
  capabilities?(): IndexCapabilities;
}

const LEGACY_EXTRACTION_MARKER = "e".repeat(64);

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
  private readonly onWarning?: (warning: PublicationWarning) => void;
  private readonly onMetrics?: (metrics: PublicationResourceMetrics) => void;
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
    this.onWarning = options.onWarning;
    this.onMetrics = options.onMetrics;
  }

  get metrics(): PublicationResourceMetrics | undefined {
    return this.lastMetrics;
  }

  async publish(): Promise<PublicationResult> {
    return this.publishCacheShards();
  }

  /** Inspect and adopt the exact configured file without publishing directly. */
  async adoptCurrent(shouldYield?: () => boolean): Promise<AdoptionResult> {
    return this.ingestCacheShards(shouldYield);
  }

  private async publishCacheShards(): Promise<PublicationResult> {
    const started = Date.now();
    let totalBytes = 0;
    try {
      if (!this.index.prepareCacheShard)
        throw new StructuredError("unavailable", "Cache shard export is unavailable.", true);
      const now = Date.now();
      const retention = (await this.index.maintainCache?.(now)) as
        { expiredSourceDigests?: readonly string[]; lastCompactionAt?: number } | undefined;
      await this.retireReadyShards(now);
      if (retention) await this.compactIfDue(retention, now);
      const state = await this.index.getState?.();
      const profiles: (string | undefined)[] = state?.embeddingProfiles?.length
        ? state.embeddingProfiles.map((profile) => profile.fingerprint)
        : [state?.embeddingFingerprint || undefined];
      const presentDigests = this.store.supportsCacheShardListing()
        ? (await this.store.listCacheShards()).map((file) => file.digest)
        : undefined;
      for (const profile of profiles) {
        for (const taskKind of ["document", "query"] as const) {
          let cursor: string | undefined;
          for (;;) {
            const shard = await this.index.prepareCacheShard(
              cursor,
              taskKind,
              profile,
              undefined,
              presentDigests
            );
            if (!shard) break;
            if (shard.bytes.byteLength !== 0 && shard.bytes.byteLength > 4_194_304)
              throw new StructuredError(
                "invalid_request",
                "Cache shard exceeds the file size limit.",
                false
              );
            if (!shard.rowCount || !shard.nextActionKey || shard.nextActionKey === cursor)
              throw new StructuredError(
                "invalid_request",
                "Cache shard cursor did not advance.",
                false
              );
            await this.store.installCacheShard(shard.bytes, shard.digest);
            await this.index.recordCacheShard?.(
              shard.digest,
              shard.profile,
              taskKind,
              shard.actionKeys
            );
            cursor = shard.nextActionKey;
            totalBytes += shard.bytes.byteLength;
          }
        }
      }
      const metrics = {
        byteSize: totalBytes,
        copyBytes: totalBytes,
        durationMs: Date.now() - started,
      };
      this.lastMetrics = metrics;
      try {
        this.onMetrics?.(metrics);
      } catch {
        /* metrics are observational */
      }
      return { published: true, metrics };
    } catch (error) {
      return this.failed("stage", error);
    }
  }

  private async retireReadyShards(now: number): Promise<void> {
    if (!this.index.listCacheRetirements || !this.index.completeCacheRetirement) return;
    const retirements = await this.index.listCacheRetirements();
    const listed = new Map(
      (await this.store.listCacheShards()).map((file) => [file.digest, file.path])
    );
    const groups = new Map<string, typeof retirements>();
    for (const retirement of retirements) {
      const current = groups.get(retirement.replacementSetId) ?? [];
      current.push(retirement);
      groups.set(retirement.replacementSetId, current);
    }
    for (const group of groups.values()) {
      if (group.some((item) => item.retireAfter > now)) continue;
      const replacements = group[0]?.replacements ?? [];
      let valid = true;
      for (const digest of replacements) {
        const path = listed.get(digest);
        if (!path || (await sha256Hex(await this.store.readCacheShard(path))) !== digest) {
          valid = false;
          break;
        }
      }
      if (!valid) continue;
      for (const item of group) {
        if (listed.has(item.sourceDigest)) await this.store.removeCacheShard(item.sourceDigest);
        await this.index.completeCacheRetirement(item.sourceDigest, now);
      }
    }
  }

  private async compactIfDue(
    retention: { expiredSourceDigests?: readonly string[]; lastCompactionAt?: number },
    now: number
  ): Promise<void> {
    if (!this.index.ingestCacheShard || !this.index.recordCacheRetirements) return;
    if (now - (retention.lastCompactionAt ?? 0) < 7 * 24 * 60 * 60 * 1000) return;
    const files = await this.store.listCacheShards();
    const small: (typeof files)[number][] = [];
    const selected = new Set<string>();
    let capturedBytes = 0;
    const expired = new Set(retention.expiredSourceDigests ?? []);
    for (const file of files) {
      const bytes = await this.store.readCacheShard(file.path);
      if ((await sha256Hex(bytes)) !== file.digest)
        throw new StructuredError("internal", "Cache shard name hash mismatch.", false);
      if (expired.has(file.digest)) {
        if (capturedBytes + bytes.byteLength <= 16 * 1024 * 1024) {
          selected.add(file.digest);
          capturedBytes += bytes.byteLength;
        }
      } else if (!expired.size && bytes.byteLength <= 1024 * 1024) {
        small.push(file);
      }
    }
    if (!expired.size) {
      if (small.length < 8) return;
      for (const file of small.slice(0, 8)) selected.add(file.digest);
      capturedBytes = 0;
      for (const file of small.slice(0, 8))
        capturedBytes += (await this.store.readCacheShard(file.path)).byteLength;
    }
    if (!selected.size || capturedBytes > 16 * 1024 * 1024) return;
    const grouped = new Map<
      string,
      { profile: string; taskKind: "document" | "query"; digests: string[] }
    >();
    for (const file of files) {
      if (!selected.has(file.digest)) continue;
      const bytes = await this.store.readCacheShard(file.path);
      const ingested = await this.index.ingestCacheShard(bytes, file.digest);
      const key = `${ingested.profile}:${ingested.taskKind}`;
      const group = grouped.get(key) ?? {
        profile: ingested.profile,
        taskKind: ingested.taskKind,
        digests: [],
      };
      group.digests.push(file.digest);
      grouped.set(key, group);
    }
    const replacementDigests = new Set<string>();
    for (const group of grouped.values()) {
      let cursor: string | undefined;
      for (;;) {
        const shard = await this.index.prepareCacheShard?.(
          cursor,
          group.taskKind,
          group.profile,
          group.digests,
          [],
          3_500_000,
          now
        );
        if (!shard) break;
        await this.store.installCacheShard(shard.bytes, shard.digest);
        await this.index.recordCacheShard?.(
          shard.digest,
          shard.profile,
          group.taskKind,
          shard.actionKeys
        );
        replacementDigests.add(shard.digest);
        cursor = shard.nextActionKey;
      }
    }
    const retireSources = [...selected].filter((digest) => !replacementDigests.has(digest));
    await this.index.recordCacheRetirements(
      retireSources,
      retireSources.length ? [...replacementDigests] : [],
      now
    );
  }

  private async ingestCacheShards(shouldYield?: () => boolean): Promise<AdoptionResult> {
    if (!this.index.ingestCacheShard) return { adopted: false, ignored: "missing" };
    try {
      let imported = 0;
      const legacyDone = this.index.hasLegacyCacheSource
        ? await this.index.hasLegacyCacheSource(LEGACY_EXTRACTION_MARKER)
        : false;
      const legacy = legacyDone ? undefined : await this.store.read();
      if (legacy && this.index.extractLegacyCacheShard) {
        const digest = await sha256Hex(legacy);
        let cursor: string | undefined;
        let first = true;
        for (;;) {
          if (shouldYield?.()) return { adopted: imported > 0 };
          const shard = await this.index.extractLegacyCacheShard(
            first ? legacy : undefined,
            digest,
            cursor
          );
          first = false;
          if (!shard) break;
          if (!shard.rowCount || !shard.nextActionKey || shard.nextActionKey === cursor)
            throw new StructuredError(
              "invalid_request",
              "Legacy cache extraction cursor did not advance.",
              false
            );
          await this.store.installCacheShard(shard.bytes, shard.digest);
          const result = await this.index.ingestCacheShard(shard.bytes, shard.digest);
          if (!result.duplicate) imported += result.imported;
          cursor = shard.nextActionKey;
        }
        await this.index.markLegacyCacheSource?.(LEGACY_EXTRACTION_MARKER);
      }
      const shards = await this.store.listCacheShards();
      let seen = 0;
      for (const shard of shards) {
        if (shouldYield?.()) return { adopted: imported > 0 };
        const bytes = await this.store.readCacheShard(shard.path);
        const result = await this.index.ingestCacheShard(bytes, shard.digest);
        if (!result.duplicate) imported += result.imported;
        seen++;
      }
      return { adopted: imported > 0, ignored: seen ? "same-id" : "missing" };
    } catch (error) {
      return { adopted: false, warning: this.warn("inspect", error) };
    }
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
