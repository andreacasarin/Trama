import { MutableSqliteDatabase, type SqliteConnection } from "./database";
import { SqliteScheduler } from "./scheduler";
import {
  closeWorkerDatabase,
  exportOpfsDatabase,
  type WorkerStorageState,
} from "./worker-lifecycle";
import {
  SQLITE_PROTOCOL_VERSION,
  SQLITE_SNAPSHOT_MAX_BYTES,
  validateRequest,
  type SqliteRequest,
  type SqliteReply,
  sqliteError,
} from "./protocol";
import { SQLITE_BUILD_IDENTITY } from "../../build/identity";
import { hashMarkdown, upsertMarkdown } from "./markdown";

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
type SqliteInitModule = (options: {
  readonly instantiateWasm: (
    imports: WebAssembly.Imports,
    onSuccess: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
  ) => object;
}) => Promise<SqliteModule>;
type OpfsPool = Awaited<ReturnType<SqliteModule["installOpfsSAHPoolVfs"]>>;
const storage: WorkerStorageState<MutableSqliteDatabase, SqliteConnection, OpfsPool> = {};
const scheduler = new SqliteScheduler();
let sqliteModulePromise: Promise<SqliteModule> | undefined;
let databaseIdentity = "default";
let maintenance = false;
let bootConfig:
  | {
      corpusFingerprint: string;
      embeddingFingerprint: string;
      buildIdentity: string;
      dimensions: number;
    }
  | undefined;

async function initializeSqlite(): Promise<SqliteModule> {
  const assets = (
    globalThis as typeof globalThis & {
      __TRAMA_SQLITE_ASSETS__?: { readonly moduleUrl?: string; readonly wasmUrl?: string };
    }
  ).__TRAMA_SQLITE_ASSETS__;
  const wasmUrl = assets?.wasmUrl ?? new URL("./sqlite3.wasm", import.meta.url).href;
  const moduleUrl = assets?.moduleUrl ?? new URL("./sqlite3.mjs", import.meta.url).href;
  let response: Response;
  try {
    response = await fetch(wasmUrl, { credentials: "same-origin" });
  } catch {
    throw sqliteError("storage_unavailable", "SQLite WASM asset could not be loaded.", true);
  }
  if (!response.ok)
    throw sqliteError("storage_unavailable", "SQLite WASM asset could not be loaded.", true);
  let wasm: ArrayBuffer;
  try {
    wasm = await response.arrayBuffer();
  } catch {
    throw sqliteError("storage_unavailable", "SQLite WASM asset could not be loaded.", true);
  }
  let init: SqliteInitModule;
  try {
    (globalThis as any).sqlite3ApiConfig = {
      disable: { vfs: { kvvfs: true, opfs: true, "opfs-wl": true } },
    };
    init = (await import(moduleUrl)).default as SqliteInitModule;
  } catch {
    throw sqliteError("storage_unavailable", "SQLite module asset could not be loaded.", true);
  }
  try {
    return await init({
      instantiateWasm(imports, onSuccess) {
        WebAssembly.instantiate(wasm, imports).then(({ instance, module }) =>
          onSuccess(instance, module)
        );
        return {};
      },
    });
  } catch {
    throw sqliteError("storage_unavailable", "SQLite WASM failed to initialize.", true);
  }
}
async function openDatabase(identity = databaseIdentity): Promise<MutableSqliteDatabase> {
  if (storage.database) return storage.database;
  databaseIdentity = identity;
  if (!sqliteModulePromise) sqliteModulePromise = initializeSqlite();
  const sqlite = await sqliteModulePromise;
  const namespace = identity.replace(/[^0-9a-f]/gi, "").slice(0, 32) || "default";
  storage.opfsPool ??= await sqlite.installOpfsSAHPoolVfs({
    name: `trama-sqlite-v1-${namespace}`,
    directory: `trama-sqlite-v1-${namespace}`,
    initialCapacity: 8,
  });
  storage.connection = new storage.opfsPool.OpfsSAHPoolDb("/index.sqlite3", "c");
  storage.database = new MutableSqliteDatabase(storage.connection);
  if (bootConfig) {
    try {
      storage.database.boot(
        bootConfig.corpusFingerprint,
        bootConfig.dimensions,
        bootConfig.embeddingFingerprint,
        bootConfig.buildIdentity
      );
    } catch (error) {
      closeConnection();
      throw error;
    }
  }
  return storage.database;
}
function closeConnection(): void {
  closeWorkerDatabase(storage);
}
function liveBytes(): ArrayBuffer {
  if (!storage.opfsPool)
    throw sqliteError("storage_unavailable", "SQLite OPFS pool is unavailable");
  return exportOpfsDatabase(storage.opfsPool, "/index.sqlite3");
}
function candidateName(id: string): string {
  return `/index.sqlite3.${id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.candidate`;
}
function openCandidate(name: string): MutableSqliteDatabase {
  if (!storage.opfsPool)
    throw sqliteError("storage_unavailable", "SQLite OPFS pool is unavailable");
  return new MutableSqliteDatabase(new storage.opfsPool.OpfsSAHPoolDb(name, "c"));
}
function config(db: MutableSqliteDatabase): {
  corpus: string;
  embedding: string;
  dimensions: number;
} {
  const s = db.getState();
  return {
    corpus: s.corpusFingerprint,
    embedding: s.embeddingFingerprint,
    dimensions: s.dimensions,
  };
}

async function preparePublication(publicationId: string): Promise<unknown> {
  const db = await openDatabase();
  const state = db.getState();
  db.validateSnapshot(state.corpusFingerprint, state.dimensions, state.embeddingFingerprint);
  const started = Date.now();
  const original = liveBytes();
  closeConnection();
  if (!storage.opfsPool)
    throw sqliteError("storage_unavailable", "SQLite OPFS pool is unavailable");
  const name = candidateName(publicationId);
  let candidate: MutableSqliteDatabase | undefined;
  try {
    storage.opfsPool.importDb(name, original);
    candidate = openCandidate(name);
    candidate.validateSnapshot(
      state.corpusFingerprint,
      state.dimensions,
      state.embeddingFingerprint
    );
    candidate.setPublicationId(publicationId);
    const bytes = exportOpfsDatabase(storage.opfsPool, name);
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
    storage.opfsPool.unlink(name);
    await openDatabase();
  }
}
async function inspectPublication(bytes: ArrayBuffer, payload: any): Promise<unknown> {
  if (bytes.byteLength > SQLITE_SNAPSHOT_MAX_BYTES)
    throw sqliteError("invalid_request", "Publication exceeds the safety limit");
  const live = await openDatabase();
  const expected = config(live);
  if (payload.corpusFingerprint && payload.corpusFingerprint !== expected.corpus)
    throw sqliteError(
      "incompatible_state",
      "Publication corpus fingerprint does not match settings"
    );
  closeConnection();
  if (!storage.opfsPool)
    throw sqliteError("storage_unavailable", "SQLite OPFS pool is unavailable");
  const name = `/index.sqlite3.inspect-${Date.now()}`;
  let candidate: MutableSqliteDatabase | undefined;
  try {
    storage.opfsPool.importDb(name, bytes);
    candidate = openCandidate(name);
    candidate.validateSnapshot(
      payload.corpusFingerprint ?? expected.corpus,
      payload.dimensions ?? expected.dimensions,
      payload.embeddingFingerprint ?? expected.embedding
    );
    const state = candidate.getState();
    if (!state.publicationId) throw sqliteError("incompatible_state", "Publication ID is missing");
    return { valid: true, publicationId: state.publicationId, state, byteSize: bytes.byteLength };
  } finally {
    candidate?.close();
    storage.opfsPool.unlink(name);
    await openDatabase();
  }
}
async function adoptPublication(bytes: ArrayBuffer, payload: any): Promise<unknown> {
  const live = await openDatabase();
  const expected = config(live);
  const inspection = await inspectPublication(bytes, {
    ...payload,
    corpusFingerprint: payload.corpusFingerprint ?? expected.corpus,
    embeddingFingerprint: payload.embeddingFingerprint ?? expected.embedding,
    dimensions: payload.dimensions ?? expected.dimensions,
  });
  const info = inspection as any;
  if (payload.expectedPublicationId && payload.expectedPublicationId !== info.publicationId)
    throw sqliteError("incompatible_state", "Publication ID changed during adoption");
  if (!storage.opfsPool)
    throw sqliteError("storage_unavailable", "SQLite OPFS pool is unavailable");
  const stampName = `/index.sqlite3.adopt-${Date.now()}`;
  let stampedCandidate: MutableSqliteDatabase | undefined;
  let stampedBytes: ArrayBuffer;
  try {
    storage.opfsPool.importDb(stampName, bytes);
    stampedCandidate = openCandidate(stampName);
    stampedCandidate.validateSnapshot(expected.corpus, expected.dimensions, expected.embedding);
    stampedCandidate.markSnapshotLoaded();
    stampedBytes = exportOpfsDatabase(storage.opfsPool, stampName);
  } finally {
    stampedCandidate?.close();
    storage.opfsPool.unlink(stampName);
  }
  const backup = liveBytes();
  closeConnection();
  if (!storage.opfsPool)
    throw sqliteError("storage_unavailable", "SQLite OPFS pool is unavailable");
  try {
    storage.opfsPool.importDb("/index.sqlite3", stampedBytes);
    const reopened = await openDatabase();
    reopened.validateSnapshot(expected.corpus, expected.dimensions, expected.embedding);
    return reopened.getState();
  } catch (error) {
    closeConnection();
    try {
      storage.opfsPool.importDb("/index.sqlite3", backup);
      const restored = await openDatabase();
      restored.validateSnapshot(expected.corpus, expected.dimensions, expected.embedding);
    } catch {
      /* preserve original failure */
    }
    throw error;
  }
}
async function handle(request: SqliteRequest, signal: AbortSignal): Promise<unknown> {
  const p: any = request.payload;
  if (request.method === "boot") {
    const config = {
      corpusFingerprint: p.corpusFingerprint as string,
      dimensions: p.dimensions as number,
      embeddingFingerprint: (p.embeddingFingerprint ?? "") as string,
      buildIdentity: (p.buildIdentity ?? SQLITE_BUILD_IDENTITY) as string,
    };
    const state = (await openDatabase(p.identity ?? "default")).boot(
      config.corpusFingerprint,
      config.dimensions,
      config.embeddingFingerprint,
      config.buildIdentity
    );
    bootConfig = config;
    return state;
  }
  if (request.method === "shutdown") {
    scheduler.shutdown();
    closeConnection();
    bootConfig = undefined;
    return { closed: true };
  }
  if (
    [
      "preparePublication",
      "finalizePublication",
      "inspectPublication",
      "adoptPublication",
    ].includes(request.method)
  ) {
    if (request.method === "preparePublication") return preparePublication(p.publicationId);
    const db = await openDatabase();
    if (request.method === "finalizePublication") {
      const result = db.finalizePublication(p.publicationId, p.expectedChangeCounter);
      if (!result)
        throw sqliteError(
          "busy",
          "Publication is stale; local changes require a new publication.",
          true
        );
      return result;
    }
    if (request.method === "inspectPublication") return inspectPublication(p.bytes, p);
    if (request.method === "adoptPublication") return adoptPublication(p.bytes, p);
    throw sqliteError("unsupported", "Unknown maintenance method");
  }
  const db = await openDatabase();
  switch (request.method) {
    case "getState":
      return db.getState();
    case "planReconciliation":
      return db.planReconciliation(p.summaries);
    case "markIncomplete":
      return db.markIncomplete();
    case "beginRebuild":
      return db.beginRebuild();
    case "clearVectors":
      return db.clearVectors();
    case "hashMarkdown":
      return hashMarkdown(p.markdown, p.corpusFingerprint, signal);
    case "upsertMarkdown":
      return upsertMarkdown(db, p.path, p.markdown, p.expectedContentId, p.size, p.overlap, signal);
    case "renameNote":
      return db.renameNote(p.from, p.to, p.contentId);
    case "deleteNote":
      return db.deleteNote(p.path, p.contentId);
    case "finishReconciliation":
      return db.finishReconciliation(p.summaries, p.observedChangeCounter);
    case "listMissingVectors":
      return db.listMissingVectors(p.embeddingFingerprint, p.limit, p.afterChunkPk);
    case "storeVectors":
      return db.storeVectors(p.vectors, p.embeddingFingerprint, p.observedChangeCounter);
    case "retrieve":
      return db.retrieve(p.query, p.vector, p.limit, p.currentPath, p);
    case "findRelated":
      return db.findRelated(p.path, p.vector, p.limit);
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
        ? (error as any).error
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
  const isMaintenance = [
    "preparePublication",
    "finalizePublication",
    "inspectPublication",
    "adoptPublication",
  ].includes(request.method);
  if (isMaintenance) maintenance = true;
  void scheduler
    .enqueue(request.id, (signal) => handle(request, signal))
    .then(
      (result) => {
        if (isMaintenance) maintenance = false;
        post(
          { v: SQLITE_PROTOCOL_VERSION, id: request.id, ok: true, result },
          result instanceof ArrayBuffer
            ? [result]
            : result && (result as any).bytes instanceof ArrayBuffer
              ? [(result as any).bytes]
              : []
        );
      },
      (error) => {
        if (isMaintenance) maintenance = false;
        const safe =
          error && typeof error === "object" && "error" in error
            ? (error as any).error
            : { code: "internal", message: "SQLite request failed", retryable: false };
        post({ v: SQLITE_PROTOCOL_VERSION, id: request.id, ok: false, error: safe });
      }
    );
};
