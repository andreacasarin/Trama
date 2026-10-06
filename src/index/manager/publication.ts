import { SQLITE_BUILD_IDENTITY } from "@/build/identity";
import { StructuredError } from "@/domain/contracts";
import { diagnosticsEnabled } from "@/diagnostics/TramaDiagnostics";
import {
  SQLITE_SNAPSHOT_MAX_BYTES,
  type PublicationInspection,
  type PublicationPrepared,
  type SqliteState,
} from "@/index/sqlite/protocol";
import type { PublicationInspector } from "./contracts";
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

  async ingestCacheShard(
    bytes: ArrayBuffer,
    digest: string
  ): Promise<{
    imported: number;
    duplicate: boolean;
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
      profile: string;
      taskKind: "document" | "query";
    };
    if (!result.duplicate) {
      const state = (await this.runtime.ensureClient().call("getState", {})) as SqliteState;
      this.runtime.setState(state);
    }
    return result;
  }

  async extractLegacyCacheShard(
    bytes: ArrayBuffer | undefined,
    digest: string,
    afterActionKey?: string
  ) {
    if (this.runtime.building || this.runtime.preparing || this.runtime.isInMaintenance())
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    this.runtime.beginMaintenance();
    try {
      if (!this.runtime.loaded) await this.runtime.load();
      if (this.runtime.unavailable || !this.runtime.state)
        throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
      return await this.runtime.ensureClient().call("extractLegacyCacheShard", {
        ...(bytes ? { bytes } : {}),
        digest,
        afterActionKey,
      });
    } finally {
      this.runtime.endMaintenance();
    }
  }

  async hasLegacyCacheSource(digest: string): Promise<boolean> {
    if (!this.runtime.loaded) await this.runtime.load();
    if (this.runtime.unavailable || !this.runtime.state)
      throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
    return Boolean(await this.runtime.ensureClient().call("hasLegacyCacheSource", { digest }));
  }

  async markLegacyCacheSource(digest: string): Promise<void> {
    if (this.runtime.building || this.runtime.preparing || this.runtime.isInMaintenance())
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    this.runtime.beginMaintenance();
    try {
      await this.runtime.ensureClient().call("markLegacyCacheSource", { digest });
    } finally {
      this.runtime.endMaintenance();
    }
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
  /** Keep local mutations and adoption out until the vault copy and live ID agree. */
  async publishPublication<T>(
    publicationId: string,
    install: (prepared: PublicationPrepared, inspect?: PublicationInspector) => Promise<T>,
    settle: (committed: boolean) => Promise<void> = async () => undefined
  ): Promise<{ prepared: PublicationPrepared; installed: T }> {
    if (this.runtime.building || this.runtime.preparing || this.runtime.isInMaintenance())
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    if (!publicationId)
      throw new StructuredError("invalid_request", "Publication ID is required.", false);
    const overallTimer = this.runtime.performanceTimer();
    this.runtime.beginMaintenance();
    try {
      if (!this.runtime.loaded) await this.runtime.load();
      if (this.runtime.unavailable || !this.runtime.state)
        throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
      if (this.runtime.state.incomplete)
        throw new StructuredError("busy", "Index must be converged before publication.", true);
      const overallOperationId = overallTimer
        ? this.runtime.ensureClient().diagnosticOperationId()
        : undefined;
      const prepareTimer = this.runtime.performanceTimer();
      const prepareClient = this.runtime.ensureClient();
      const prepareOperationId = prepareTimer ? prepareClient.diagnosticOperationId() : undefined;
      const prepared = (await prepareClient.call(
        "preparePublication",
        {
          publicationId,
        },
        undefined,
        {
          diagnosticOperationId: prepareOperationId,
          diagnosticParentOperationId: overallOperationId,
          diagnosticBatchId: prepareOperationId,
        }
      )) as PublicationPrepared;
      this.runtime.emitPhase(
        "publication",
        "prepare",
        prepareTimer,
        1,
        prepared.byteSize,
        prepareOperationId,
        overallOperationId,
        prepareOperationId
      );
      const installTimer = this.runtime.performanceTimer();
      const installed = await install(prepared, (bytes, transferOwnership) =>
        this.inspectPublicationReserved(
          bytes,
          transferOwnership,
          overallOperationId,
          prepareOperationId
        )
      );
      this.runtime.emitPhase(
        "publication",
        "install",
        installTimer,
        1,
        prepared.byteSize,
        prepareOperationId,
        overallOperationId,
        prepareOperationId
      );
      let state: SqliteState | undefined;
      try {
        const finalizeTimer = this.runtime.performanceTimer();
        const finalizeClient = this.runtime.ensureClient();
        const finalizeOperationId = finalizeTimer
          ? finalizeClient.diagnosticOperationId()
          : undefined;
        state = (await finalizeClient.call(
          "finalizePublication",
          {
            publicationId,
            expectedChangeCounter: prepared.state.changeCounter,
            expectedLexicalGeneration: prepared.state.lexicalGeneration,
            expectedSemanticGeneration: prepared.state.semanticGeneration,
          },
          undefined,
          {
            diagnosticOperationId: finalizeOperationId,
            diagnosticParentOperationId: overallOperationId,
            diagnosticBatchId: prepareOperationId,
          }
        )) as SqliteState | undefined;
        this.runtime.emitPhase(
          "publication",
          "finalize",
          finalizeTimer,
          1,
          undefined,
          finalizeOperationId,
          overallOperationId,
          prepareOperationId
        );
        if (!state) throw new StructuredError("busy", "Local changes prevented publication.", true);
      } catch (error) {
        await settle(false);
        throw error;
      }
      this.runtime.setState(state);
      await settle(true);
      this.runtime.emitPhase(
        "publication",
        "overall",
        overallTimer,
        1,
        prepared.byteSize,
        overallOperationId
      );
      return { prepared, installed };
    } finally {
      this.runtime.endMaintenance();
    }
  }

  async inspectPublication(
    bytes: ArrayBuffer,
    transferOwnership = false
  ): Promise<PublicationInspection> {
    if (
      !(bytes instanceof ArrayBuffer) ||
      !bytes.byteLength ||
      bytes.byteLength > SQLITE_SNAPSHOT_MAX_BYTES
    )
      throw new StructuredError("invalid_request", "Publication bytes are invalid.", false);
    if (this.runtime.building || this.runtime.preparing || this.runtime.isInMaintenance())
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    this.runtime.beginMaintenance();
    try {
      return await this.inspectPublicationReserved(bytes, transferOwnership);
    } finally {
      this.runtime.endMaintenance();
    }
  }

  private async inspectPublicationReserved(
    bytes: ArrayBuffer,
    transferOwnership = false,
    parentOperationId?: string,
    batchId?: string
  ): Promise<PublicationInspection> {
    if (!this.runtime.loaded) await this.runtime.load();
    if (this.runtime.unavailable || !this.runtime.state)
      throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
    const client = this.runtime.ensureClient();
    const operationId = diagnosticsEnabled(this.runtime.diagnostics, "performance")
      ? client.diagnosticOperationId()
      : undefined;
    return (await client.call(
      "inspectPublication",
      {
        bytes,
        corpusFingerprint: await this.runtime.corpusFingerprintId(),
        embeddingFingerprint: await this.runtime.embeddingFingerprintId(),
        buildIdentity: SQLITE_BUILD_IDENTITY,
        dimensions: this.runtime.fingerprint.dimensions,
      },
      undefined,
      {
        transferOwnedBytes: transferOwnership,
        diagnosticOperationId: operationId,
        diagnosticParentOperationId: parentOperationId,
        diagnosticBatchId: batchId,
      }
    )) as PublicationInspection;
  }

  /** Adopt a validated publication directly; no Markdown reconciliation or republish follows. */
  async adoptPublication(
    bytes: ArrayBuffer,
    expectedPublicationId?: string,
    inspection?: PublicationInspection
  ): Promise<SqliteState> {
    if (this.runtime.building || this.runtime.preparing || this.runtime.isInMaintenance())
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    if (
      !(bytes instanceof ArrayBuffer) ||
      !bytes.byteLength ||
      bytes.byteLength > SQLITE_SNAPSHOT_MAX_BYTES
    )
      throw new StructuredError("invalid_request", "Publication bytes are invalid.", false);
    const adoptionTimer = this.runtime.performanceTimer();
    this.runtime.beginMaintenance();
    try {
      if (!this.runtime.loaded) await this.runtime.load();
      if (this.runtime.unavailable || !this.runtime.state)
        throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
      const adoptionClient = this.runtime.ensureClient();
      const adoptionOperationId = adoptionTimer
        ? adoptionClient.diagnosticOperationId()
        : undefined;
      const state = (await adoptionClient.call(
        "adoptPublication",
        {
          bytes,
          expectedPublicationId,
          inspection,
          corpusFingerprint: await this.runtime.corpusFingerprintId(),
          embeddingFingerprint: await this.runtime.embeddingFingerprintId(),
          buildIdentity: SQLITE_BUILD_IDENTITY,
          dimensions: this.runtime.fingerprint.dimensions,
        },
        undefined,
        { diagnosticOperationId: adoptionOperationId }
      )) as SqliteState;
      this.runtime.setState(state);
      this.runtime.unavailable = false;
      this.runtime.freshness = state.incomplete
        ? "unknown"
        : state.snapshotLoaded
          ? "snapshot-loaded"
          : "locally-reconciled";
      this.runtime.emitPhase(
        "adoption",
        "overall",
        adoptionTimer,
        1,
        bytes.byteLength,
        adoptionOperationId
      );
      return state;
    } finally {
      this.runtime.endMaintenance();
    }
  }
}
