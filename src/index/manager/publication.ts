import { SQLITE_BUILD_IDENTITY } from "@/build/identity";
import { StructuredError } from "@/domain/contracts";
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
    this.runtime.beginMaintenance();
    try {
      if (!this.runtime.loaded) await this.runtime.load();
      if (this.runtime.unavailable || !this.runtime.state)
        throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
      if (this.runtime.state.incomplete)
        throw new StructuredError("busy", "Index must be converged before publication.", true);
      const prepared = (await this.runtime.ensureClient().call("preparePublication", {
        publicationId,
      })) as PublicationPrepared;
      const installed = await install(prepared, (bytes, transferOwnership) =>
        this.inspectPublicationReserved(bytes, transferOwnership)
      );
      let state: SqliteState | undefined;
      try {
        state = (await this.runtime.ensureClient().call("finalizePublication", {
          publicationId,
          expectedChangeCounter: prepared.state.changeCounter,
          expectedLexicalGeneration: prepared.state.lexicalGeneration,
          expectedSemanticGeneration: prepared.state.semanticGeneration,
        })) as SqliteState | undefined;
        if (!state) throw new StructuredError("busy", "Local changes prevented publication.", true);
      } catch (error) {
        await settle(false);
        throw error;
      }
      this.runtime.setState(state);
      await settle(true);
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
    transferOwnership = false
  ): Promise<PublicationInspection> {
    if (!this.runtime.loaded) await this.runtime.load();
    if (this.runtime.unavailable || !this.runtime.state)
      throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
    return (await this.runtime.ensureClient().call(
      "inspectPublication",
      {
        bytes,
        corpusFingerprint: await this.runtime.corpusFingerprintId(),
        embeddingFingerprint: await this.runtime.embeddingFingerprintId(),
        buildIdentity: SQLITE_BUILD_IDENTITY,
        dimensions: this.runtime.fingerprint.dimensions,
      },
      undefined,
      { transferOwnedBytes: transferOwnership }
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
    this.runtime.beginMaintenance();
    try {
      if (!this.runtime.loaded) await this.runtime.load();
      if (this.runtime.unavailable || !this.runtime.state)
        throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
      const state = (await this.runtime.ensureClient().call("adoptPublication", {
        bytes,
        expectedPublicationId,
        inspection,
        corpusFingerprint: await this.runtime.corpusFingerprintId(),
        embeddingFingerprint: await this.runtime.embeddingFingerprintId(),
        buildIdentity: SQLITE_BUILD_IDENTITY,
        dimensions: this.runtime.fingerprint.dimensions,
      })) as SqliteState;
      this.runtime.setState(state);
      this.runtime.unavailable = false;
      this.runtime.freshness = state.incomplete
        ? "unknown"
        : state.snapshotLoaded
          ? "snapshot-loaded"
          : "locally-reconciled";
      return state;
    } finally {
      this.runtime.endMaintenance();
    }
  }
}
