import {
  createEmbeddingActionKey,
  createInputDigest,
  EMBEDDING_ACTION_OPTIONS,
  sha256Hex,
} from "@/index/Identity";
import { sqliteError } from "./protocol";
import { rows, transaction, vectorOf } from "./core";
import type { SqliteConnection } from "./core";

export const SQLITE_CACHE_SHARD_MAX_BYTES = 4_194_304;
const SQLITE_CACHE_SHARD_TARGET_BYTES = 3_500_000;
const SQLITE_CACHE_SHARD_APPLICATION_ID = 0x54524348;
const SQLITE_CACHE_SHARD_VERSION = 1;

export interface CacheShardPool {
  readonly OpfsSAHPoolDb: new (name: string, mode: string) => SqliteConnection;
  exportFile(name: string): Uint8Array | ArrayBuffer;
  importDb(name: string, bytes: Uint8Array | ArrayBuffer): number;
  unlink(name: string): boolean;
}

interface CacheRow {
  action_key: string;
  input_digest: string;
  serialized_input: string;
  embedding_fingerprint: string;
  preprocessing: string;
  vector: unknown;
  task_kind: string;
  created_at: number;
  model_id?: string;
  endpoint_origin?: string;
}

export interface CacheShardResult {
  readonly bytes: ArrayBuffer;
  readonly digest: string;
  readonly nextActionKey?: string;
  readonly rowCount: number;
  readonly taskKind?: "document" | "query";
  readonly profile: string;
  readonly actionKeys: readonly string[];
  readonly payloadBytes: number;
}

export interface CacheRetentionState {
  readonly lastCompactionAt: number;
  readonly expiredSourceDigests: readonly string[];
  readonly expiredRows: number;
}

export interface CacheRetirement {
  readonly sourceDigest: string;
  readonly replacementSetId: string;
  readonly retireAfter: number;
  readonly replacements: readonly string[];
}

function blobBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array)
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array();
}

const CACHE_SHARD_TABLES = {
  cache_shard_meta: `CREATE TABLE cache_shard_meta (
  id INTEGER PRIMARY KEY CHECK(id=1),
  profile TEXT NOT NULL,
  model_id TEXT NOT NULL,
  endpoint_origin TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  task_kind TEXT NOT NULL CHECK(task_kind IN ('document','query')),
  format_version INTEGER NOT NULL
) STRICT`,
  cache_vectors: `CREATE TABLE cache_vectors (
  action_key TEXT PRIMARY KEY COLLATE BINARY,
  input_digest TEXT NOT NULL,
  serialized_input TEXT NOT NULL,
  embedding_fingerprint TEXT NOT NULL,
  preprocessing TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  task_kind TEXT NOT NULL CHECK(task_kind IN ('document','query')),
  created_at INTEGER NOT NULL,
  vector BLOB NOT NULL
) STRICT`,
};

function cacheShardSql(): string {
  return `PRAGMA journal_mode=DELETE;
PRAGMA synchronous=FULL;
PRAGMA foreign_keys=ON;
PRAGMA application_id=${SQLITE_CACHE_SHARD_APPLICATION_ID};
PRAGMA user_version=${SQLITE_CACHE_SHARD_VERSION};
${CACHE_SHARD_TABLES.cache_shard_meta};
${CACHE_SHARD_TABLES.cache_vectors};
CREATE INDEX cache_vectors_profile ON cache_vectors(embedding_fingerprint,task_kind,action_key);`;
}

function validateCacheShardSchema(connection: SqliteConnection): void {
  const objects = rows(
    connection,
    "SELECT name,type,sql FROM sqlite_schema WHERE name IN ('cache_shard_meta','cache_vectors')"
  );
  for (const [name, sql] of Object.entries(CACHE_SHARD_TABLES)) {
    const object = objects.find((object) => object.name === name);
    // Accept only the tables this format writes, never views, virtual tables or
    // generated columns that could execute SQL while reading an incoming shard.
    if (object?.type !== "table" || object.sql !== sql)
      throw sqliteError("incompatible_state", "Cache shard schema is incompatible");
  }
}

function insertRows(
  connection: SqliteConnection,
  profile: string,
  dimensions: number,
  values: readonly CacheRow[],
  taskKind: "document" | "query"
): void {
  connection.exec({
    sql: "INSERT INTO cache_shard_meta(id,profile,model_id,endpoint_origin,dimensions,task_kind,format_version) VALUES(1,?,?,?,?,?,?)",
    bind: [
      profile,
      values[0]?.model_id ?? "",
      values[0]?.endpoint_origin ?? "",
      dimensions,
      taskKind,
      SQLITE_CACHE_SHARD_VERSION,
    ],
  });
  for (const row of values) {
    const vector = vectorOf(row.vector);
    if (vector.length !== dimensions || !vector.every(Number.isFinite))
      throw sqliteError("integrity_failed", "Cache shard vector dimensions or values are invalid");
    connection.exec({
      sql: "INSERT INTO cache_vectors(action_key,input_digest,serialized_input,embedding_fingerprint,preprocessing,dimensions,task_kind,created_at,vector) VALUES(?,?,?,?,?,?,?,?,?)",
      bind: [
        row.action_key,
        row.input_digest,
        row.serialized_input,
        profile,
        row.preprocessing,
        dimensions,
        taskKind,
        row.created_at,
        blobBytes(row.vector),
      ],
    });
  }
}

function exportCandidate(
  pool: CacheShardPool,
  name: string,
  profile: string,
  dimensions: number,
  values: readonly CacheRow[],
  taskKind: "document" | "query"
): ArrayBuffer {
  const candidate = new pool.OpfsSAHPoolDb(name, "c");
  try {
    candidate.exec(cacheShardSql());
    transaction(candidate, () => insertRows(candidate, profile, dimensions, values, taskKind));
    // The connection is quiescent and no transaction is open here. VACUUM INTO
    // is intentionally avoided until it is proven with the packaged SAH VFS.
    candidate.exec("VACUUM");
  } finally {
    candidate.close();
  }
  const bytes = pool.exportFile(name);
  return bytes instanceof ArrayBuffer ? bytes : (bytes.slice().buffer as ArrayBuffer);
}

function makeCandidate(
  pool: CacheShardPool,
  profile: string,
  dimensions: number,
  values: readonly CacheRow[],
  serial: { value: number },
  taskKind: "document" | "query"
): ArrayBuffer | undefined {
  const name = `/cache-shard-${serial.value++}`;
  try {
    const bytes = exportCandidate(pool, name, profile, dimensions, values, taskKind);
    if (bytes.byteLength <= SQLITE_CACHE_SHARD_MAX_BYTES) return bytes;
  } finally {
    pool.unlink(name);
  }
  return undefined;
}

/** Build one bounded cache-only artifact; source rows are paged by action key. */
export async function prepareCacheShard(
  source: SqliteConnection,
  pool: CacheShardPool,
  profile: string,
  dimensions: number,
  afterActionKey?: string,
  taskKind: "document" | "query" = "document",
  sourceDigests?: readonly string[],
  presentDigests?: readonly string[],
  maxPayloadBytes = SQLITE_CACHE_SHARD_TARGET_BYTES,
  now = Date.now()
): Promise<CacheShardResult | undefined> {
  let cursor = afterActionKey ?? "";
  const selected: CacheRow[] = [];
  let payloadBytes = 0;
  let done = false;
  const sourceFilter = sourceDigests?.length
    ? `AND EXISTS (SELECT 1 FROM cache_shard_membership m WHERE m.action_key=ec.action_key AND m.task_kind=ec.task_kind AND m.digest IN (${sourceDigests.map(() => "?").join(",")}))`
    : "";
  const inventoryFilter = sourceDigests?.length
    ? ""
    : presentDigests === undefined
      ? "AND NOT EXISTS (SELECT 1 FROM cache_shard_membership m WHERE m.action_key=ec.action_key AND m.task_kind=ec.task_kind)"
      : `AND (NOT EXISTS (SELECT 1 FROM cache_shard_membership m WHERE m.action_key=ec.action_key AND m.task_kind=ec.task_kind)
       OR (NOT EXISTS (SELECT 1 FROM cache_shard_membership m WHERE m.action_key=ec.action_key AND m.task_kind=ec.task_kind
             AND m.digest IN (SELECT value FROM json_each(?)))
           AND ${
             taskKind === "document"
               ? `EXISTS (SELECT 1 FROM chunk_occurrences o JOIN notes n ON n.note_id=o.note_id
                   WHERE o.embedding_input_digest=ec.input_digest
                     AND (n.lexical_revision_id=o.revision_id OR n.semantic_revision_id=o.revision_id))`
               : "ec.created_at>=?"
           }))`;
  const retentionFilter =
    taskKind === "document"
      ? sourceDigests?.length
        ? "AND (ec.unused_since IS NULL OR ec.unused_since>?)"
        : "AND (ec.unused_since IS NULL OR ec.unused_since>?)"
      : `AND ec.created_at>=?
         AND ec.cache_id IN (SELECT cache_id FROM embedding_cache q WHERE q.task_kind='query'
           AND q.embedding_fingerprint=? AND q.created_at>=?
           ORDER BY q.created_at DESC,q.action_key COLLATE BINARY ASC LIMIT 1000)`;
  while (!done && payloadBytes < maxPayloadBytes) {
    const bindings: unknown[] = [profile, cursor, taskKind];
    if (sourceDigests?.length) bindings.push(...sourceDigests);
    else if (presentDigests !== undefined) {
      bindings.push(JSON.stringify(presentDigests));
      if (taskKind === "query") bindings.push(now - 30 * 24 * 60 * 60 * 1000);
    }
    if (taskKind === "document") bindings.push(now - 30 * 24 * 60 * 60 * 1000);
    else bindings.push(now - 30 * 24 * 60 * 60 * 1000, profile, now - 30 * 24 * 60 * 60 * 1000);
    const page = rows(
      source,
      `SELECT ec.action_key,ec.input_digest,ei.serialized_input,ec.embedding_fingerprint,
        ec.preprocessing,ec.vector,ec.task_kind,ec.created_at,p.model_id,p.endpoint_origin
      FROM embedding_cache ec JOIN embedding_inputs ei ON ei.action_key=ec.input_digest
      LEFT JOIN embedding_profiles p ON p.fingerprint=ec.embedding_fingerprint
      WHERE ec.embedding_fingerprint=? AND ec.action_key>? AND ec.task_kind=? ${sourceFilter} ${inventoryFilter} ${retentionFilter}
      ORDER BY ec.action_key LIMIT 128`,
      bindings
    );
    if (!page.length) break;
    done = page.length < 128;
    for (const row of page) {
      const value = row as unknown as CacheRow;
      const bytes =
        new TextEncoder().encode(value.serialized_input).byteLength +
        blobBytes(value.vector).byteLength +
        256;
      if (selected.length && payloadBytes + bytes > maxPayloadBytes) {
        done = true;
        break;
      }
      selected.push(value);
      payloadBytes += bytes;
      cursor = value.action_key;
      if (payloadBytes >= maxPayloadBytes) {
        done = false;
        break;
      }
    }
  }
  if (!selected.length) return undefined;
  let count = selected.length;
  let bytes: ArrayBuffer | undefined;
  while (count > 0 && !bytes) {
    bytes = makeCandidate(
      pool,
      profile,
      dimensions,
      selected.slice(0, count),
      { value: 0 },
      taskKind
    );
    if (!bytes) count = Math.floor(count / 2);
  }
  if (!bytes)
    throw sqliteError("invalid_request", "A single cache entry exceeds the shard size limit");
  const included = selected[count - 1];
  return {
    bytes,
    digest: await sha256Hex(bytes),
    nextActionKey: included.action_key,
    rowCount: count,
    taskKind,
    profile,
    actionKeys: selected.slice(0, count).map((row) => row.action_key),
    payloadBytes: selected
      .slice(0, count)
      .reduce(
        (total, row) =>
          total +
          new TextEncoder().encode(row.serialized_input).byteLength +
          blobBytes(row.vector).byteLength +
          256,
        0
      ),
  };
}

/** Validate one received shard, then merge its vector rows and receipt atomically. */
export async function ingestCacheShard(
  target: SqliteConnection,
  pool: CacheShardPool,
  bytes: ArrayBuffer,
  expectedDigest: string,
  dimensions: number,
  activeProfile: string
): Promise<{
  readonly imported: number;
  readonly duplicate: boolean;
  readonly ignored?: boolean;
  readonly profile: string;
  readonly taskKind: "document" | "query";
}> {
  if (bytes.byteLength === 0 || bytes.byteLength > SQLITE_CACHE_SHARD_MAX_BYTES)
    throw sqliteError("invalid_request", "Cache shard size is invalid");
  const digest = await sha256Hex(bytes);
  if (digest !== expectedDigest)
    throw sqliteError("integrity_failed", "Cache shard digest mismatch");
  const receipt = rows(
    target,
    "SELECT digest,profile FROM cache_artifact_receipts WHERE digest=?",
    [digest]
  )[0];
  const duplicate = Boolean(receipt);
  if (receipt && (!activeProfile || receipt.profile === activeProfile)) {
    const membership = rows(
      target,
      "SELECT DISTINCT task_kind,profile FROM cache_shard_membership WHERE digest=? LIMIT 2",
      [digest]
    );
    if (
      membership.length === 1 &&
      String(membership[0].profile) === String(receipt.profile) &&
      (membership[0].task_kind === "document" || membership[0].task_kind === "query")
    )
      return {
        imported: 0,
        duplicate: true,
        profile: String(receipt.profile),
        taskKind: membership[0].task_kind,
      };
  }
  const name = `/cache-import-${digest.slice(0, 16)}`;
  let candidate: SqliteConnection | undefined;
  try {
    pool.importDb(name, bytes);
    candidate = new pool.OpfsSAHPoolDb(name, "c");
    const app = Number(rows(candidate, "PRAGMA application_id")[0]?.application_id ?? 0);
    const version = Number(rows(candidate, "PRAGMA user_version")[0]?.user_version ?? 0);
    if (app !== SQLITE_CACHE_SHARD_APPLICATION_ID || version !== SQLITE_CACHE_SHARD_VERSION)
      throw sqliteError("incompatible_state", "Cache shard format is incompatible");
    candidate.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;");
    validateCacheShardSchema(candidate);
    const meta = rows(candidate, "SELECT * FROM cache_shard_meta WHERE id=1")[0];
    if (
      !meta ||
      Number(meta.format_version) !== SQLITE_CACHE_SHARD_VERSION ||
      !/^[0-9a-f]{64}$/i.test(String(meta.profile)) ||
      !Number.isSafeInteger(Number(meta.dimensions)) ||
      Number(meta.dimensions) < 1 ||
      (meta.task_kind !== "document" && meta.task_kind !== "query") ||
      typeof meta.model_id !== "string" ||
      meta.model_id.length > 256 ||
      typeof meta.endpoint_origin !== "string" ||
      meta.endpoint_origin.length > 512 ||
      (meta.endpoint_origin !== "" && !/^https?:\/\/[^/?#@]+$/i.test(meta.endpoint_origin))
    )
      throw sqliteError("incompatible_state", "Cache shard profile is incompatible");
    if (
      activeProfile &&
      (String(meta.profile) !== activeProfile || Number(meta.dimensions) !== dimensions)
    ) {
      target.exec({
        sql: "INSERT OR IGNORE INTO cache_artifact_receipts(digest,profile,received_at) VALUES(?,?,?)",
        bind: [digest, String(meta.profile), Date.now()],
      });
      return {
        imported: 0,
        duplicate: false,
        ignored: true,
        profile: String(meta.profile),
        taskKind: meta.task_kind as "document" | "query",
      };
    }
    const imported = rows(candidate, "SELECT * FROM cache_vectors ORDER BY action_key");
    for (const row of imported) {
      const vector = vectorOf(row.vector);
      let key: { exactInput?: unknown; embeddingFingerprint?: unknown; preprocessing?: unknown };
      try {
        key = JSON.parse(String(row.action_key));
      } catch {
        throw sqliteError("integrity_failed", "Cache shard action key is invalid");
      }
      const serializedInput = String(row.serialized_input);
      const inputDigest = String(row.input_digest);
      const embeddingFingerprint = String(row.embedding_fingerprint);
      const preprocessing = String(row.preprocessing);
      const expectedInputDigest =
        String(row.task_kind) === "query"
          ? await sha256Hex(serializedInput)
          : await createInputDigest(serializedInput);
      const expectedActionKey = createEmbeddingActionKey(
        inputDigest,
        embeddingFingerprint,
        preprocessing,
        String(row.task_kind) === "query"
          ? { ...EMBEDDING_ACTION_OPTIONS, taskKind: "query" }
          : EMBEDDING_ACTION_OPTIONS
      );
      let norm = 0;
      for (const value of vector) norm += value * value;
      if (
        !/^[0-9a-f]{64}$/i.test(String(row.embedding_fingerprint)) ||
        String(meta.profile) !== embeddingFingerprint ||
        Number(row.dimensions) !== Number(meta.dimensions) ||
        String(row.task_kind) !== String(meta.task_kind) ||
        !String(row.action_key) ||
        !String(row.preprocessing) ||
        !String(row.serialized_input) ||
        inputDigest !== expectedInputDigest ||
        String(row.action_key) !== expectedActionKey ||
        key.exactInput !== inputDigest ||
        key.embeddingFingerprint !== embeddingFingerprint ||
        key.preprocessing !== preprocessing ||
        vector.length !== Number(meta.dimensions) ||
        !vector.every(Number.isFinite) ||
        !(norm > 0) ||
        Math.abs(norm - 1) > 1e-3
      )
        throw sqliteError("integrity_failed", "Cache shard row validation failed");
    }
    transaction(target, () => {
      target.exec({
        sql: "INSERT INTO embedding_profiles(fingerprint,dimensions,model_id,endpoint_origin) VALUES(?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET model_id=CASE WHEN excluded.model_id='' THEN embedding_profiles.model_id ELSE excluded.model_id END,endpoint_origin=CASE WHEN excluded.endpoint_origin='' THEN embedding_profiles.endpoint_origin ELSE excluded.endpoint_origin END",
        bind: [meta.profile, meta.dimensions, meta.model_id, meta.endpoint_origin],
      });
      for (const row of imported) {
        const existingInput = rows(
          target,
          "SELECT serialized_input FROM embedding_inputs WHERE action_key=?",
          [row.input_digest]
        )[0];
        if (
          existingInput &&
          String(existingInput.serialized_input) !== String(row.serialized_input)
        )
          throw sqliteError(
            "integrity_failed",
            "Cache shard input digest conflicts with local input"
          );
        target.exec({
          sql: "INSERT INTO embedding_inputs(embedding_fingerprint,serialized_input,preprocessing,action_key) VALUES(?,?,?,?) ON CONFLICT(action_key) DO NOTHING",
          bind: [
            row.embedding_fingerprint,
            row.serialized_input,
            row.preprocessing,
            row.input_digest,
          ],
        });
        target.exec({
          sql: `INSERT INTO embedding_cache(input_digest,action_key,embedding_fingerprint,preprocessing,vector,task_kind,created_at,unused_since)
            VALUES(?,?,?,?,?,?,?,CASE WHEN EXISTS (
              SELECT 1 FROM chunk_occurrences o JOIN notes n ON n.note_id=o.note_id
              WHERE o.embedding_input_digest=? AND (n.lexical_revision_id=o.revision_id OR n.semantic_revision_id=o.revision_id)
            ) THEN NULL ELSE ? END) ON CONFLICT(action_key) DO NOTHING`,
          bind: [
            row.input_digest,
            row.action_key,
            row.embedding_fingerprint,
            row.preprocessing,
            blobBytes(row.vector),
            row.task_kind,
            row.created_at,
            row.input_digest,
            Date.now(),
          ],
        });
        target.exec({
          sql: "INSERT OR IGNORE INTO cache_shard_membership(digest,action_key,task_kind,profile) VALUES(?,?,?,?)",
          bind: [digest, row.action_key, row.task_kind, meta.profile],
        });
      }
      target.exec({
        sql: "INSERT OR IGNORE INTO cache_artifact_receipts(digest,profile,received_at) VALUES(?,?,?)",
        bind: [digest, meta.profile, Date.now()],
      });
    });
    return {
      imported: duplicate ? 0 : imported.length,
      duplicate,
      profile: String(meta.profile),
      taskKind: meta.task_kind as "document" | "query",
    };
  } finally {
    candidate?.close();
    pool.unlink(name);
  }
}
