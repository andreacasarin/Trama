import { sqliteError, type SqliteGenerationToken } from "./protocol";

export interface SqliteConnection {
  exec(
    options:
      | string
      | {
          readonly sql: string;
          readonly bind?: readonly unknown[];
          readonly rowMode?: "object";
          readonly callback?: (row: Record<string, unknown>) => void;
        }
  ): void;
  close(): void;
}

export const APP_VERSION = "trama";
export const EXTRACTION_VERSION = 1;
export const CHUNK_ALGORITHM_VERSION = 2;
export const EMBEDDING_PREPROCESSING_VERSION = "normalized-float32-v1";
/** Float32 round-off from normalizedVector is well below this bound. */
export const SQLITE_VECTOR_NORMALIZATION_TOLERANCE = 1e-3;

export class SqliteContext {
  dimensions = 0;
  embeddingFingerprint = "";
  closed = false;

  constructor(readonly db: SqliteConnection) {}

  ensureOpen(): void {
    if (this.closed) throw sqliteError("storage_unavailable", "Database is closed");
  }
}

export function rows(
  db: SqliteConnection,
  sql: string,
  bind: readonly unknown[] = []
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  db.exec({ sql, bind, rowMode: "object", callback: (row) => result.push(row) });
  return result;
}

export function transaction(db: SqliteConnection, body: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    body();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* preserve original */
    }
    throw error;
  }
}

export function normalizedVector(vector: Float32Array, dimensions: number): Float32Array {
  if (vector.length !== dimensions || !vector.every(Number.isFinite))
    throw sqliteError("invalid_request", "Vector dimensions or values are invalid");
  let norm = 0;
  for (const x of vector) norm += x * x;
  if (!(norm > 0) || !Number.isFinite(norm))
    throw sqliteError("invalid_request", "Vector must have non-zero magnitude");
  const out = new Float32Array(dimensions);
  const scale = 1 / Math.sqrt(norm);
  for (let i = 0; i < dimensions; i++) out[i] = vector[i] * scale;
  return out;
}

export function vectorBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength)
  );
}

export function vectorOf(value: unknown): Float32Array {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : value instanceof Uint8Array
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array();
  if (!bytes.byteLength || bytes.byteLength % 4)
    throw sqliteError("integrity_failed", "Stored vector bytes are invalid");
  return new Float32Array(bytes.slice().buffer);
}

export function readChangeCounter(context: SqliteContext): number {
  const row = rows(context.db, "SELECT change_counter FROM index_state WHERE id=1")[0];
  if (!row) throw sqliteError("incompatible_state", "SQLite state is not initialized");
  return Number(row.change_counter);
}

export function readGenerationToken(
  context: SqliteContext,
  db = context.db
): SqliteGenerationToken {
  const row = rows(
    db,
    "SELECT change_counter AS changeCounter,lexical_generation AS lexicalGeneration,semantic_generation AS semanticGeneration FROM index_state WHERE id=1"
  )[0];
  if (!row) throw sqliteError("incompatible_state", "SQLite state is not initialized");
  return {
    changeCounter: Number(row.changeCounter),
    lexicalGeneration: Number(row.lexicalGeneration),
    semanticGeneration: Number(row.semanticGeneration),
  };
}
