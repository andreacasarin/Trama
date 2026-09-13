export interface WorkerStorageState<Database extends { close(): void }, Connection, Pool> {
  database?: Database;
  connection?: Connection;
  opfsPool?: Pool;
}

/**
 * Clears the references before closing so a throwing close cannot leave a
 * closed database visible to the next Worker request.
 */
export function closeWorkerDatabase<Database extends { close(): void }, Connection, Pool>(
  state: WorkerStorageState<Database, Connection, Pool>
): void {
  const database = state.database;
  state.database = undefined;
  state.connection = undefined;
  database?.close();
}

export interface OpfsSAHPoolUtilLike {
  exportFile(name: string): Uint8Array | ArrayBuffer;
  importDb(name: string, bytes: Uint8Array | ArrayBuffer): number;
  unlink(name: string): boolean;
}

export function exportOpfsDatabase(pool: OpfsSAHPoolUtilLike, name: string): ArrayBuffer {
  const bytes = pool.exportFile(name);
  return bytes instanceof ArrayBuffer ? bytes.slice(0) : (bytes.slice().buffer as ArrayBuffer);
}
