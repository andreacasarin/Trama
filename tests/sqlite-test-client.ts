import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SqliteWorkerClient, type SqliteCallHandler } from "@/index/sqlite/client";
import { MutableSqliteDatabase } from "@/index/sqlite/database";
import { sqliteError } from "@/index/sqlite/protocol";

interface TestStorage {
  snapshot?: Uint8Array;
}

interface OpenDatabase {
  readonly raw: any;
  readonly database: MutableSqliteDatabase;
}

const storage = new WeakMap<object, TestStorage>();
let runtimePromise: Promise<any> | undefined;

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

/** Test-only RPC adapter backed by the same generated SQLite WASM database as production. */
export function createTestSqliteClient(
  identity: object = {},
  options: { readonly persistMutations?: boolean } = {}
): SqliteWorkerClient {
  const durable = storage.get(identity) ?? {};
  storage.set(identity, durable);
  let openedPromise: Promise<OpenDatabase> | undefined;
  const current = () => (openedPromise ??= open(durable.snapshot));
  const persist = async (opened: OpenDatabase) => {
    durable.snapshot = await serialized(opened);
  };
  const handler: SqliteCallHandler = async (method, payload, signal) => {
    if (signal?.aborted) throw sqliteError("cancelled", "Request cancelled", true);
    let opened = await current();
    const value = payload as any;
    let result: unknown;
    switch (method) {
      case "boot":
        result = opened.database.boot(
          value.corpusFingerprint ?? value.fingerprint,
          value.dimensions,
          value.embeddingFingerprint ?? "",
          value.buildIdentity
        );
        break;
      case "getState":
        return opened.database.getState();
      case "listNotes":
        return opened.database.listNotes();
      case "planReconciliation":
        return opened.database.planReconciliation(value.summaries);
      case "markIncomplete":
        result = opened.database.markIncomplete();
        break;
      case "beginRebuild":
        result = opened.database.beginRebuild();
        break;
      case "upsertNote":
        result = opened.database.upsertNote(value.note);
        break;
      case "renameNote":
        result = opened.database.renameNote(value.from, value.to, value.contentId);
        break;
      case "deleteNote":
        result = opened.database.deleteNote(value.path, value.contentId);
        break;
      case "finishReconciliation":
        result = opened.database.finishReconciliation(value.summaries, value.observedChangeCounter);
        break;
      case "listMissingVectors":
        return opened.database.listMissingVectors(
          value.embeddingFingerprint ?? opened.database.getState().embeddingFingerprint,
          value.limit,
          value.afterChunkPk
        );
      case "storeVectors":
        result = opened.database.storeVectors(
          value.vectors,
          value.embeddingFingerprint,
          value.observedChangeCounter
        );
        break;
      case "retrieve":
        return opened.database.retrieve(value.query, value.vector, value.limit, value.currentPath, {
          semanticCandidateLimit: value.semanticCandidateLimit,
          lexicalCandidateLimit: value.lexicalCandidateLimit,
          lexicalProfile: value.lexicalProfile,
          resultShape: value.resultShape,
        });
      case "findRelated":
        return opened.database.findRelated(value.path, value.vector, value.limit);
      case "finalizePublication":
        result = opened.database.finalizePublication(
          value.publicationId,
          value.expectedChangeCounter
        );
        break;
      case "preparePublication": {
        const state = opened.database.getState();
        const candidate = await open(await serialized(opened));
        try {
          candidate.database.boot(
            state.corpusFingerprint,
            state.dimensions,
            state.embeddingFingerprint,
            state.buildIdentity
          );
          candidate.database.setPublicationId(value.publicationId);
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
        }
        break;
      }
      case "inspectPublication": {
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
        }
        break;
      }
      case "adoptPublication": {
        const prior = opened.database.getState();
        const candidate = await open(new Uint8Array(value.bytes));
        try {
          candidate.database.validateSnapshot(
            prior.corpusFingerprint,
            prior.dimensions,
            prior.embeddingFingerprint,
            prior.buildIdentity
          );
          const candidateState = candidate.database.getState();
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
      case "export": {
        const state = opened.database.getState();
        opened.database.validateSnapshot(state.fingerprint, state.dimensions);
        return (await serialized(opened)).slice().buffer;
      }
      case "import": {
        const prior = opened.database.getState();
        const candidate = await open(new Uint8Array(value.bytes));
        try {
          candidate.database.validateSnapshot(prior.fingerprint, prior.dimensions);
        } catch (error) {
          candidate.database.close();
          throw error;
        }
        opened.database.close();
        opened = candidate;
        openedPromise = Promise.resolve(candidate);
        result = candidate.database.markImported(prior.changeCounter);
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
  };
  return new SqliteWorkerClient(undefined, handler);
}
