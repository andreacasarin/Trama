import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SqliteWorkerClient, type SqliteCallHandler } from "@/index/sqlite/client";
import { MutableSqliteDatabase } from "@/index/sqlite/database";
import { sqliteError } from "@/index/sqlite/protocol";
import { applyLexicalMarkdownBatch, hashMarkdown } from "@/index/sqlite/markdown";
import type { SqliteLexicalScope } from "@/index/sqlite/protocol";
import { schemaSql } from "@/index/sqlite/schema";

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

export async function malformedSchema8Snapshot(
  defect: "missing-vector" | "wrong-fts" | "wrong-index"
): Promise<Uint8Array> {
  const sqlite = await loadTestSqlite();
  const raw = new sqlite.oo1.DB(":memory:", "c");
  raw.exec(schemaSql(2));
  raw.exec("ALTER TABLE index_state ADD COLUMN lexical_revision_count INTEGER NOT NULL DEFAULT 0");
  raw.exec("ALTER TABLE index_state ADD COLUMN semantic_revision_count INTEGER NOT NULL DEFAULT 0");
  raw.exec("ALTER TABLE index_state ADD COLUMN embedding_input_count INTEGER NOT NULL DEFAULT 0");
  raw.exec("PRAGMA user_version=8");
  raw.exec(
    "INSERT INTO index_state(id,app_version,schema_version,protocol_version,build_identity,extraction_version,chunk_algorithm_version,embedding_input_version,dimensions,corpus_fingerprint,embedding_fingerprint,incomplete,change_counter,snapshot_loaded) VALUES(1,'trama',8,8,'trama-sqlite-schema-8-protocol-8-heads-fts5-vector-float32-cosine-opfs-sah-v1',1,2,1,2,?, ?,1,0,0)",
    { bind: ["a".repeat(64), "b".repeat(64)] }
  );
  if (defect === "missing-vector") raw.exec("ALTER TABLE embedding_cache DROP COLUMN vector");
  if (defect === "wrong-fts") {
    raw.exec("DROP TABLE active_lexical_fts");
    raw.exec(
      "CREATE VIRTUAL TABLE active_lexical_fts USING fts5(body,path_text,filename,content='active_lexical',content_rowid='wrong_id',tokenize='unicode61')"
    );
  }
  if (defect === "wrong-index") {
    raw.exec("DROP INDEX active_lexical_note");
    raw.exec("CREATE INDEX active_lexical_note ON active_lexical(revision_id,note_id)");
  }
  const bytes = new Uint8Array(sqlite.capi.sqlite3_js_db_export(raw.pointer));
  raw.close();
  return bytes;
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

async function open(snapshot?: Uint8Array): Promise<OpenDatabase> {
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
  return { raw, database: new MutableSqliteDatabase(raw) };
}

async function serialized(opened: OpenDatabase): Promise<Uint8Array> {
  const sqlite = await loadTestSqlite();
  return new Uint8Array(sqlite.capi.sqlite3_js_db_export(opened.raw.pointer));
}

export async function inspectSnapshotTables(bytes: ArrayBuffer): Promise<{
  revisions: number;
  occurrences: number;
  inputs: number;
  cache: number;
}> {
  const opened = await open(new Uint8Array(bytes));
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

export async function inspectPersistedOccurrences(
  identity: object
): Promise<{ headingContext: string; embeddingInput: string }[]> {
  const durable = storage.get(identity);
  if (!durable?.snapshot) return [];
  const opened = await open(durable.snapshot);
  try {
    const rows: { headingContext: string; embeddingInput: string }[] = [];
    opened.raw.exec({
      sql: "SELECT heading_context AS headingContext, embedding_input AS embeddingInput FROM chunk_occurrences ORDER BY occurrence_id",
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
  options: { readonly persistMutations?: boolean; readonly snapshot?: Uint8Array } = {}
): SqliteWorkerClient {
  const durable = storage.get(identity) ?? {};
  if (!durable.snapshot && options.snapshot) durable.snapshot = options.snapshot;
  storage.set(identity, durable);
  let openedPromise: Promise<OpenDatabase> | undefined;
  const current = () => (openedPromise ??= open(durable.snapshot));
  const persist = async (opened: OpenDatabase) => {
    durable.snapshot = await serialized(opened);
  };
  const reopen = async (opened: OpenDatabase): Promise<OpenDatabase> => {
    const state = opened.database.getState();
    const snapshot = await serialized(opened);
    opened.database.close();
    const next = await open(snapshot);
    next.database.boot(
      state.corpusFingerprint,
      state.dimensions,
      state.embeddingFingerprint,
      state.buildIdentity
    );
    openedPromise = Promise.resolve(next);
    return next;
  };
  let maintenance = false;
  const handler: SqliteCallHandler = async (method, payload, signal) => {
    const isMaintenance =
      method === "preparePublication" ||
      method === "finalizePublication" ||
      method === "inspectPublication" ||
      method === "adoptPublication";
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
            openedPromise = open();
            opened = await openedPromise;
            result = opened.database.boot(
              value.corpusFingerprint,
              value.dimensions,
              value.embeddingFingerprint ?? "",
              value.buildIdentity
            );
          }
          break;
        case "getState":
          return opened.database.getState();
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
          return opened.database.findRelated(value.path, value.vector, value.limit);
        case "finalizePublication":
          result = opened.database.finalizePublication(
            value.publicationId,
            value.expectedChangeCounter,
            value.expectedLexicalGeneration,
            value.expectedSemanticGeneration
          );
          break;
        case "preparePublication": {
          if (opened.database.hasActiveLexicalRuns())
            throw sqliteError("busy", "A lexical run is still active", true);
          const state = opened.database.getState();
          opened.database.validateSnapshot(
            state.corpusFingerprint,
            state.dimensions,
            state.embeddingFingerprint,
            state.buildIdentity
          );
          const candidate = await open(await serialized(opened));
          try {
            candidate.database.boot(
              state.corpusFingerprint,
              state.dimensions,
              state.embeddingFingerprint,
              state.buildIdentity
            );
            candidate.database.pruneForPublication();
            candidate.database.setPublicationId(value.publicationId);
            candidate.database.validateSnapshot(
              state.corpusFingerprint,
              state.dimensions,
              state.embeddingFingerprint,
              state.buildIdentity
            );
            const bytes = (await serialized(candidate)).slice().buffer;
            result = {
              publicationId: value.publicationId,
              state: candidate.database.getState(),
              bytes,
              byteSize: bytes.byteLength,
              durationMs: 0,
              copyBytes: bytes.byteLength,
            };
          } finally {
            candidate.database.close();
            opened = await reopen(opened);
          }
          break;
        }
        case "inspectPublication": {
          if (opened.database.hasActiveLexicalRuns())
            throw sqliteError("busy", "A lexical run is still active", true);
          const state = opened.database.getState();
          const candidate = await open(new Uint8Array(value.bytes));
          try {
            candidate.database.validateSnapshot(
              value.corpusFingerprint ?? state.corpusFingerprint,
              value.dimensions ?? state.dimensions,
              value.embeddingFingerprint ?? state.embeddingFingerprint,
              value.buildIdentity ?? state.buildIdentity
            );
            const candidateState = candidate.database.getState();
            if (!candidateState.publicationId)
              throw sqliteError("incompatible_state", "Publication ID is missing");
            result = {
              valid: true,
              publicationId: candidateState.publicationId,
              state: candidateState,
              byteSize: value.bytes.byteLength,
            };
          } finally {
            candidate.database.close();
            opened = await reopen(opened);
          }
          break;
        }
        case "adoptPublication": {
          if (opened.database.hasActiveLexicalRuns())
            throw sqliteError("busy", "A lexical run is still active", true);
          const prior = opened.database.getState();
          const candidate = await open(new Uint8Array(value.bytes));
          try {
            candidate.database.validateSnapshot(
              prior.corpusFingerprint,
              prior.dimensions,
              prior.embeddingFingerprint,
              prior.buildIdentity
            );
            candidate.database.boot(
              prior.corpusFingerprint,
              prior.dimensions,
              prior.embeddingFingerprint,
              prior.buildIdentity
            );
            const candidateState = candidate.database.getState();
            if (!candidateState.publicationId)
              throw sqliteError("incompatible_state", "Publication ID is missing");
            if (
              value.expectedPublicationId &&
              value.expectedPublicationId !== candidateState.publicationId
            )
              throw sqliteError("incompatible_state", "Publication ID changed during adoption");
            candidate.database.markSnapshotLoaded();
            const adoptedState = candidate.database.getState();
            opened.database.close();
            opened = candidate;
            openedPromise = Promise.resolve(candidate);
            result = adoptedState;
          } catch (error) {
            if (opened.database !== candidate.database) candidate.database.close();
            throw error;
          }
          break;
        }
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
