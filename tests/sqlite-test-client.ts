import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SqliteWorkerClient, type SqliteCallHandler } from "@/index/sqlite/client";
import { MutableSqliteDatabase } from "@/index/sqlite/database";
import type { TramaDiagnostics } from "@/diagnostics/TramaDiagnostics";

interface SemanticPhaseObservation {
  readonly phase: string;
  readonly sqlCalls: number;
  readonly callbackRows: number;
  readonly copiedBytes: number;
}
type SemanticPhaseObserver = (observation: SemanticPhaseObservation) => void;
import { sqliteError } from "@/index/sqlite/protocol";
import { applyLexicalMarkdownBatch, hashMarkdown } from "@/index/sqlite/markdown";
import type { SqliteLexicalScope } from "@/index/sqlite/protocol";
import type { CacheShardPool } from "@/index/sqlite/cache-shards";

interface TestStorage {
  snapshot?: Uint8Array;
}

interface OpenDatabase {
  readonly raw: any;
  readonly database: MutableSqliteDatabase;
}

type TestSqliteClient = ReturnType<typeof createTestSqliteClient>;

export async function applyTestLexicalRun(
  client: TestSqliteClient,
  notes: readonly { readonly path: string; readonly markdown: string; readonly size?: number }[],
  scope: SqliteLexicalScope = { mayClearIncomplete: true }
) {
  const run = await client.call("beginLexicalRun", { scope });
  const applied = await client.call("applyLexicalBatch", { runId: run.runId, notes });
  let finished = await client.call("finishLexicalRun", { runId: run.runId });
  while (!finished.complete) finished = await client.call("finishLexicalRun", { runId: run.runId });
  return { applied, finished };
}

export async function embedAllTestInputs(
  client: TestSqliteClient,
  embeddingFingerprint: string,
  vectorFor: (request: {
    actionKey: string;
    inputId: number;
    serialization: string;
  }) => Float32Array,
  limit = 128
) {
  const requests = [];
  for (;;) {
    const prepared = await client.call("prepareSemanticWork", {
      embeddingFingerprint,
      limit,
      maxInputBytes: 4 * 1024 * 1024,
    });
    requests.push(...prepared.requests);
    if (prepared.requests.length === 0) return requests;
    await client.call("commitSemanticResults", {
      embeddingFingerprint,
      dimensions: vectorFor(prepared.requests[0]).length,
      expectedCount: prepared.requests.length,
      results: prepared.requests.map(
        (request: { actionKey: string; inputId: number; serialization: string }) => ({
          ...request,
          vector: vectorFor(request),
        })
      ),
    });
    if (!prepared.hasMore) return requests;
  }
}

const storage = new WeakMap<object, TestStorage>();
let runtimePromise: Promise<any> | undefined;

export async function snapshotFor(identity: object): Promise<Uint8Array> {
  const durable = storage.get(identity);
  if (!durable?.snapshot) throw new Error("SQLite test client has no persisted snapshot");
  return durable.snapshot.slice();
}

export async function inspectWorkloadState(bytes: ArrayBuffer | Uint8Array): Promise<{
  readonly noteCount: number;
  readonly occurrenceCount: number;
  readonly perPathOccurrenceCounts: readonly (readonly [string, number])[];
  readonly occurrenceContentSha256: string;
  readonly semanticState: {
    readonly semanticEligibleCount: number;
    readonly semanticHeadCount: number;
    readonly semanticLagCount: number;
    readonly semanticMissingCount: number;
    readonly compatibleVectorCount: number;
    readonly semanticReady: boolean;
  };
}> {
  const opened = await open(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  try {
    const rows: {
      path: string;
      ordinal: number;
      kind: string;
      startLine: number;
      endLine: number;
      displayText: string;
      headingContext: string;
      body: string;
      embeddingInput: string;
    }[] = [];
    opened.raw.exec({
      sql: `SELECT n.path AS path,o.ordinal AS ordinal,o.kind AS kind,
                   o.start_line AS startLine,o.end_line AS endLine,
                   o.display_text AS displayText,json_extract(ei.serialized_input,'$.heading') AS headingContext,
                   o.display_text AS body,ei.serialized_input AS embeddingInput
            FROM notes n JOIN chunk_occurrences o
              ON o.note_id=n.note_id AND o.revision_id=n.lexical_revision_id
            JOIN embedding_inputs ei ON ei.action_key=o.embedding_input_digest
            ORDER BY n.path COLLATE BINARY,o.ordinal`,
      rowMode: "object",
      callback: (row: (typeof rows)[number]) =>
        rows.push({
          ...row,
          ordinal: Number(row.ordinal),
          startLine: Number(row.startLine),
          endLine: Number(row.endLine),
        }),
    });
    const state = opened.database.getState();
    const pathCounts = new Map<string, number>();
    for (const row of rows) pathCounts.set(row.path, (pathCounts.get(row.path) ?? 0) + 1);
    const tuples = rows.map((row) => [
      row.path,
      row.ordinal,
      row.kind,
      row.startLine,
      row.endLine,
      row.displayText,
      row.headingContext,
      row.body,
      row.embeddingInput,
    ]);
    return {
      noteCount: pathCounts.size,
      occurrenceCount: rows.length,
      perPathOccurrenceCounts: [...pathCounts],
      occurrenceContentSha256: createHash("sha256")
        .update(JSON.stringify(tuples), "utf8")
        .digest("hex"),
      semanticState: {
        semanticEligibleCount: state.semanticEligibleCount,
        semanticHeadCount: state.semanticHeadCount,
        semanticLagCount: state.semanticLagCount,
        semanticMissingCount: state.semanticMissingCount,
        compatibleVectorCount: state.compatibleVectorCount,
        semanticReady: state.semanticReady,
      },
    };
  } finally {
    opened.database.close();
  }
}

export async function inspectIndexStateColumns(bytes: ArrayBuffer | Uint8Array): Promise<string[]> {
  const opened = await open(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  try {
    const columns: string[] = [];
    opened.raw.exec({
      sql: "PRAGMA table_info(index_state)",
      rowMode: "object",
      callback: (row: { name: string }) => columns.push(row.name),
    });
    return columns;
  } finally {
    opened.database.close();
  }
}

export async function inspectSnapshotTables(bytes: ArrayBuffer | Uint8Array): Promise<{
  revisions: number;
  occurrences: number;
  inputs: number;
  cache: number;
}> {
  const opened = await open(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  try {
    const count = (table: string) => {
      let value = 0;
      opened.raw.exec({
        sql: `SELECT count(*) AS count FROM ${table}`,
        rowMode: "object",
        callback: (row: Record<string, unknown>) => {
          value = Number(row.count);
        },
      });
      return value;
    };
    return {
      revisions: count("note_revisions"),
      occurrences: count("chunk_occurrences"),
      inputs: count("embedding_inputs"),
      cache: count("embedding_cache"),
    };
  } finally {
    opened.database.close();
  }
}

export const hashTestMarkdown = (markdown: string, corpusFingerprint: string) =>
  hashMarkdown(markdown, corpusFingerprint);

export async function loadTestSqlite(): Promise<any> {
  runtimePromise ??= (async () => {
    (globalThis as any).sqlite3ApiConfig = {
      disable: { vfs: { kvvfs: true, opfs: true, "opfs-wl": true } },
    };
    // @ts-expect-error generated production asset has no application declarations.
    const init = (await import("../sqlite3.mjs")).default;
    const wasmPath = fileURLToPath(new URL("../sqlite3.wasm", import.meta.url));
    const wasmBinary = readFileSync(wasmPath);
    return init({
      instantiateWasm(
        imports: WebAssembly.Imports,
        onSuccess: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
      ) {
        WebAssembly.instantiate(wasmBinary, imports).then(({ instance, module }) =>
          onSuccess(instance, module)
        );
        return {};
      },
    });
  })();
  return runtimePromise;
}

async function open(
  snapshot?: Uint8Array,
  semanticObserver?: SemanticPhaseObserver,
  diagnosticOverride?: TramaDiagnostics
): Promise<OpenDatabase> {
  const sqlite = await loadTestSqlite();
  const raw = new sqlite.oo1.DB(":memory:", "c");
  if (snapshot?.byteLength) {
    const pointer = sqlite.wasm.allocFromTypedArray(snapshot);
    const flags =
      sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite.capi.SQLITE_DESERIALIZE_RESIZEABLE;
    const result = sqlite.capi.sqlite3_deserialize(
      raw.pointer,
      "main",
      pointer,
      snapshot.byteLength,
      snapshot.byteLength,
      flags
    );
    if (result !== 0) {
      raw.close();
      throw sqliteError("integrity_failed", "Snapshot integrity check failed");
    }
  }
  const diagnostics: TramaDiagnostics = {
    enabled: (tier) => tier === "performance" && Boolean(semanticObserver),
    emit(record) {
      if (
        !("tier" in record) ||
        record.tier !== "performance" ||
        record.operation !== "semantic" ||
        !record.semanticStep
      )
        return;
      semanticObserver?.({
        phase: record.phase,
        sqlCalls: record.sqlCalls ?? 0,
        callbackRows: record.callbackRows ?? 0,
        copiedBytes: record.copiedBytes ?? 0,
      });
    },
  };
  return { raw, database: new MutableSqliteDatabase(raw, diagnosticOverride ?? diagnostics) };
}

async function serialized(opened: OpenDatabase): Promise<Uint8Array> {
  const sqlite = await loadTestSqlite();
  return new Uint8Array(sqlite.capi.sqlite3_js_db_export(opened.raw.pointer));
}

export function createCachePool(sqlite: any): CacheShardPool {
  const files = new Map<string, any>();
  class PoolDb extends sqlite.oo1.DB {
    private readonly name: string;
    constructor(name: string, mode: string) {
      super(":memory:", mode);
      this.name = name;
      const bytes = files.get(name);
      if (bytes instanceof Uint8Array) {
        const pointer = sqlite.wasm.allocFromTypedArray(bytes);
        const flags =
          sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite.capi.SQLITE_DESERIALIZE_RESIZEABLE;
        const rc = sqlite.capi.sqlite3_deserialize(
          this.pointer,
          "main",
          pointer,
          bytes.byteLength,
          bytes.byteLength,
          flags
        );
        if (rc !== 0) throw new Error("candidate deserialize failed");
      }
      files.set(name, this);
    }
    close() {
      files.set(this.name, new Uint8Array(sqlite.capi.sqlite3_js_db_export(this.pointer)));
      super.close();
    }
  }
  return {
    OpfsSAHPoolDb: PoolDb as unknown as CacheShardPool["OpfsSAHPoolDb"],
    exportFile(name) {
      const value = files.get(name);
      if (value instanceof Uint8Array) return value.slice();
      if (!value) throw new Error("missing cache candidate");
      return new Uint8Array(sqlite.capi.sqlite3_js_db_export(value.pointer));
    },
    importDb(name, bytes) {
      files.set(name, (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).slice());
      return 0;
    },
    unlink(name) {
      const value = files.get(name);
      if (!value) return false;
      if (!(value instanceof Uint8Array)) value.close();
      files.delete(name);
      return true;
    },
  };
}

export async function inspectPersistedOccurrences(
  identity: object
): Promise<{ headingContext: string; embeddingInput: string }[]> {
  const durable = storage.get(identity);
  if (!durable?.snapshot) return [];
  const opened = await open(durable.snapshot);
  try {
    const rows: { headingContext: string; embeddingInput: string }[] = [];
    opened.raw.exec({
      sql: "SELECT json_extract(ei.serialized_input,'$.heading') AS headingContext, ei.serialized_input AS embeddingInput FROM chunk_occurrences o JOIN embedding_inputs ei ON ei.action_key=o.embedding_input_digest ORDER BY o.occurrence_id",
      rowMode: "object",
      callback: (row: { headingContext: string; embeddingInput: string }) => rows.push(row),
    });
    return rows;
  } finally {
    opened.database.close();
  }
}

export async function inspectPersistedLexicalRevisionCount(identity: object): Promise<number> {
  const durable = storage.get(identity);
  if (!durable?.snapshot) return 0;
  const opened = await open(durable.snapshot);
  try {
    let count = 0;
    opened.raw.exec({
      sql: "SELECT count(*) AS count FROM notes WHERE lexical_revision_id IS NOT NULL",
      rowMode: "object",
      callback: (row: { count: number }) => {
        count = Number(row.count);
      },
    });
    return count;
  } finally {
    opened.database.close();
  }
}

/** Test-only RPC adapter backed by the same generated SQLite WASM database as production. */
export function createTestSqliteClient(
  identity: object = {},
  options: {
    readonly persistMutations?: boolean;
    readonly onSemanticPhase?: (phase: SemanticPhaseObservation) => void;
    readonly diagnostics?: TramaDiagnostics;
  } = {}
): SqliteWorkerClient {
  const durable = storage.get(identity) ?? {};
  storage.set(identity, durable);
  let openedPromise: Promise<OpenDatabase> | undefined;
  const current = () =>
    (openedPromise ??= open(durable.snapshot, options.onSemanticPhase, options.diagnostics));
  const cachePoolPromise = loadTestSqlite().then(createCachePool);
  const persist = async (opened: OpenDatabase) => {
    durable.snapshot = await serialized(opened);
  };
  let maintenance = false;
  const handler: SqliteCallHandler = async (method, payload, signal) => {
    const isMaintenance =
      method === "prepareCacheShard" ||
      method === "ingestCacheShard" ||
      method === "maintainCache" ||
      method === "recordCacheShard" ||
      method === "recordCacheRetirements" ||
      method === "listCacheRetirements" ||
      method === "completeCacheRetirement" ||
      method === "resetLocalDatabase";
    if (isMaintenance) {
      if (maintenance) throw sqliteError("busy", "SQLite maintenance is in progress", true);
      maintenance = true;
    } else if (maintenance) {
      throw sqliteError("busy", "SQLite maintenance is in progress", true);
    }
    try {
      if (signal?.aborted) throw sqliteError("cancelled", "Request cancelled", true);
      let opened = await current();
      const value = payload as any;
      let result: unknown;
      switch (method) {
        case "boot":
          try {
            result = opened.database.boot(
              value.corpusFingerprint,
              value.dimensions,
              value.embeddingFingerprint ?? "",
              value.buildIdentity
            );
          } catch (error) {
            if ((error as any)?.error?.code !== "incompatible_state") throw error;
            opened.database.close();
            durable.snapshot = undefined;
            openedPromise = open(undefined, options.onSemanticPhase, options.diagnostics);
            opened = await openedPromise;
            result = opened.database.boot(
              value.corpusFingerprint,
              value.dimensions,
              value.embeddingFingerprint ?? "",
              value.buildIdentity
            );
          }
          break;
        case "resetLocalDatabase": {
          const state = opened.database.getState();
          opened.database.close();
          durable.snapshot = undefined;
          openedPromise = open(undefined, options.onSemanticPhase, options.diagnostics);
          opened = await openedPromise;
          result = opened.database.boot(
            state.corpusFingerprint,
            state.dimensions,
            state.embeddingFingerprint,
            state.buildIdentity
          );
          break;
        }
        case "listCacheReceipts":
          return opened.database.listCacheReceipts(value.digests);
        case "getState":
          return opened.database.getState();
        case "prepareCacheShard":
          result = await opened.database.prepareCacheShard(
            await cachePoolPromise,
            value.afterActionKey,
            value.taskKind,
            value.profile,
            value.sourceDigests,
            value.presentDigests,
            value.maxPayloadBytes,
            value.now
          );
          break;
        case "ingestCacheShard":
          result = await opened.database.ingestCacheShard(
            await cachePoolPromise,
            value.bytes,
            value.digest
          );
          break;
        case "maintainCache":
          result = opened.database.maintainCache(value.now);
          break;
        case "recordCacheShard":
          opened.database.recordCacheShard(
            value.digest,
            value.profile,
            value.taskKind,
            value.actionKeys
          );
          result = { recorded: true };
          break;
        case "recordCacheRetirements":
          await opened.database.recordCacheRetirements(
            value.sourceDigests,
            value.replacementDigests,
            value.now
          );
          result = { recorded: true };
          break;
        case "listCacheRetirements":
          result = opened.database.listCacheRetirements();
          break;
        case "completeCacheRetirement":
          opened.database.completeCacheRetirement(value.sourceDigest, value.now);
          result = { completed: true };
          break;
        case "markIncomplete":
          result = opened.database.markIncomplete();
          break;
        case "beginLexicalRun":
          result = opened.database.beginLexicalRun({
            runId: value.runId,
            summaries: value.summaries,
            expectedChangeCounter: value.expectedChangeCounter,
            scope: value.scope,
          });
          break;
        case "applyLexicalBatch":
          result = await applyLexicalMarkdownBatch(
            opened.database,
            value.runId,
            value.notes,
            signal
          );
          break;
        case "finishLexicalRun":
          result = opened.database.finishLexicalRun(value.runId);
          break;
        case "abortLexicalRun":
          result = opened.database.abortLexicalRun(value.runId);
          break;
        case "listLexicalSummaries":
          result = opened.database.listLexicalSummaries();
          break;
        case "prepareSemanticWork":
          result = opened.database.prepareSemanticWork(
            value.embeddingFingerprint,
            value.preprocessing,
            value.limit,
            value.maxInputBytes,
            value.promoteUnrestricted
          );
          break;
        case "commitSemanticResults":
          result = opened.database.commitSemanticResults(
            value.results,
            value.embeddingFingerprint,
            value.preprocessing
          );
          break;
        case "lookupQueryVector":
          result = await opened.database.lookupQueryVector(value.query, value.embeddingFingerprint);
          break;
        case "storeQueryVector":
          await opened.database.storeQueryVector(
            value.query,
            value.embeddingFingerprint,
            value.dimensions,
            value.vector
          );
          result = { stored: true };
          break;
        case "selectEmbeddingProfile":
          result = opened.database.selectEmbeddingProfile(value.fingerprint);
          break;
        case "clearSemanticCache":
          result = opened.database.clearSemanticCache();
          break;
        case "retrieve":
          return opened.database.retrieve(
            value.query,
            value.vector,
            value.limit,
            value.currentPath,
            {
              semanticCandidateLimit: value.semanticCandidateLimit,
              lexicalCandidateLimit: value.lexicalCandidateLimit,
              lexicalProfile: value.lexicalProfile,
              resultShape: value.resultShape,
            }
          );
        case "findRelated":
          return opened.database.findRelated(value.path, value.vector, value.limit, signal);
        case "cancelQueued":
          return { cancelled: false };
        case "shutdown":
          await persist(opened);
          opened.database.close();
          openedPromise = undefined;
          return { closed: true };
        default:
          throw sqliteError("unsupported", `SQLite method ${method} is unavailable`);
      }
      if (options.persistMutations !== false) await persist(opened);
      return result;
    } finally {
      if (isMaintenance) maintenance = false;
    }
  };
  return new SqliteWorkerClient(undefined, handler);
}
