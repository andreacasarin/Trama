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
  type SqliteErrorShape,
  type SqliteState,
  sqliteError,
} from "./protocol";
import { SQLITE_BUILD_IDENTITY, TRAMA_RUNTIME_BUILD_ID } from "../../build/identity";
import { applyLexicalMarkdownBatch, hashMarkdown, upsertLexicalMarkdown } from "./markdown";

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
function diagnosticToken(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/.test(value)
    ? value
    : undefined;
}

export function storageFailureDetail(error: unknown): string {
  if (!(error instanceof Error)) return "unknown failure";
  if (typeof error.message === "string")
    return error.message.replace(/[\\/][^\s]*/g, "<path>").slice(0, 160);

  const name = diagnosticToken(error.name);
  const source = error as Error & { code?: unknown; resultCode?: unknown };
  const code = diagnosticToken(source.code) ?? diagnosticToken(source.resultCode);
  const metadata = [name && `name=${name}`, code && `code=${code}`].filter(Boolean);
  return metadata.length ? metadata.join(" ") : "unknown failure";
}

export function workerFailureLocation(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;
  const frame = error.stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .find((line) => /:\d+(?::\d+)?\)?$/.test(line));
  if (!frame) return undefined;
  const match = frame.match(
    /at\s+(?:(?:async\s+)?(?<name>[A-Za-z_$][\w$]*)\s+)?\(?[^()]*?(?<file>[^\\/:()\s]+):(?<line>\d+)/
  );
  return match?.groups?.file && match.groups.line
    ? `${match.groups.name ?? "anonymous"}@${match.groups.file}:${match.groups.line}`
    : undefined;
}

function safeRequestMethod(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(value) ? value : undefined;
}

export function workerFailureReply(
  error: unknown,
  method: unknown,
  phase: "validation" | "dispatch" | "open" | "execute"
): SqliteErrorShape {
  const structured =
    error && typeof error === "object" && "error" in error
      ? { ...((error as any).error as SqliteErrorShape) }
      : {
          code: "internal" as const,
          message:
            error instanceof Error && error.message
              ? `SQLite request failed: ${error.message.slice(0, 240)}`
              : "SQLite request failed",
          retryable: false,
        };
  const requestMethod = safeRequestMethod(method);
  const location = workerFailureLocation(error);
  return {
    ...structured,
    ...(requestMethod ? { method: requestMethod } : {}),
    phase: structured.phase ?? phase,
    ...(location ? { debugLocation: location } : {}),
  };
}

function storageFailure(context: string, error: unknown): never {
  const detail = storageFailureDetail(error);
  throw sqliteError("storage_unavailable", `SQLite ${context} failed: ${detail}`, true, "open");
}

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
  let sqlite: SqliteModule;
  try {
    sqlite = await sqliteModulePromise;
  } catch (error) {
    if (error && typeof error === "object" && "error" in error) {
      const detail = (error as any).error;
      throw sqliteError(detail.code, detail.message, detail.retryable, "open");
    }
    throw error;
  }
  const namespace = identity.replace(/[^0-9a-f]/gi, "").slice(0, 32) || "default";
  try {
    storage.opfsPool ??= await sqlite.installOpfsSAHPoolVfs({
      name: `trama-sqlite-v1-${namespace}`,
      directory: `trama-sqlite-v1-${namespace}`,
      initialCapacity: 8,
    });
  } catch (error) {
    storageFailure("OPFS VFS installation", error);
  }
  try {
    storage.connection = new storage.opfsPool!.OpfsSAHPoolDb("/index.sqlite3", "c");
  } catch (error) {
    storageFailure("database open", error);
  }
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
      // Local databases are disposable when their persisted format or vector
      // dimensions no longer match this build. Publication candidates are
      // validated separately and remain reject-only/non-destructive.
      if ((error as any)?.error?.code === "incompatible_state") {
        const replacement = resetIncompatibleLocalDatabase(bootConfig);
        return replacement;
      }
      closeConnection();
      if (error && typeof error === "object" && "error" in error) throw error;
      storageFailure("database boot", error);
    }
  }
  return storage.database;
}
function closeConnection(): void {
  closeWorkerDatabase(storage);
}
function resetIncompatibleLocalDatabase(config: {
  corpusFingerprint: string;
  embeddingFingerprint: string;
  buildIdentity: string;
  dimensions: number;
}): MutableSqliteDatabase {
  try {
    closeConnection();
    if (!storage.opfsPool) throw new Error("OPFS pool is unavailable");
    storage.opfsPool.unlink("/index.sqlite3");
    storage.connection = new storage.opfsPool.OpfsSAHPoolDb("/index.sqlite3", "c");
    storage.database = new MutableSqliteDatabase(storage.connection);
    storage.database.boot(
      config.corpusFingerprint,
      config.dimensions,
      config.embeddingFingerprint,
      config.buildIdentity
    );
    return storage.database;
  } catch (error) {
    if (error && typeof error === "object" && "error" in error) throw error;
    storageFailure("incompatible database reset", error);
  }
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
  buildIdentity: string;
} {
  const s = db.getState();
  return {
    corpus: s.corpusFingerprint,
    embedding: s.embeddingFingerprint,
    dimensions: s.dimensions,
    buildIdentity: s.buildIdentity,
  };
}

function runtimeConfig(db: MutableSqliteDatabase): {
  corpus: string;
  embedding: string;
  dimensions: number;
  buildIdentity: string;
} {
  const persisted = config(db);
  return bootConfig
    ? {
        corpus: bootConfig.corpusFingerprint,
        embedding: bootConfig.embeddingFingerprint,
        dimensions: bootConfig.dimensions,
        buildIdentity: bootConfig.buildIdentity,
      }
    : persisted;
}

function rejectActiveLexicalRun(db: MutableSqliteDatabase): void {
  if (db.hasActiveLexicalRuns()) throw sqliteError("busy", "A lexical run is still active", true);
}

function bootAndValidateCandidate(
  candidate: MutableSqliteDatabase,
  expected: ReturnType<typeof runtimeConfig>
): SqliteState {
  candidate.validateSnapshot(
    expected.corpus,
    expected.dimensions,
    expected.embedding,
    expected.buildIdentity
  );
  // validateSnapshot proves the persisted identity before boot(), which otherwise
  // rewrites corpus and embedding fingerprints that differ from the runtime.
  candidate.boot(expected.corpus, expected.dimensions, expected.embedding, expected.buildIdentity);
  return candidate.getState();
}

async function preparePublication(publicationId: string): Promise<unknown> {
  const db = await openDatabase();
  rejectActiveLexicalRun(db);
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
    candidate.pruneForPublication();
    candidate.setPublicationId(publicationId);
    candidate.validateSnapshot(
      state.corpusFingerprint,
      state.dimensions,
      state.embeddingFingerprint
    );
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
  rejectActiveLexicalRun(live);
  const expected = runtimeConfig(live);
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
      payload.embeddingFingerprint ?? expected.embedding,
      payload.buildIdentity ?? expected.buildIdentity
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
  rejectActiveLexicalRun(live);
  const expected = runtimeConfig(live);
  if (!storage.opfsPool)
    throw sqliteError("storage_unavailable", "SQLite OPFS pool is unavailable");
  const stampName = `/index.sqlite3.adopt-${Date.now()}`;
  let stampedCandidate: MutableSqliteDatabase | undefined;
  let stampedBytes: ArrayBuffer;
  try {
    storage.opfsPool.importDb(stampName, bytes);
    stampedCandidate = openCandidate(stampName);
    const candidateState = bootAndValidateCandidate(stampedCandidate, expected);
    if (!candidateState.publicationId)
      throw sqliteError("incompatible_state", "Publication ID is missing");
    if (
      payload.expectedPublicationId &&
      payload.expectedPublicationId !== candidateState.publicationId
    )
      throw sqliteError("incompatible_state", "Publication ID changed during adoption");
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
    reopened.validateSnapshot(
      expected.corpus,
      expected.dimensions,
      expected.embedding,
      expected.buildIdentity
    );
    return reopened.getState();
  } catch (error) {
    closeConnection();
    try {
      storage.opfsPool.importDb("/index.sqlite3", backup);
      const restored = await openDatabase();
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
async function handle(request: SqliteRequest, signal: AbortSignal): Promise<unknown> {
  const p: any = request.payload;
  if (request.method === "boot") {
    const config = {
      corpusFingerprint: p.corpusFingerprint as string,
      dimensions: p.dimensions as number,
      embeddingFingerprint: (p.embeddingFingerprint ?? "") as string,
      buildIdentity: (p.buildIdentity ?? SQLITE_BUILD_IDENTITY) as string,
    };
    bootConfig = config;
    try {
      return (await openDatabase(p.identity ?? "default")).boot(
        config.corpusFingerprint,
        config.dimensions,
        config.embeddingFingerprint,
        config.buildIdentity
      );
    } catch (error) {
      if ((error as any)?.error?.code !== "incompatible_state") throw error;
      const replacement = resetIncompatibleLocalDatabase(config);
      return replacement.getState();
    }
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
      const result = db.finalizePublication(
        p.publicationId,
        p.expectedChangeCounter,
        p.expectedLexicalGeneration,
        p.expectedSemanticGeneration
      );
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
  if (request.method === "hashMarkdown")
    return hashMarkdown(p.markdown, p.corpusFingerprint, signal);
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
    case "upsertLexicalRevision":
      return upsertLexicalMarkdown(
        db,
        p.path,
        p.markdown,
        p.expectedRevisionDigest,
        p.size,
        signal
      );
    case "beginLexicalRun":
      return db.beginLexicalRun({
        runId: p.runId,
        summaries: p.summaries ?? p.manifest,
        expectedChangeCounter: p.expectedChangeCounter,
        scope: p.scope,
      });
    case "applyLexicalBatch":
      return applyLexicalMarkdownBatch(db, p.runId, p.notes ?? p.markdown ?? [], signal);
    case "finishLexicalRun":
      return db.finishLexicalRun(p.runId);
    case "abortLexicalRun":
      return db.abortLexicalRun(p.runId);
    case "listLexicalSummaries":
      return db.listLexicalSummaries();
    case "prepareSemanticWork":
      return db.prepareSemanticWork(
        p.embeddingFingerprint,
        p.preprocessing,
        p.limit,
        p.maxInputBytes,
        p.promoteUnrestricted
      );
    case "commitSemanticResults":
      return db.commitSemanticResults(p.results, p.embeddingFingerprint, p.preprocessing);
    case "listMissingEmbeddingInputs":
      return db.listMissingEmbeddingInputs(p.embeddingFingerprint, p.preprocessing, p.limit);
    case "storeEmbeddingResults":
      return db.storeEmbeddingResults(p.results, p.embeddingFingerprint, p.preprocessing);
    case "promoteSemanticHeads":
      return db.promoteSemanticHeads(p.embeddingFingerprint, p.preprocessing);
    case "clearSemanticCache":
      return db.clearSemanticCache();
    case "renameLexicalNote":
      return db.renameLexicalNote(p.from, p.to);
    case "deleteLexicalNote":
      return db.deleteLexicalNote(p.path);
    case "finishReconciliation":
      return db.finishReconciliation(p.summaries, p.observedChangeCounter);
    case "finishScopedReconciliation":
      return db.finishScopedReconciliation(p.observedChangeCounter, p.mayClearIncomplete);
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
  if (data?.type === "trama-runtime-handshake") {
    post({ type: "trama-runtime-handshake", id: data.id, buildId: TRAMA_RUNTIME_BUILD_ID } as any);
    return;
  }
  let request: SqliteRequest;
  try {
    validateRequest(data);
    request = data;
  } catch (error) {
    const safe =
      error instanceof Error && "error" in error
        ? workerFailureReply(error, data?.method, "validation")
        : workerFailureReply(
            sqliteError("invalid_request", "Invalid request"),
            data?.method,
            "validation"
          );
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
        const safe = workerFailureReply(error, request.method, "execute");
        post({ v: SQLITE_PROTOCOL_VERSION, id: request.id, ok: false, error: safe });
      }
    );
};
