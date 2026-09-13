import { MutableSqliteDatabase, type SqliteConnection } from "./database";
import { SqliteScheduler } from "./scheduler";
import {
  closeWorkerDatabase,
  exportOpfsDatabase,
  type OpfsSAHPoolUtilLike,
  type WorkerStorageState,
} from "./worker-lifecycle";
import {
  SQLITE_PROTOCOL_VERSION,
  validateRequest,
  type SqliteRequest,
  type SqliteReply,
  type SqliteState,
  sqliteError,
} from "./protocol";

type SqliteModule = {
  oo1: { DB: new (name: string, mode: string) => SqliteConnection };
  installOpfsSAHPoolVfs: (options: {
    name: string;
    directory: string;
    initialCapacity: number;
  }) => Promise<{
    OpfsSAHPoolDb: new (name: string, mode: string) => SqliteConnection;
    exportFile: (name: string) => Uint8Array | ArrayBuffer;
    importDb: (name: string, bytes: Uint8Array | ArrayBuffer) => number;
    unlink: (name: string) => boolean;
  }>;
};

type SqliteInitModule = (options: { readonly wasmBinary: ArrayBuffer }) => Promise<SqliteModule>;

type OpfsPool = Awaited<ReturnType<SqliteModule["installOpfsSAHPoolVfs"]>>;
const storage: WorkerStorageState<MutableSqliteDatabase, SqliteConnection, OpfsPool> = {};
const scheduler = new SqliteScheduler();
let sqliteModulePromise: Promise<SqliteModule> | undefined;
let databaseIdentity = "default";
let maintenance = false;

async function openDatabase(identity = "default"): Promise<MutableSqliteDatabase> {
  if (storage.database) return storage.database;
  if (storage.opfsPool && databaseIdentity === identity) {
    storage.connection = new storage.opfsPool.OpfsSAHPoolDb("/index.sqlite3", "c");
    storage.database = new MutableSqliteDatabase(storage.connection);
    return storage.database;
  }
  databaseIdentity = identity;
  if (!sqliteModulePromise) sqliteModulePromise = initializeSqlite();
  const sqliteModule = await sqliteModulePromise;
  const namespace = identity.replace(/[^0-9a-f]/gi, "").slice(0, 32) || "default";
  storage.opfsPool = await sqliteModule.installOpfsSAHPoolVfs({
    name: `trama-sqlite-v1-${namespace}`,
    directory: `trama-sqlite-v1-${namespace}`,
    initialCapacity: 8,
  });
  storage.connection = new storage.opfsPool.OpfsSAHPoolDb("/index.sqlite3", "c");
  storage.database = new MutableSqliteDatabase(storage.connection);
  return storage.database;
}

async function initializeSqlite(): Promise<SqliteModule> {
  // Keep initialization local and deterministic: the production Worker loads
  // only the colocated audited module and its colocated WASM binary.
  const configuredAssets = (
    globalThis as typeof globalThis & {
      __TRAMA_SQLITE_ASSETS__?: { readonly moduleUrl?: string; readonly wasmUrl?: string };
    }
  ).__TRAMA_SQLITE_ASSETS__;
  const wasmUrl = configuredAssets?.wasmUrl ?? new URL("./sqlite3.wasm", import.meta.url).href;
  const moduleUrl = configuredAssets?.moduleUrl ?? new URL("./sqlite3.mjs", import.meta.url).href;
  let response: Response;
  try {
    response = await fetch(wasmUrl, {
      credentials: "same-origin",
    });
  } catch {
    throw sqliteError("storage_unavailable", "SQLite WASM asset could not be loaded.", true);
  }
  if (!response.ok)
    throw sqliteError("storage_unavailable", "SQLite WASM asset could not be loaded.", true);
  let wasmBinary: ArrayBuffer;
  try {
    wasmBinary = await response.arrayBuffer();
  } catch {
    throw sqliteError("storage_unavailable", "SQLite WASM asset could not be loaded.", true);
  }
  let module: SqliteInitModule;
  try {
    module = (await import(moduleUrl)).default as SqliteInitModule;
  } catch {
    throw sqliteError("storage_unavailable", "SQLite module asset could not be loaded.", true);
  }
  try {
    return await module({ wasmBinary });
  } catch {
    throw sqliteError("storage_unavailable", "SQLite WASM failed to initialize.", true);
  }
}

async function closeDatabase(): Promise<void> {
  closeWorkerDatabase(storage);
}

function closeConnection(): void {
  closeWorkerDatabase(storage);
}

function snapshotBytes(): ArrayBuffer {
  if (!storage.opfsPool)
    throw sqliteError("storage_unavailable", "SQLite OPFS pool is unavailable");
  return exportOpfsDatabase(storage.opfsPool as OpfsSAHPoolUtilLike, "/index.sqlite3");
}

async function exportForMaintenance(): Promise<ArrayBuffer> {
  const db = await openDatabase(databaseIdentity);
  // The scheduler has already drained all preceding writes at this point.
  db.validateSnapshot(db.getState().fingerprint, db.getState().dimensions);
  closeConnection();
  const bytes = snapshotBytes();
  await closeDatabase();
  const reopened = await openDatabase(databaseIdentity);
  reopened.validateSnapshot(reopened.getState().fingerprint, reopened.getState().dimensions);
  return bytes;
}

async function importForMaintenance(bytes: ArrayBuffer): Promise<SqliteState> {
  const live = await openDatabase(databaseIdentity);
  const priorState = live.getState();
  const fingerprint = priorState.fingerprint;
  const dimensions = priorState.dimensions;
  const liveBytes = (() => {
    closeConnection();
    return snapshotBytes();
  })();
  if (!storage.opfsPool)
    throw sqliteError("storage_unavailable", "SQLite OPFS pool is unavailable");
  const candidateName = "/index.sqlite3.import-check";
  let candidate: MutableSqliteDatabase | undefined;
  try {
    storage.opfsPool.importDb(candidateName, bytes);
    const candidateConnection = new storage.opfsPool.OpfsSAHPoolDb(candidateName, "c");
    candidate = new MutableSqliteDatabase(candidateConnection);
    candidate.validateSnapshot(fingerprint, dimensions);
  } finally {
    try {
      candidate?.close();
    } finally {
      storage.opfsPool.unlink(candidateName);
    }
  }

  // Replacement starts only after the temporary database has passed every check.
  try {
    storage.opfsPool.importDb("/index.sqlite3", bytes);
    const replaced = await openDatabase(databaseIdentity);
    const imported = replaced;
    imported.validateSnapshot(fingerprint, dimensions);
    storage.database = imported;
    return imported.markImported(priorState.changeCounter);
  } catch (error) {
    // Restore only the in-memory operation backup when replacement/reopen fails;
    // no snapshot or pointer is created and startup never scans for recovery data.
    closeConnection();
    try {
      if (!storage.opfsPool)
        throw sqliteError("storage_unavailable", "SQLite OPFS pool is unavailable");
      storage.opfsPool.importDb("/index.sqlite3", liveBytes);
      const restored = await openDatabase(databaseIdentity);
      const restoredDb = restored;
      restoredDb.validateSnapshot(fingerprint, dimensions);
      storage.database = restoredDb;
    } catch {
      // Preserve the original safe failure code.
    }
    throw error;
  }
}

async function handle(request: SqliteRequest): Promise<unknown> {
  const payload = request.payload as any;
  if (request.method === "boot")
    return (await openDatabase(payload.identity)).boot(payload.fingerprint, payload.dimensions);
  if (request.method === "shutdown") {
    scheduler.shutdown();
    await closeDatabase();
    return { closed: true };
  }
  const db = await openDatabase();
  switch (request.method) {
    case "getState":
      return db.getState();
    case "listNotes":
      return db.listNotes();
    case "markIncomplete":
      return db.markIncomplete();
    case "beginRebuild":
      return db.beginRebuild();
    case "upsertNote":
      return db.upsertNote(payload.note);
    case "renameNote":
      return db.renameNote(payload.from, payload.to, payload.contentId);
    case "deleteNote":
      return db.deleteNote(payload.path, payload.contentId);
    case "finishReconciliation":
      return db.finishReconciliation(payload.summaries, payload.observedChangeCounter);
    case "retrieve":
      return db.retrieve(payload.query, payload.vector, payload.limit, payload.currentPath, {
        semanticCandidateLimit: payload.semanticCandidateLimit,
        lexicalCandidateLimit: payload.lexicalCandidateLimit,
        lexicalProfile: payload.lexicalProfile,
        resultShape: payload.resultShape,
      });
    case "findRelated":
      return db.findRelated(payload.path, payload.vector, payload.limit);
    case "export":
      return exportForMaintenance();
    case "import":
      return importForMaintenance(payload.bytes);
    default:
      throw sqliteError("invalid_request", "Unsupported SQLite method");
  }
}

function post(reply: SqliteReply, transfer: ArrayBuffer[] = []): void {
  (
    self as unknown as { postMessage: (value: unknown, transfer?: ArrayBuffer[]) => void }
  ).postMessage(reply, transfer);
}

(self as unknown as { onmessage: (event: MessageEvent) => void }).onmessage = ({
  data,
}: MessageEvent) => {
  let request: SqliteRequest;
  try {
    validateRequest(data);
    request = data;
  } catch (error) {
    const safe =
      error instanceof Error && "error" in error
        ? (error as { error: any }).error
        : { code: "invalid_request", message: "Invalid request", retryable: false };
    post({ v: SQLITE_PROTOCOL_VERSION, id: Number(data?.id) || 0, ok: false, error: safe });
    return;
  }
  if (request.method === "cancelQueued") {
    post({
      v: SQLITE_PROTOCOL_VERSION,
      id: request.id,
      ok: true,
      result: { cancelled: scheduler.cancelQueued((request.payload as any).requestId) },
    });
    return;
  }
  if (maintenance) {
    post({
      v: SQLITE_PROTOCOL_VERSION,
      id: request.id,
      ok: false,
      error: sqliteError("busy", "SQLite maintenance is in progress", true).error,
    });
    return;
  }
  const isMaintenance = request.method === "export" || request.method === "import";
  if (isMaintenance) maintenance = true;
  void scheduler
    .enqueue(request.id, () => handle(request))
    .then(
      (result) => {
        if (isMaintenance) maintenance = false;
        post(
          { v: SQLITE_PROTOCOL_VERSION, id: request.id, ok: true, result },
          result instanceof ArrayBuffer ? [result] : []
        );
      },
      (error) => {
        if (isMaintenance) maintenance = false;
        const safe =
          error && typeof error === "object" && "error" in error
            ? (error as { error: any }).error
            : { code: "internal", message: "SQLite request failed", retryable: false };
        post({ v: SQLITE_PROTOCOL_VERSION, id: request.id, ok: false, error: safe });
      }
    );
};
