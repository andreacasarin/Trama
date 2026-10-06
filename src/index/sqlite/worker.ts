import { MutableSqliteDatabase, type SqliteConnection } from "./database";
import { SqliteScheduler } from "./scheduler";
import {
  closeWorkerDatabase,
  resetWorkerDatabase,
  type WorkerStorageState,
} from "./worker-lifecycle";
import {
  SQLITE_PROTOCOL_VERSION,
  SQLITE_DIAGNOSTICS_CONFIG_TYPE,
  SQLITE_DIAGNOSTIC_EVENT_TYPE,
  type SqliteDiagnosticsConfiguration,
  type SqliteDiagnosticEventMessage,
  type SqliteRequest,
  type SqliteReply,
  type SqliteErrorShape,
  sqliteError,
} from "./protocol";
import { SQLITE_BUILD_IDENTITY, TRAMA_RUNTIME_BUILD_ID } from "../../build/identity";
import { applyLexicalMarkdownBatch, type LexicalMarkdownPhase } from "./markdown";
import { validateRequest } from "./request-validation";
import { WorkerPublicationOperations } from "./worker-publication";
import { sha256Hex } from "@/index/Identity";
import type { TramaDiagnostics, TramaPerformanceRecord } from "@/diagnostics/TramaDiagnostics";

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
const legacyCacheCandidates = new Map<
  string,
  { readonly name: string; readonly database: MutableSqliteDatabase }
>();
const scheduler = new SqliteScheduler();
let sqliteModulePromise: Promise<SqliteModule> | undefined;
let databaseIdentity = "default";
let maintenance = false;
let diagnosticsEnabled = false;
let diagnosticSessionId = "none";
let diagnosticRequestId: number | undefined;
let diagnosticOperationId: string | undefined;
let diagnosticParentOperationId: string | undefined;
let diagnosticBatchId: string | undefined;
let diagnosticMethod: SqliteRequest["method"] | undefined;
let semanticPhases: Map<string, TramaPerformanceRecord> | undefined;
const MAX_SEMANTIC_PHASES_PER_REQUEST = 32;
function emitPerformance(record: Omit<TramaPerformanceRecord, "context">): void {
  if (!diagnosticsEnabled) return;
  try {
    (self as unknown as { postMessage(value: unknown): void }).postMessage({
      type: SQLITE_DIAGNOSTIC_EVENT_TYPE,
      record: {
        ...record,
        context: {
          sessionId: diagnosticSessionId,
          requestId: diagnosticRequestId,
          operationId: diagnosticOperationId,
          parentOperationId: diagnosticParentOperationId,
          batchId: diagnosticBatchId,
        },
      },
    } satisfies SqliteDiagnosticEventMessage);
  } catch {
    // Diagnostic transport cannot change the RPC result.
  }
}
const workerDiagnostics: TramaDiagnostics = {
  enabled: (tier) => tier === "performance" && diagnosticsEnabled,
  emit(record) {
    if ("tier" in record && record.tier === "performance") observeSemanticPhase(record);
  },
};
function observeSemanticPhase(phase: TramaPerformanceRecord): void {
  if (!semanticPhases) return;
  aggregateSemanticPhase(semanticPhases, phase);
}
/** Coalesces repeated bounded semantic spans before crossing the Worker boundary. */
export function aggregateSemanticPhase(
  phases: Map<string, TramaPerformanceRecord>,
  phase: TramaPerformanceRecord
): void {
  const key = `${phase.semanticStep}:${phase.phase}:${phase.nested}`;
  const prior = phases.get(key);
  if (!prior && phases.size >= MAX_SEMANTIC_PHASES_PER_REQUEST) return;
  phases.set(
    key,
    prior
      ? {
          ...prior,
          durationMs: prior.durationMs + phase.durationMs,
          sqlMs: (prior.sqlMs ?? 0) + (phase.sqlMs ?? 0),
          sqlCalls: (prior.sqlCalls ?? 0) + (phase.sqlCalls ?? 0),
          callbackRows: (prior.callbackRows ?? 0) + (phase.callbackRows ?? 0),
          copiedBytes: (prior.copiedBytes ?? 0) + (phase.copiedBytes ?? 0),
        }
      : phase
  );
}
function observeRetrievalPhase(
  phase:
    | "semanticCandidates"
    | "lexicalCandidates"
    | "fusion"
    | "centroid"
    | "relatedCandidates"
    | "relatedRerank",
  durationMs: number,
  itemCount: number
): void {
  emitPerformance(retrievalPhaseRecord(diagnosticMethod, phase, durationMs, itemCount));
}
function observeLexicalMarkdownPhase(phase: LexicalMarkdownPhase, durationMs: number): void {
  emitPerformance({
    tier: "performance",
    facets: ["index", "lexical", "worker"],
    area: "index",
    event: "phase",
    operation: "lexical",
    phase,
    durationMs,
    nested: true,
  });
}
export function retrievalPhaseRecord(
  method: SqliteRequest["method"] | undefined,
  phase:
    | "semanticCandidates"
    | "lexicalCandidates"
    | "fusion"
    | "centroid"
    | "relatedCandidates"
    | "relatedRerank",
  durationMs: number,
  itemCount: number
): Omit<TramaPerformanceRecord, "context"> {
  const related = method === "findRelated";
  return {
    tier: "performance",
    facets: ["index", related ? "related" : "retrieve", "worker"],
    area: related ? "filo" : "index",
    event: "phase",
    operation: related ? "related" : "retrieve",
    phase,
    durationMs,
    itemCount,
  };
}
function flushSemanticPhases(): void {
  const phases = semanticPhases;
  semanticPhases = undefined;
  if (!phases) return;
  for (const phase of phases.values()) emitPerformance(phase);
}
function configureDiagnostics(input: Partial<SqliteDiagnosticsConfiguration> | undefined): void {
  diagnosticsEnabled = input?.performance === true;
  diagnosticSessionId =
    typeof input?.sessionId === "string" && input.sessionId.length <= 128
      ? input.sessionId
      : "none";
}
let bootConfig:
  | {
      corpusFingerprint: string;
      embeddingFingerprint: string;
      profileModelId: string;
      profileEndpointOrigin: string;
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
  storage.database = new MutableSqliteDatabase(
    storage.connection,
    workerDiagnostics,
    observeRetrievalPhase
  );
  if (bootConfig) {
    try {
      storage.database.boot(
        bootConfig.corpusFingerprint,
        bootConfig.dimensions,
        bootConfig.embeddingFingerprint,
        bootConfig.buildIdentity,
        { modelId: bootConfig.profileModelId, endpointOrigin: bootConfig.profileEndpointOrigin }
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
  profileModelId: string;
  profileEndpointOrigin: string;
}): MutableSqliteDatabase {
  try {
    const pool = storage.opfsPool;
    if (!pool) throw new Error("OPFS pool is unavailable");
    return resetWorkerDatabase(storage, pool, () => {
      let connection: SqliteConnection | undefined;
      let database: MutableSqliteDatabase | undefined;
      try {
        connection = new pool.OpfsSAHPoolDb("/index.sqlite3", "c");
        database = new MutableSqliteDatabase(connection, workerDiagnostics, observeRetrievalPhase);
        database.boot(
          config.corpusFingerprint,
          config.dimensions,
          config.embeddingFingerprint,
          config.buildIdentity,
          { modelId: config.profileModelId, endpointOrigin: config.profileEndpointOrigin }
        );
        return { connection, database };
      } catch (error) {
        if (database) database.close();
        else connection?.close();
        throw error;
      }
    });
  } catch (error) {
    if (error && typeof error === "object" && "error" in error) throw error;
    storageFailure("incompatible database reset", error);
  }
}
function runtimeConfig(database: MutableSqliteDatabase) {
  const state = database.getState();
  return bootConfig
    ? {
        corpus: bootConfig.corpusFingerprint,
        embedding: bootConfig.embeddingFingerprint,
        dimensions: bootConfig.dimensions,
        buildIdentity: bootConfig.buildIdentity,
      }
    : {
        corpus: state.corpusFingerprint,
        embedding: state.embeddingFingerprint,
        dimensions: state.dimensions,
        buildIdentity: state.buildIdentity,
      };
}
const publication = new WorkerPublicationOperations({
  storage,
  openDatabase: () => openDatabase(),
  closeConnection,
  runtimeConfig,
  onPhase: (phase, durationMs) =>
    emitPerformance({
      tier: "performance",
      facets: ["index", "publication", "worker"],
      area: "index",
      event: "phase",
      operation: "publication",
      phase,
      durationMs,
      nested: true,
    }),
});

async function handle(request: SqliteRequest, signal: AbortSignal): Promise<unknown> {
  const p: any = request.payload;
  if (request.method === "boot") {
    const config = {
      corpusFingerprint: p.corpusFingerprint as string,
      dimensions: p.dimensions as number,
      embeddingFingerprint: (p.embeddingFingerprint ?? "") as string,
      profileModelId: (p.profileModelId ?? "") as string,
      profileEndpointOrigin: (p.profileEndpointOrigin ?? "") as string,
      buildIdentity: (p.buildIdentity ?? SQLITE_BUILD_IDENTITY) as string,
    };
    bootConfig = config;
    try {
      return (await openDatabase(p.identity ?? "default")).boot(
        config.corpusFingerprint,
        config.dimensions,
        config.embeddingFingerprint,
        config.buildIdentity,
        { modelId: config.profileModelId, endpointOrigin: config.profileEndpointOrigin }
      );
    } catch (error) {
      if ((error as any)?.error?.code !== "incompatible_state") throw error;
      const replacement = resetIncompatibleLocalDatabase(config);
      return replacement.getState();
    }
  }
  if (request.method === "shutdown") {
    scheduler.shutdown();
    for (const candidate of legacyCacheCandidates.values()) {
      candidate.database.close();
      storage.opfsPool?.unlink(candidate.name);
    }
    legacyCacheCandidates.clear();
    closeConnection();
    bootConfig = undefined;
    return { closed: true };
  }
  if (request.method === "resetLocalDatabase") {
    if (!bootConfig)
      throw sqliteError("storage_unavailable", "SQLite index must be booted before reset", true);
    return resetIncompatibleLocalDatabase(bootConfig).getState();
  }
  if (request.method === "preparePublication") return publication.prepare(p.publicationId);
  if (request.method === "finalizePublication") return publication.finalize(p);
  if (request.method === "inspectPublication") return publication.inspect(p);
  if (request.method === "adoptPublication") return publication.adopt(p);
  if (request.method === "prepareCacheShard") {
    const database = await openDatabase();
    return database.prepareCacheShard(
      storage.opfsPool!,
      p.afterActionKey,
      p.taskKind ?? "document",
      p.profile,
      p.sourceDigests,
      p.presentDigests,
      p.maxPayloadBytes,
      p.now
    );
  }
  if (request.method === "ingestCacheShard") {
    const database = await openDatabase();
    return database.ingestCacheShard(storage.opfsPool!, p.bytes, p.digest);
  }
  if (request.method === "extractLegacyCacheShard") {
    const database = await openDatabase();
    const digest = p.digest as string;
    let candidate = legacyCacheCandidates.get(digest);
    if (!candidate) {
      if (!(p.bytes instanceof ArrayBuffer) || (await sha256Hex(p.bytes)) !== digest)
        throw sqliteError("integrity_failed", "Legacy index digest mismatch");
      const expected = runtimeConfig(database);
      const name = `/legacy-cache-${digest.slice(0, 16)}`;
      storage.opfsPool!.importDb(name, p.bytes);
      const connection = new storage.opfsPool!.OpfsSAHPoolDb(name, "c");
      const isolated = new MutableSqliteDatabase(
        connection,
        workerDiagnostics,
        observeRetrievalPhase
      );
      try {
        isolated.validateSnapshot(
          expected.corpus,
          expected.dimensions,
          expected.embedding,
          expected.buildIdentity
        );
        candidate = { name, database: isolated };
        legacyCacheCandidates.set(digest, candidate);
      } catch (error) {
        isolated.close();
        storage.opfsPool!.unlink(name);
        throw error;
      }
    }
    try {
      const shard = await candidate.database.prepareCacheShard(storage.opfsPool!, p.afterActionKey);
      if (!shard) {
        candidate.database.close();
        storage.opfsPool!.unlink(candidate.name);
        legacyCacheCandidates.delete(digest);
      }
      return shard;
    } catch (error) {
      candidate.database.close();
      storage.opfsPool!.unlink(candidate.name);
      legacyCacheCandidates.delete(digest);
      throw error;
    }
  }
  if (request.method === "hasLegacyCacheSource")
    return (await openDatabase()).hasLegacyCacheSource(p.digest);
  if (request.method === "markLegacyCacheSource") {
    (await openDatabase()).markLegacyCacheSource(p.digest);
    return { marked: true };
  }
  if (request.method === "maintainCache") return (await openDatabase()).maintainCache(p.now);
  if (request.method === "recordCacheShard") {
    (await openDatabase()).recordCacheShard(p.digest, p.profile, p.taskKind, p.actionKeys);
    return { recorded: true };
  }
  if (request.method === "recordCacheRetirements") {
    await (
      await openDatabase()
    ).recordCacheRetirements(p.sourceDigests, p.replacementDigests, p.now);
    return { recorded: true };
  }
  if (request.method === "listCacheRetirements")
    return (await openDatabase()).listCacheRetirements();
  if (request.method === "completeCacheRetirement") {
    (await openDatabase()).completeCacheRetirement(p.sourceDigest, p.now);
    return { completed: true };
  }
  const db = await openDatabase();
  switch (request.method) {
    case "getState":
      return db.getState();
    case "markIncomplete":
      return db.markIncomplete();
    case "beginLexicalRun":
      return db.beginLexicalRun({
        runId: p.runId,
        summaries: p.summaries,
        expectedChangeCounter: p.expectedChangeCounter,
        scope: p.scope,
      });
    case "applyLexicalBatch":
      return applyLexicalMarkdownBatch(
        db,
        p.runId,
        p.notes,
        signal,
        diagnosticsEnabled ? observeLexicalMarkdownPhase : undefined
      );
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
    case "lookupQueryVector":
      return db.lookupQueryVector(p.query, p.embeddingFingerprint);
    case "storeQueryVector":
      return db.storeQueryVector(p.query, p.embeddingFingerprint, p.dimensions, p.vector);
    case "selectEmbeddingProfile":
      return db.selectEmbeddingProfile(p.fingerprint);
    case "clearSemanticCache":
      return db.clearSemanticCache();
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
    configureDiagnostics(data.diagnostics);
    post({
      type: "trama-runtime-handshake",
      id: data.id,
      buildId: TRAMA_RUNTIME_BUILD_ID,
      diagnosticsConfigured: true,
    } as any);
    return;
  }
  if (data?.type === SQLITE_DIAGNOSTICS_CONFIG_TYPE) {
    configureDiagnostics(data.diagnostics);
    post({ type: SQLITE_DIAGNOSTICS_CONFIG_TYPE, id: data.id, configured: true } as any);
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
    "resetLocalDatabase",
    "preparePublication",
    "finalizePublication",
    "inspectPublication",
    "adoptPublication",
    "prepareCacheShard",
    "extractLegacyCacheShard",
    "markLegacyCacheSource",
    "maintainCache",
    "recordCacheShard",
    "recordCacheRetirements",
    "listCacheRetirements",
    "completeCacheRetirement",
  ].includes(request.method);
  if (isMaintenance) maintenance = true;
  void scheduler
    .enqueue(request.id, async (signal) => {
      const measured =
        diagnosticsEnabled &&
        [
          "applyLexicalBatch",
          "prepareSemanticWork",
          "commitSemanticResults",
          "retrieve",
          "findRelated",
          "preparePublication",
          "finalizePublication",
          "inspectPublication",
          "adoptPublication",
        ].includes(request.method);
      if (measured) {
        diagnosticRequestId = request.id;
        diagnosticMethod = request.method;
        diagnosticOperationId =
          typeof request.diagnosticOperationId === "string" &&
          /^[A-Za-z0-9_-]{1,96}$/.test(request.diagnosticOperationId)
            ? request.diagnosticOperationId
            : undefined;
        diagnosticParentOperationId =
          typeof request.diagnosticParentOperationId === "string" &&
          /^[A-Za-z0-9_-]{1,96}$/.test(request.diagnosticParentOperationId)
            ? request.diagnosticParentOperationId
            : undefined;
        diagnosticBatchId =
          typeof request.diagnosticBatchId === "string" &&
          /^[A-Za-z0-9_-]{1,96}$/.test(request.diagnosticBatchId)
            ? request.diagnosticBatchId
            : undefined;
      }
      semanticPhases =
        measured &&
        (request.method === "prepareSemanticWork" || request.method === "commitSemanticResults")
          ? new Map()
          : undefined;
      const started = measured ? performance.now() : undefined;
      try {
        return await handle(request, signal);
      } finally {
        flushSemanticPhases();
        if (started !== undefined)
          emitPerformance({
            tier: "performance",
            facets: [
              "index",
              "worker",
              "rpc",
              request.method === "findRelated"
                ? "related"
                : request.method === "retrieve"
                  ? "retrieve"
                  : request.method === "adoptPublication"
                    ? "adoption"
                    : request.method.includes("Publication")
                      ? "publication"
                      : request.method.includes("Semantic")
                        ? "semantic"
                        : "lexical",
            ],
            area: request.method === "findRelated" ? "filo" : "index",
            event: "phase",
            operation:
              request.method === "retrieve"
                ? "retrieve"
                : request.method === "findRelated"
                  ? "related"
                  : request.method === "adoptPublication"
                    ? "adoption"
                    : request.method.includes("Publication")
                      ? "publication"
                      : request.method.includes("Semantic")
                        ? "semantic"
                        : "lexical",
            phase: request.method,
            durationMs: Math.max(0, performance.now() - started),
          });
        diagnosticRequestId = undefined;
        diagnosticOperationId = undefined;
        diagnosticParentOperationId = undefined;
        diagnosticBatchId = undefined;
        diagnosticMethod = undefined;
      }
    })
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
