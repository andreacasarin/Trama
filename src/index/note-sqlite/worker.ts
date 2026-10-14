import { NoteSqliteDatabase, type SqliteEmbeddingShardPool } from "./database";
import type { NoteStoreInit, NoteStoreMethod, NoteStoreRpc, SqliteConnection } from "./protocol";

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
  close(): void;
}

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

async function open(namespace: string): Promise<OpenDatabase> {
  const assets = (globalThis as any).__TRAMA_SQLITE_ASSETS__ as
    { moduleUrl?: string; wasmUrl?: string } | undefined;
  const wasmUrl = assets?.wasmUrl ?? new URL("./sqlite3.wasm", import.meta.url).href;
  const moduleUrl = assets?.moduleUrl ?? new URL("./sqlite3.mjs", import.meta.url).href;
  const response = await fetch(wasmUrl, { credentials: "same-origin" });
  if (!response.ok) throw new Error("SQLite WASM asset could not be loaded");
  const wasm = await response.arrayBuffer();
  (globalThis as any).sqlite3ApiConfig = {
    disable: { vfs: { kvvfs: true, opfs: true, "opfs-wl": true } },
  };
  const init = (await import(moduleUrl)).default as Init;
  const sqlite = await init({
    instantiateWasm(imports, onSuccess) {
      WebAssembly.instantiate(wasm, imports).then(({ instance, module }) =>
        onSuccess(instance, module)
      );
      return {};
    },
  });
  const directory = `trama-note-v2-${namespace}`;
  const pool = await sqlite.installOpfsSAHPoolVfs({
    name: directory,
    directory,
    initialCapacity: 8,
  });
  await pool.reserveMinimumCapacity(8);
  const connection = new pool.OpfsSAHPoolDb("/notes.sqlite3", "c");
  const shardPool: SqliteEmbeddingShardPool = {
    vfsName: pool.vfsName,
    mainPath: "/notes.sqlite3",
    openDatabase: (path, mode) => new pool.OpfsSAHPoolDb(path, mode),
    exportFile: (path) => pool.exportFile(path),
    importDb: (path, bytes) => pool.importDb(path, bytes),
    unlink: (path) => pool.unlink(path),
  };
  return {
    database: new NoteSqliteDatabase(connection, shardPool),
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

export function attachNoteStoreWorker(
  scope: WorkerScope,
  openDatabase: (namespace: string) => Promise<OpenDatabase>
): void {
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
            const requested = (payload as NoteStoreInit | undefined)?.namespace;
            if (typeof requested !== "string" || !/^[0-9a-f]{64}$/.test(requested))
              throw new TypeError("Invalid vault storage namespace");
            if (closed) throw new Error("Note store worker is closed");
            if (namespace && requested !== namespace)
              throw new Error("Note store worker cannot change vault namespace");
            if (!database) {
              namespace ??= requested;
              const opened = await openDatabase(requested);
              if (closed) {
                opened.close();
                throw new Error("Note store worker is closed");
              }
              database = opened;
            }
            scope.postMessage({ id, ok: true, result: undefined });
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
