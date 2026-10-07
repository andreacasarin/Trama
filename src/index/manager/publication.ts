import { StructuredError } from "@/domain/contracts";
import { type SqliteState } from "@/index/sqlite/protocol";
import { IndexRuntime } from "./runtime";

export class PublicationService {
  constructor(private readonly runtime: IndexRuntime) {}

  async prepareCacheShard(
    afterActionKey?: string,
    taskKind: "document" | "query" = "document",
    profile?: string,
    sourceDigests?: readonly string[],
    presentDigests?: readonly string[],
    maxPayloadBytes?: number,
    now?: number
  ): Promise<import("@/index/sqlite/cache-shards").CacheShardResult | undefined> {
    if (this.runtime.building || this.runtime.preparing || this.runtime.isInMaintenance())
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    this.runtime.beginMaintenance();
    try {
      if (!this.runtime.loaded) await this.runtime.load();
      if (this.runtime.unavailable || !this.runtime.state)
        throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
      return (await this.runtime.ensureClient().call("prepareCacheShard", {
        afterActionKey,
        taskKind,
        profile,
        sourceDigests,
        presentDigests,
        maxPayloadBytes,
        now,
      })) as import("@/index/sqlite/cache-shards").CacheShardResult | undefined;
    } finally {
      this.runtime.endMaintenance();
    }
  }

  async listCacheReceipts(
    digests: readonly string[]
  ): Promise<{ digest: string; profile: string }[]> {
    if (!this.runtime.loaded) await this.runtime.load();
    return this.runtime.ensureClient().call("listCacheReceipts", { digests });
  }

  async ingestCacheShard(
    bytes: ArrayBuffer,
    digest: string
  ): Promise<{
    imported: number;
    duplicate: boolean;
    ignored?: boolean;
    profile: string;
    taskKind: "document" | "query";
  }> {
    if (this.runtime.building || this.runtime.preparing || this.runtime.isInMaintenance())
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    if (!this.runtime.loaded) await this.runtime.load();
    if (this.runtime.unavailable || !this.runtime.state)
      throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
    const result = (await this.runtime
      .ensureClient()
      .call("ingestCacheShard", { bytes, digest })) as {
      imported: number;
      duplicate: boolean;
      ignored?: boolean;
      profile: string;
      taskKind: "document" | "query";
    };
    if (!result.duplicate && !result.ignored) {
      const state = (await this.runtime.ensureClient().call("getState", {})) as SqliteState;
      this.runtime.setState(state);
    }
    return result;
  }
  maintainCache(now: number): Promise<{
    expiredRows: number;
    unusedRows: number;
    expiredSourceDigests: string[];
    lastCompactionAt: number;
  }> {
    return this.runtime.ensureClient().call("maintainCache", { now });
  }
  recordCacheShard(
    digest: string,
    profile: string,
    taskKind: "document" | "query",
    actionKeys: readonly string[]
  ): Promise<void> {
    return this.runtime
      .ensureClient()
      .call("recordCacheShard", { digest, profile, taskKind, actionKeys });
  }
  recordCacheRetirements(
    sourceDigests: readonly string[],
    replacementDigests: readonly string[],
    now: number
  ): Promise<void> {
    return this.runtime
      .ensureClient()
      .call("recordCacheRetirements", { sourceDigests, replacementDigests, now });
  }
  listCacheRetirements(): Promise<import("@/index/sqlite/cache-shards").CacheRetirement[]> {
    return this.runtime.ensureClient().call("listCacheRetirements", {});
  }
  completeCacheRetirement(sourceDigest: string, now: number): Promise<void> {
    return this.runtime.ensureClient().call("completeCacheRetirement", { sourceDigest, now });
  }
}
