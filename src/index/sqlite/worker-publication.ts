import { MutableSqliteDatabase, type SqliteConnection } from "./database";
import {
  SQLITE_SNAPSHOT_MAX_BYTES,
  sqliteError,
  type PublicationInspection,
  type PublicationPrepared,
  type SqliteRequestPayloads,
  type SqliteState,
} from "./protocol";
import { exportOpfsDatabase, type WorkerStorageState } from "./worker-lifecycle";
import type { SnapshotValidationPhase } from "./publication";

interface PublicationPool {
  readonly OpfsSAHPoolDb: new (name: string, mode: string) => SqliteConnection;
  exportFile(name: string): Uint8Array | ArrayBuffer;
  importDb(name: string, bytes: Uint8Array | ArrayBuffer): number;
  unlink(name: string): boolean;
}

export interface WorkerRuntimeConfig {
  readonly corpus: string;
  readonly embedding: string;
  readonly dimensions: number;
  readonly buildIdentity: string;
}

interface WorkerPublicationHost {
  readonly storage: WorkerStorageState<MutableSqliteDatabase, SqliteConnection, PublicationPool>;
  openDatabase(): Promise<MutableSqliteDatabase>;
  closeConnection(): void;
  runtimeConfig(database: MutableSqliteDatabase): WorkerRuntimeConfig;
  onPhase?(phase: PublicationPhase, durationMs: number): void;
}

type PublicationPhase =
  | "snapshotValidation"
  | "snapshotLiveExport"
  | "snapshotCandidateImport"
  | "snapshotBootPrune"
  | "snapshotCandidateExport"
  | "snapshotLiveReopen"
  | SnapshotValidationPhase;

/** Owns Worker-side snapshot inspection, publication, and atomic adoption. */
export class WorkerPublicationOperations {
  constructor(private readonly host: WorkerPublicationHost) {}

  async prepare(publicationId: string): Promise<PublicationPrepared> {
    const database = await this.host.openDatabase();
    this.rejectActiveLexicalRun(database);
    const state = database.getState();
    const expected = this.host.runtimeConfig(database);
    const validationStarted = this.phaseStarted();
    try {
      database.validateSnapshot(
        state.corpusFingerprint,
        state.dimensions,
        state.embeddingFingerprint,
        undefined,
        this.validationObserver()
      );
    } finally {
      this.recordPhase("snapshotValidation", validationStarted);
    }
    const started = Date.now();
    const liveExportStarted = this.phaseStarted();
    let original: ArrayBuffer;
    try {
      original = this.liveBytes();
    } finally {
      this.recordPhase("snapshotLiveExport", liveExportStarted);
    }
    this.host.closeConnection();
    const pool = this.pool();
    const name = this.candidateName(publicationId);
    let candidate: MutableSqliteDatabase | undefined;
    try {
      const candidateImportStarted = this.phaseStarted();
      try {
        pool.importDb(name, original);
        candidate = this.openCandidate(name);
      } finally {
        this.recordPhase("snapshotCandidateImport", candidateImportStarted);
      }
      // Boot the imported copy before pruning so cache cleanup uses the active
      // embedding fingerprint and dimensions. The live database remains closed
      // while the candidate is prepared and is reopened in finally below.
      const bootPruneStarted = this.phaseStarted();
      try {
        candidate.boot(
          expected.corpus,
          expected.dimensions,
          expected.embedding,
          expected.buildIdentity
        );
        candidate.pruneForPublication();
        candidate.setPublicationId(publicationId);
      } finally {
        this.recordPhase("snapshotBootPrune", bootPruneStarted);
      }
      const candidateValidationStarted = this.phaseStarted();
      try {
        candidate.validateSnapshot(
          expected.corpus,
          expected.dimensions,
          expected.embedding,
          expected.buildIdentity,
          this.validationObserver()
        );
      } finally {
        this.recordPhase("snapshotValidation", candidateValidationStarted);
      }
      const candidateExportStarted = this.phaseStarted();
      let bytes: ArrayBuffer;
      try {
        bytes = exportOpfsDatabase(pool, name);
      } finally {
        this.recordPhase("snapshotCandidateExport", candidateExportStarted);
      }
      if (bytes.byteLength > SQLITE_SNAPSHOT_MAX_BYTES)
        throw sqliteError("integrity_failed", "SQLite publication exceeds the safety limit");
      return {
        publicationId,
        state: candidate.getState(),
        bytes,
        byteSize: bytes.byteLength,
        durationMs: Date.now() - started,
        copyBytes: original.byteLength + bytes.byteLength,
      };
    } finally {
      candidate?.close();
      pool.unlink(name);
      const liveReopenStarted = this.phaseStarted();
      try {
        await this.host.openDatabase();
      } finally {
        this.recordPhase("snapshotLiveReopen", liveReopenStarted);
      }
    }
  }

  async finalize(payload: SqliteRequestPayloads["finalizePublication"]): Promise<SqliteState> {
    const database = await this.host.openDatabase();
    const result = database.finalizePublication(
      payload.publicationId,
      payload.expectedChangeCounter,
      payload.expectedLexicalGeneration,
      payload.expectedSemanticGeneration
    );
    if (!result)
      throw sqliteError(
        "busy",
        "Publication is stale; local changes require a new publication.",
        true
      );
    return result;
  }

  async inspect(
    payload: SqliteRequestPayloads["inspectPublication"]
  ): Promise<PublicationInspection> {
    const { bytes } = payload;
    if (bytes.byteLength > SQLITE_SNAPSHOT_MAX_BYTES)
      throw sqliteError("invalid_request", "Publication exceeds the safety limit");
    const live = await this.host.openDatabase();
    this.rejectActiveLexicalRun(live);
    const expected = this.host.runtimeConfig(live);
    if (payload.corpusFingerprint && payload.corpusFingerprint !== expected.corpus)
      throw sqliteError(
        "incompatible_state",
        "Publication corpus fingerprint does not match settings"
      );
    this.host.closeConnection();
    const pool = this.pool();
    const name = `/index.sqlite3.inspect-${Date.now()}`;
    let candidate: MutableSqliteDatabase | undefined;
    try {
      const candidateImportStarted = this.phaseStarted();
      try {
        pool.importDb(name, bytes);
        candidate = this.openCandidate(name);
      } finally {
        this.recordPhase("snapshotCandidateImport", candidateImportStarted);
      }
      const validationStarted = this.phaseStarted();
      try {
        candidate.validateSnapshot(
          payload.corpusFingerprint ?? expected.corpus,
          payload.dimensions ?? expected.dimensions,
          payload.embeddingFingerprint ?? expected.embedding,
          payload.buildIdentity ?? expected.buildIdentity,
          this.validationObserver()
        );
      } finally {
        this.recordPhase("snapshotValidation", validationStarted);
      }
      const state = candidate.getState();
      if (!state.publicationId)
        throw sqliteError("incompatible_state", "Publication ID is missing");
      return { valid: true, publicationId: state.publicationId, state, byteSize: bytes.byteLength };
    } finally {
      candidate?.close();
      pool.unlink(name);
      const liveReopenStarted = this.phaseStarted();
      try {
        await this.host.openDatabase();
      } finally {
        this.recordPhase("snapshotLiveReopen", liveReopenStarted);
      }
    }
  }

  async adopt(payload: SqliteRequestPayloads["adoptPublication"]): Promise<SqliteState> {
    const live = await this.host.openDatabase();
    this.rejectActiveLexicalRun(live);
    const expected = this.host.runtimeConfig(live);
    const pool = this.pool();
    const stampName = `/index.sqlite3.adopt-${Date.now()}`;
    let stampedCandidate: MutableSqliteDatabase | undefined;
    let stampedBytes: ArrayBuffer;
    try {
      pool.importDb(stampName, payload.bytes);
      stampedCandidate = this.openCandidate(stampName);
      const candidateState = this.bootAndValidateCandidate(stampedCandidate, expected);
      if (!candidateState.publicationId)
        throw sqliteError("incompatible_state", "Publication ID is missing");
      if (
        payload.expectedPublicationId &&
        payload.expectedPublicationId !== candidateState.publicationId
      )
        throw sqliteError("incompatible_state", "Publication ID changed during adoption");
      stampedCandidate.markSnapshotLoaded();
      stampedBytes = exportOpfsDatabase(pool, stampName);
    } finally {
      stampedCandidate?.close();
      pool.unlink(stampName);
    }
    const backup = this.liveBytes();
    this.host.closeConnection();
    try {
      pool.importDb("/index.sqlite3", stampedBytes);
      const reopened = await this.host.openDatabase();
      reopened.validateSnapshot(
        expected.corpus,
        expected.dimensions,
        expected.embedding,
        expected.buildIdentity
      );
      return reopened.getState();
    } catch (error) {
      this.host.closeConnection();
      try {
        pool.importDb("/index.sqlite3", backup);
        const restored = await this.host.openDatabase();
        restored.validateSnapshot(
          expected.corpus,
          expected.dimensions,
          expected.embedding,
          expected.buildIdentity
        );
      } catch {
        /* preserve original failure */
      }
      throw error;
    }
  }

  private pool(): PublicationPool {
    const pool = this.host.storage.opfsPool;
    if (!pool) throw sqliteError("storage_unavailable", "SQLite OPFS pool is unavailable");
    return pool;
  }

  private liveBytes(): ArrayBuffer {
    return exportOpfsDatabase(this.pool(), "/index.sqlite3");
  }

  private candidateName(id: string): string {
    return `/index.sqlite3.${id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.candidate`;
  }

  private openCandidate(name: string): MutableSqliteDatabase {
    return new MutableSqliteDatabase(new (this.pool().OpfsSAHPoolDb)(name, "c"));
  }

  private phaseStarted(): number | undefined {
    return this.host.onPhase ? performance.now() : undefined;
  }

  private recordPhase(phase: PublicationPhase, started: number | undefined): void {
    if (started === undefined) return;
    try {
      this.host.onPhase?.(phase, Math.max(0, performance.now() - started));
    } catch {
      // Diagnostics cannot change publication results.
    }
  }

  private validationObserver():
    ((phase: SnapshotValidationPhase, durationMs: number) => void) | undefined {
    return this.host.onPhase
      ? (phase, durationMs) => this.host.onPhase?.(phase, durationMs)
      : undefined;
  }

  private rejectActiveLexicalRun(database: MutableSqliteDatabase): void {
    if (database.hasActiveLexicalRuns())
      throw sqliteError("busy", "A lexical run is still active", true);
  }

  private bootAndValidateCandidate(
    candidate: MutableSqliteDatabase,
    expected: WorkerRuntimeConfig
  ): SqliteState {
    candidate.validateSnapshot(
      expected.corpus,
      expected.dimensions,
      expected.embedding,
      expected.buildIdentity
    );
    // Validate the persisted identity before boot(), which otherwise rewrites
    // corpus and embedding fingerprints that differ from the runtime.
    candidate.boot(
      expected.corpus,
      expected.dimensions,
      expected.embedding,
      expected.buildIdentity
    );
    return candidate.getState();
  }
}
