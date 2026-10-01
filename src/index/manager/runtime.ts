import { SQLITE_BUILD_IDENTITY, TRAMA_RUNTIME_BUILD_ID } from "@/build/identity";
import {
  StructuredError,
  type IndexCapabilities,
  type IndexFreshness,
  type IndexProgress,
} from "@/domain/contracts";
import {
  NOOP_TRAMA_DIAGNOSTICS,
  diagnosticTimer,
  diagnosticsEnabled,
  emitTramaDiagnostic,
  projectDiagnosticError,
  type TramaDiagnosticInput,
  type TramaDiagnostics,
  type TramaPerformanceRecord,
  type PerformancePhase,
} from "@/diagnostics/TramaDiagnostics";
import {
  corpusIdentityInput,
  embeddingIdentityInput,
  indexIdentity,
  isPathExcluded,
  normalizeVaultPath,
  sha256Hex,
} from "@/index/Identity";
import { lexicalIndex, semanticIndex } from "@/index/IndexChannel";
import { SqliteWorkerClient } from "@/index/sqlite/client";
import { SQLITE_PROTOCOL_VERSION, sqliteError, type SqliteState } from "@/index/sqlite/protocol";
import { INDEX_SCHEMA_VERSION } from "@/index/chunking";
import type {
  IndexFingerprint,
  IndexManagerOptions,
  IndexOperationResult,
  IndexVaultDocument,
  IndexVaultPort,
} from "./contracts";

export function check(signal: AbortSignal): void {
  if (signal.aborted) throw new StructuredError("cancelled", "Index operation cancelled.", true);
}

export class IndexRuntime {
  client?: SqliteWorkerClient;
  state?: SqliteState;
  loaded = false;
  unavailable = false;
  loadError?: unknown;
  building = false;
  preparing = false;
  freshness: IndexFreshness = "unknown";
  loadPromise?: Promise<boolean>;
  buildPromise?: Promise<unknown>;

  private maintenance = false;
  private maintenanceFinished?: Promise<void>;
  private releaseMaintenance?: () => void;

  constructor(
    readonly vault: IndexVaultPort,
    readonly fingerprint: IndexFingerprint,
    readonly options: IndexManagerOptions,
    readonly diagnostics: TramaDiagnostics
  ) {}

  ensureClient(): SqliteWorkerClient {
    if (!this.client) {
      if (this.options.sqliteClient) {
        this.client = this.options.sqliteClient;
        return this.client;
      }
      let worker = this.options.worker;
      if (!worker && this.options.workerFactory) {
        try {
          worker = this.options.workerFactory();
        } catch {
          throw sqliteError(
            "storage_unavailable",
            "SQLite Worker could not be started. Ensure the bundled SQLite assets are installed.",
            true
          );
        }
      }
      this.client = new SqliteWorkerClient(worker, undefined, this.diagnostics);
    }
    return this.client;
  }

  async corpusFingerprintId(): Promise<string> {
    return sha256Hex(
      corpusIdentityInput({
        schemaVersion: this.fingerprint.schemaVersion,
        extractionVersion: this.fingerprint.extractionVersion,
        chunking: this.fingerprint.chunking,
        excludedPaths: this.fingerprint.effectiveExcludedPaths ?? this.fingerprint.excludedPaths,
      })
    );
  }

  async embeddingFingerprintId(): Promise<string> {
    return sha256Hex(
      embeddingIdentityInput({
        embeddingBaseUrl: this.fingerprint.embeddingBaseUrl,
        modelId: this.fingerprint.modelId,
        dimensions: this.fingerprint.dimensions,
        preprocessingVersion: "normalized-float32-v1",
      })
    );
  }

  changeCounter(): number {
    return this.state?.changeCounter ?? 0;
  }

  generationId(): string {
    return indexIdentity(this.changeCounter());
  }

  setState(state: SqliteState): void {
    this.state = state;
    if (state.incomplete) this.freshness = "unknown";
  }

  isInMaintenance(): boolean {
    return this.maintenance;
  }

  async waitForMaintenance(signal: AbortSignal): Promise<void> {
    while (this.maintenance) {
      await this.maintenanceFinished;
      check(signal);
    }
  }

  beginMaintenance(): void {
    this.maintenance = true;
    this.maintenanceFinished = new Promise<void>((resolve) => {
      this.releaseMaintenance = resolve;
    });
  }

  endMaintenance(): void {
    this.maintenance = false;
    this.releaseMaintenance?.();
    this.releaseMaintenance = undefined;
    this.maintenanceFinished = undefined;
  }

  capabilities(): IndexCapabilities {
    const available = this.loaded && !this.unavailable;
    return {
      availability: available ? "available" : "unavailable",
      lexical: lexicalIndex.status(this.state, available, this.building),
      semantic: semanticIndex.status(this.state, available, this.preparing),
      freshness: this.freshness,
      ...(this.state?.publicationId ? { publicationId: this.state.publicationId } : {}),
    };
  }

  hasUsableIndex(): boolean {
    return (
      !this.unavailable && !this.maintenance && this.loaded && (this.state?.noteCount ?? 0) > 0
    );
  }

  async load(emit = false): Promise<boolean> {
    if (!this.loadPromise) this.loadPromise = this.loadPersisted(emit);
    return this.loadPromise;
  }

  private async loadPersisted(emit: boolean): Promise<boolean> {
    const observable =
      diagnosticsEnabled(this.diagnostics, "detailed") &&
      (emit || this.diagnostics !== NOOP_TRAMA_DIAGNOSTICS);
    const started = observable ? Date.now() : undefined;
    if (observable && diagnosticsEnabled(this.diagnostics, "detailed"))
      this.emit({
        area: "index",
        event: "index_operation",
        operation: "load",
        stage: "started",
        phase: "boot",
      });
    try {
      const actualBuildId = await this.ensureClient().handshake(TRAMA_RUNTIME_BUILD_ID);
      if (observable && diagnosticsEnabled(this.diagnostics, "detailed"))
        this.emit({
          area: "index",
          event: "index_operation",
          operation: "startup",
          stage: "completed",
          phase: "handshake",
          runtime: {
            expectedBuildId: TRAMA_RUNTIME_BUILD_ID,
            actualBuildId,
            protocolVersion: SQLITE_PROTOCOL_VERSION,
            schemaVersion: INDEX_SCHEMA_VERSION,
          },
        });
      const sqliteIdentity = await (this.options.sqliteIdentity ?? "default-vault");
      const state = (await this.ensureClient().call("boot", {
        corpusFingerprint: await this.corpusFingerprintId(),
        embeddingFingerprint: await this.embeddingFingerprintId(),
        buildIdentity: SQLITE_BUILD_IDENTITY,
        dimensions: this.fingerprint.dimensions,
        identity: await sha256Hex(sqliteIdentity),
      })) as SqliteState;
      this.setState(state);
      this.freshness = state.snapshotLoaded
        ? "snapshot-loaded"
        : state.incomplete
          ? "unknown"
          : "locally-reconciled";
      this.unavailable = false;
      this.loadError = undefined;
      if (observable && diagnosticsEnabled(this.diagnostics, "detailed"))
        this.emit({
          area: "index",
          event: "index_operation",
          operation: "load",
          stage: "completed",
          phase: "boot",
          durationMs: started === undefined ? 0 : Date.now() - started,
          generation: this.generationId(),
          counts: { notes: this.state!.noteCount, chunks: this.state!.chunkCount },
        });
      return true;
    } catch (error) {
      this.unavailable = true;
      this.loadError = error;
      if (observable && diagnosticsEnabled(this.diagnostics, "detailed"))
        this.emit({
          area: "index",
          event: "index_operation",
          operation: "load",
          stage: "failed",
          durationMs: started === undefined ? 0 : Date.now() - started,
          error: projectDiagnosticError(error),
        });
      return false;
    } finally {
      this.loaded = true;
    }
  }

  requireAvailable(): void {
    if (this.unavailable || !this.state)
      throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
  }

  isIndexEligible(path: string): boolean {
    try {
      const normalized = normalizeVaultPath(path);
      const excluded = [
        ...(this.options.excludedPaths ?? []),
        ...(this.options.publicationDirectory ? [this.options.publicationDirectory] : []),
      ];
      if (excluded.some((entry) => isPathExcluded(normalized, entry))) return false;
      return (
        this.options.isIndexEligible?.(normalized) ??
        this.vault.isIndexEligible?.(normalized) ??
        true
      );
    } catch {
      return false;
    }
  }

  async readMarkdownIfAvailable(
    path: string,
    signal: AbortSignal,
    operation: "full" | "incremental"
  ): Promise<IndexVaultDocument | undefined> {
    if (!this.isIndexEligible(path)) return undefined;
    try {
      return await this.vault.readMarkdown(path, signal);
    } catch (error) {
      check(signal);
      let available = true;
      try {
        available = (await this.vault.isMarkdownAvailable?.(path, signal)) ?? true;
      } catch {
        /* preserve read error */
      }
      if (available) throw error;
      if (diagnosticsEnabled(this.diagnostics, "detailed"))
        this.emit({
          area: "index",
          event: "index_operation",
          operation,
          stage: "skipped-unavailable-note",
          path,
          error: projectDiagnosticError(error),
        });
      return undefined;
    }
  }

  notifySuccessfulOperation(result: IndexOperationResult): void {
    try {
      const pending = this.options.onSuccessfulOperation?.(result);
      if (pending) void pending.catch(() => undefined);
    } catch {
      /* Publication is a follow-up concern and cannot invalidate a local commit. */
    }
  }

  emit(record: TramaDiagnosticInput): void {
    emitTramaDiagnostic(this.diagnostics, record);
  }

  performanceTimer(): (() => number) | undefined {
    return diagnosticTimer(this.diagnostics, "performance");
  }

  emitPhase(
    operation: TramaPerformanceRecord["operation"],
    phase: PerformancePhase,
    timer: (() => number) | undefined,
    itemCount?: number,
    byteCount?: number,
    operationId?: string,
    parentOperationId?: string,
    batchId?: string
  ): void {
    if (!timer) return;
    this.emit({
      tier: "performance",
      facets: ["index", operation],
      area: "index",
      event: "phase",
      operation,
      phase,
      durationMs: timer(),
      ...(itemCount === undefined ? {} : { itemCount }),
      ...(byteCount === undefined ? {} : { byteCount }),
      ...(operationId || parentOperationId || batchId
        ? {
            context: {
              sessionId: this.diagnostics.context?.sessionId ?? "none",
              operationId,
              parentOperationId,
              batchId,
            },
          }
        : {}),
    });
  }

  reportProgress(progress: IndexProgress, emitDiagnostic = true): void {
    const next = Object.freeze({ ...progress });
    if (emitDiagnostic && diagnosticsEnabled(this.diagnostics, "detailed"))
      this.emit({
        area: "index",
        event: "index_operation",
        operation: progress.operation === "startup" ? "startup" : progress.operation,
        stage: "started",
        phase: progress.phase,
        completed: progress.completed,
        ...(progress.total === undefined ? {} : { total: progress.total }),
        unit: progress.unit,
        determinate: progress.determinate,
        ...(progress.generationId ? { generation: progress.generationId } : {}),
      });
    try {
      this.options.onProgress?.(next);
    } catch {
      /* observational */
    }
  }
}
