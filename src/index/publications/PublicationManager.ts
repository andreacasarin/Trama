import { StructuredError, type IndexCapabilities } from "@/domain/contracts";
import { sha256Hex } from "@/index/Identity";
import { SqliteProtocolError, type SqliteState } from "@/index/sqlite/protocol";
import { PublicationStore, type PublicationDataAdapter } from "./PublicationStore";
import type { CacheShardResult } from "@/index/sqlite/cache-shards";

export interface PublicationIndexPort {
  listCacheReceipts?(digests: readonly string[]): Promise<{ digest: string; profile: string }[]>;
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
    ignored?: boolean;
    profile: string;
    taskKind: "document" | "query";
  }>;
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
  readonly byteSize: number;
  readonly copyBytes: number;
  readonly durationMs: number;
  readonly stageDurationMs?: number;
  readonly replaceDurationMs?: number;
}

export interface PublicationResult {
  readonly published: boolean;
  readonly metrics?: PublicationResourceMetrics;
  readonly warning?: PublicationWarning;
}

export interface AdoptionResult {
  readonly adopted: boolean;
  readonly ignored?: "missing" | "same-id";
  readonly state?: SqliteState;
  readonly warning?: PublicationWarning;
}

export interface PublicationManagerOptions {
  readonly directory?: unknown;
  readonly temporaryToken?: () => string;
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

  async publish(shouldYield?: () => boolean): Promise<PublicationResult> {
    return this.publishCacheShards(shouldYield);
  }

  /** Inspect and adopt the exact configured file without publishing directly. */
  async adoptCurrent(shouldYield?: () => boolean): Promise<AdoptionResult> {
    return this.ingestCacheShards(shouldYield);
  }

  private async publishCacheShards(shouldYield?: () => boolean): Promise<PublicationResult> {
    const started = Date.now();
    let totalBytes = 0;
    try {
      if (!this.index.prepareCacheShard)
        throw new StructuredError("unavailable", "Cache shard export is unavailable.", true);
      const now = Date.now();
      if (shouldYield?.()) return { published: false };
      const retention = (await this.index.maintainCache?.(now)) as
        { expiredSourceDigests?: readonly string[]; lastCompactionAt?: number } | undefined;
      await this.retireReadyShards(now, shouldYield);
      if (shouldYield?.()) return { published: false };
      if (retention) await this.compactIfDue(retention, now, shouldYield);
      if (shouldYield?.()) return { published: false };
      const state = await this.index.getState?.();
      const profiles = [state?.embeddingFingerprint || undefined];
      const presentDigests = this.store.supportsCacheShardListing()
        ? (await this.store.listCacheShards()).map((file) => file.digest)
        : undefined;
      for (const profile of profiles) {
        for (const taskKind of ["document", "query"] as const) {
          let cursor: string | undefined;
          for (;;) {
            if (shouldYield?.()) return { published: false };
            const shard = await this.index.prepareCacheShard(
              cursor,
              taskKind,
              profile,
              undefined,
              presentDigests
            );
            if (!shard) break;
            if (shouldYield?.()) return { published: false };
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

  private async retireReadyShards(now: number, shouldYield?: () => boolean): Promise<void> {
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
      if (shouldYield?.()) return;
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
        if (shouldYield?.()) return;
        if (listed.has(item.sourceDigest)) await this.store.removeCacheShard(item.sourceDigest);
        await this.index.completeCacheRetirement(item.sourceDigest, now);
      }
    }
  }

  private async compactIfDue(
    retention: { expiredSourceDigests?: readonly string[]; lastCompactionAt?: number },
    now: number,
    shouldYield?: () => boolean
  ): Promise<void> {
    if (!this.index.ingestCacheShard || !this.index.recordCacheRetirements) return;
    if (now - (retention.lastCompactionAt ?? 0) < 7 * 24 * 60 * 60 * 1000) return;
    const files = await this.store.listCacheShards();
    // Sources and their replacements must stay stable throughout the grace window.
    const retirements = (await this.index.listCacheRetirements?.()) ?? [];
    const protectedDigests = new Set(
      retirements.flatMap((item) => [item.sourceDigest, ...item.replacements])
    );
    const receipts = await this.receiptsFor(files.map((file) => file.digest));
    const activeProfile = (await this.index.getState?.())?.embeddingFingerprint;
    const expired = new Set(retention.expiredSourceDigests ?? []);
    const eligible = files.filter(
      (file) =>
        !protectedDigests.has(file.digest) &&
        (!activeProfile ||
          !receipts.has(file.digest) ||
          receipts.get(file.digest) === activeProfile)
    );
    const candidates = expired.size
      ? eligible.filter((file) => expired.has(file.digest))
      : eligible;
    const selected = new Set<string>();
    const captured = new Map<string, ArrayBuffer>();
    let capturedBytes = 0;
    for (const file of candidates) {
      if (shouldYield?.()) return;
      if (captured.size >= 8 || capturedBytes > 12 * 1024 * 1024) break;
      if (!expired.size) {
        const size = await this.store.cacheShardSize(file.path);
        if (size !== undefined && size > 1024 * 1024) continue;
      }
      const bytes = await this.store.readCacheShard(file.path);
      if (bytes.byteLength > 4_194_304 || (await sha256Hex(bytes)) !== file.digest)
        throw new StructuredError(
          "invalid_request",
          "Cache shard size or name hash mismatch.",
          false
        );
      captured.set(file.digest, bytes);
      capturedBytes += bytes.byteLength;
      if (expired.size || bytes.byteLength <= 1024 * 1024) selected.add(file.digest);
    }
    if (!expired.size && selected.size < 8) {
      await this.index.recordCacheRetirements([], [], now);
      return;
    }
    if (!selected.size) {
      await this.index.recordCacheRetirements([], [], now);
      return;
    }
    const grouped = new Map<
      string,
      { profile: string; taskKind: "document" | "query"; digests: string[] }
    >();
    for (const file of files) {
      if (shouldYield?.()) return;
      if (!selected.has(file.digest)) continue;
      const bytes = captured.get(file.digest)!;
      const ingested = await this.index.ingestCacheShard(bytes, file.digest);
      if (ingested.ignored) {
        selected.delete(file.digest);
        continue;
      }
      const key = `${ingested.profile}:${ingested.taskKind}`;
      const group = grouped.get(key) ?? {
        profile: ingested.profile,
        taskKind: ingested.taskKind,
        digests: [],
      };
      group.digests.push(file.digest);
      grouped.set(key, group);
    }
    if (!selected.size) {
      await this.index.recordCacheRetirements([], [], now);
      return;
    }
    const replacementDigests = new Set<string>();
    for (const group of grouped.values()) {
      let cursor: string | undefined;
      for (;;) {
        if (shouldYield?.()) return;
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
        if (shouldYield?.()) return;
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
    if (shouldYield?.()) return;
    await this.index.recordCacheRetirements(
      retireSources,
      retireSources.length ? [...replacementDigests] : [],
      now
    );
  }

  private async receiptsFor(digests: readonly string[]): Promise<Map<string, string>> {
    const receipts = new Map<string, string>();
    for (let offset = 0; offset < digests.length; offset += 512)
      for (const receipt of (await this.index.listCacheReceipts?.(
        digests.slice(offset, offset + 512)
      )) ?? [])
        receipts.set(receipt.digest, receipt.profile);
    return receipts;
  }

  private async ingestCacheShards(shouldYield?: () => boolean): Promise<AdoptionResult> {
    if (!this.index.ingestCacheShard) return { adopted: false, ignored: "missing" };
    try {
      let imported = 0;
      const shards = await this.store.listCacheShards();
      const receipts = await this.receiptsFor(shards.map((shard) => shard.digest));
      let seen = 0;
      for (const shard of shards) {
        if (shouldYield?.()) return { adopted: imported > 0 };
        seen++;
        if (receipts.has(shard.digest)) continue;
        const bytes = await this.store.readCacheShard(shard.path);
        const result = await this.index.ingestCacheShard(bytes, shard.digest);
        if (!result.duplicate) imported += result.imported;
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
