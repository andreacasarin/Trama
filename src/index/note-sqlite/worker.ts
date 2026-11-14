import { NoteSqliteDatabase, type SqliteEmbeddingShardPool } from "./database";
import type {
  NoteStoreInit,
  NoteStoreInitTimings,
  NoteStoreMethod,
  NoteStoreRpc,
  SqliteConnection,
} from "./protocol";

type Sqlite = {
  installOpfsSAHPoolVfs(options: {
    name: string;
    directory: string;
    initialCapacity: number;
  }): Promise<{
    OpfsSAHPoolDb: new (name: string, mode: string) => SqliteConnection;
    readonly vfsName: string;
    reserveMinimumCapacity(capacity: number): Promise<void>;
    exportFile(path: string): Uint8Array;
    importDb(path: string, bytes: Uint8Array): void;
    unlink(path: string): void;
    pauseVfs(): unknown;
  }>;
};
type Init = (options: {
  instantiateWasm(
    imports: WebAssembly.Imports,
    onSuccess: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
  ): object;
}) => Promise<Sqlite>;

interface OpenDatabase {
  readonly database: Pick<NoteSqliteDatabase, "call">;
  readonly timings?: NoteStoreInitTimings;
  close(): void;
}

type OpenDatabaseFactory = (namespace: string, diagnostics: boolean) => Promise<OpenDatabase>;

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

interface WorkerRequest {
  readonly id: number;
  readonly method: string;
  readonly payload: unknown;
}

async function open(namespace: string, diagnostics: boolean): Promise<OpenDatabase> {
  const timings: NoteStoreInitTimings = {};
  let startedAt = diagnostics ? performance.now() : undefined;
  // esbuild lowers this literal require to a lazy bundled initializer without a namespace wrapper.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- esbuild embeds this literal WASM require as a lazy binary initializer.
  const bytes = require("../../../vendor/sqlite-wasm/sqlite3.wasm") as Uint8Array<ArrayBuffer>;
  const loadedAt = startedAt !== undefined ? performance.now() : undefined;
  (globalThis as any).sqlite3ApiConfig = {
    disable: { vfs: { kvvfs: true, opfs: true, "opfs-wl": true } },
  };
  const compileStarted = diagnostics ? performance.now() : undefined;
  const compiling = WebAssembly.compile(bytes).then((module) => {
    if (startedAt !== undefined && loadedAt !== undefined && compileStarted !== undefined) {
      const compiledAt = performance.now();
      timings["wasm-load-compile"] = Math.round(compiledAt - startedAt);
      timings["wasm-load"] = Math.round(loadedAt - startedAt);
      timings["wasm-compile"] = Math.round(compiledAt - compileStarted);
    }
    return module;
  });
  const glueStarted = diagnostics ? performance.now() : undefined;
  const loadingGlue: Promise<{ default: unknown }> =
    // @ts-expect-error The pinned generated SQLite module has no TypeScript declarations.
    import("../../../vendor/sqlite-wasm/sqlite3.mjs").then((module) => {
      if (glueStarted !== undefined) timings["sqlite-bootstrap"] = performance.now() - glueStarted;
      return module;
    });
  const [wasm, { default: sqliteInit }] = await Promise.all([compiling, loadingGlue]);
  const init = sqliteInit as Init;
  const initStarted = diagnostics ? performance.now() : undefined;
  const sqlite = await init({
    instantiateWasm(imports, onSuccess) {
      const instance = new WebAssembly.Instance(wasm, imports);
      onSuccess(instance, wasm);
      return instance.exports;
    },
  });
  if (initStarted !== undefined) {
    timings["sqlite-bootstrap"] = Math.round(
      (timings["sqlite-bootstrap"] ?? 0) + performance.now() - initStarted
    );
    startedAt = performance.now();
  }
  const directory = `trama-note-v2-${namespace}`;
  const pool = await sqlite.installOpfsSAHPoolVfs({
    name: directory,
    directory,
    initialCapacity: 8,
  });
  if (startedAt !== undefined) {
    timings["opfs-install"] = Math.round(performance.now() - startedAt);
    startedAt = performance.now();
  }
  await pool.reserveMinimumCapacity(8);
  if (startedAt !== undefined) {
    timings["opfs-reserve"] = Math.round(performance.now() - startedAt);
    startedAt = performance.now();
  }
  const connection = new pool.OpfsSAHPoolDb("/notes.sqlite3", "c");
  if (startedAt !== undefined) {
    timings["db-open"] = Math.round(performance.now() - startedAt);
    startedAt = performance.now();
  }
  const shardPool: SqliteEmbeddingShardPool = {
    vfsName: pool.vfsName,
    mainPath: "/notes.sqlite3",
    openDatabase: (path, mode) => new pool.OpfsSAHPoolDb(path, mode),
    exportFile: (path) => pool.exportFile(path),
    importDb: (path, bytes) => pool.importDb(path, bytes),
    unlink: (path) => pool.unlink(path),
  };
  const database = new NoteSqliteDatabase(connection, shardPool);
  if (startedAt !== undefined) timings["schema-setup"] = Math.round(performance.now() - startedAt);
  return {
    database,
    ...(diagnostics ? { timings } : {}),
    close() {
      try {
        connection.close();
      } finally {
        pool.pauseVfs();
      }
    },
  };
}

function serializedError(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name.slice(0, 80) : "Error";
  const message = error instanceof Error ? error.message : "Note store request failed";
  return { name, message: message.slice(0, 1000) };
}

export function attachNoteStoreWorker(scope: WorkerScope, openDatabase: OpenDatabaseFactory): void {
  const cancelled = new Map<number, AbortController>();
  let database: OpenDatabase | undefined;
  let namespace: string | undefined;
  let closed = false;
  let closeQueued = false;
  let queue = Promise.resolve();

  scope.onmessage = (event) => {
    const { id, method, payload } = event.data;
    if (method === "cancel") {
      const requestId = (payload as { requestId?: number } | undefined)?.requestId;
      if (typeof requestId === "number") cancelled.get(requestId)?.abort();
      return;
    }

    if (closeQueued && method !== "close" && method !== "init") {
      scope.postMessage({
        id,
        ok: false,
        error: { name: "Error", message: "Note store worker is closing" },
      });
      return;
    }

    if (method === "close") closeQueued = true;
    const controller = method === "init" || method === "close" ? undefined : new AbortController();
    if (controller) cancelled.set(id, controller);
    queue = queue
      .then(async () => {
        if (method === "close") {
          closed = true;
          try {
            database?.close();
            scope.postMessage({ id, ok: true, result: undefined });
          } catch (error) {
            scope.postMessage({ id, ok: false, error: serializedError(error) });
          } finally {
            scope.close();
          }
          return;
        }
        try {
          if (method === "init") {
            const initPayload = payload as NoteStoreInit | undefined;
            const requested = initPayload?.namespace;
            const diagnostics = initPayload?.diagnostics === true;
            if (typeof requested !== "string" || !/^[0-9a-f]{64}$/.test(requested))
              throw new TypeError("Invalid vault storage namespace");
            if (closed) throw new Error("Note store worker is closed");
            if (namespace && requested !== namespace)
              throw new Error("Note store worker cannot change vault namespace");
            let timings: NoteStoreInitTimings | undefined;
            if (!database) {
              namespace ??= requested;
              const opened = await openDatabase(requested, diagnostics);
              if (closed) {
                opened.close();
                throw new Error("Note store worker is closed");
              }
              database = opened;
              if (diagnostics) timings = opened.timings;
            }
            scope.postMessage({
              id,
              ok: true,
              result: timings ? { timings } : undefined,
            });
            return;
          }
          if (closed) throw new Error("Note store worker is closed");
          if (!database || !namespace) throw new Error("Note store worker is not initialized");
          const result = await database.database.call(
            method as NoteStoreMethod,
            payload as NoteStoreRpc[NoteStoreMethod],
            controller?.signal
          );
          scope.postMessage({ id, ok: true, result });
        } catch (error) {
          scope.postMessage({ id, ok: false, error: serializedError(error) });
        } finally {
          cancelled.delete(id);
        }
      })
      .catch(() => undefined);
  };
}

if (typeof self !== "undefined") attachNoteStoreWorker(self as unknown as WorkerScope, open);
