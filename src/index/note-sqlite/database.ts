import {
  EMBEDDING_ARTIFACT_MAX_ENTRIES,
  EMBEDDING_ARTIFACT_MAX_FILE_BYTES,
  EMBEDDING_ARTIFACT_MAX_VECTOR_BYTES,
} from "./protocol";
import type {
  NoteStoreHit,
  NoteStoreHybridResult,
  NoteStoreRelatedResult,
  NoteStoreRpc,
  NoteStoreMethod,
  SqliteConnection,
  SqliteEmbeddingShard,
} from "./protocol";

type Row = Record<string, unknown>;
const SQLITE_SHARD_APPLICATION_ID = 0x54524d41;

async function yieldSqlite(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  checkAbort(signal);
}

export interface SqliteEmbeddingShardPool {
  readonly vfsName: string;
  openDatabase(path: string, mode: "c" | "r"): SqliteConnection;
  exportFile(path: string): Uint8Array;
  importDb(path: string, bytes: Uint8Array): void;
  unlink(path: string): void;
  readonly mainPath: string;
}

const rows = (db: SqliteConnection, sql: string, bind: readonly unknown[] = []): Row[] => {
  const result: Row[] = [];
  db.exec({ sql, bind, rowMode: "object", callback: (row) => result.push(row) });
  return result;
};

const QUERY_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const QUERY_CACHE_LIMIT = 1000;

function validCacheScope(input: {
  profile: unknown;
  task: unknown;
  hashes?: unknown;
  now?: unknown;
}): asserts input is {
  profile: string;
  task: "document" | "query";
  hashes?: readonly string[];
  now?: number;
} {
  if (
    typeof input.profile !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.profile) ||
    (input.task !== "document" && input.task !== "query") ||
    (input.hashes !== undefined &&
      (!Array.isArray(input.hashes) ||
        input.hashes.length > 512 ||
        input.hashes.some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)))) ||
    (input.now !== undefined &&
      (typeof input.now !== "number" || !Number.isSafeInteger(input.now) || input.now < 0))
  )
    throw new TypeError("Invalid embedding cache request");
}

function validCacheVector(vector: Uint8Array, dimensions: number): boolean {
  if (!(vector instanceof Uint8Array) || vector.byteLength !== dimensions * 4) return false;
  const view = new DataView(vector.buffer, vector.byteOffset, vector.byteLength);
  for (let index = 0; index < dimensions; index++) {
    if (!Number.isFinite(view.getFloat32(index * 4, true))) return false;
  }
  return true;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
}

function validPath(path: unknown): asserts path is string {
  if (typeof path !== "string" || path.length === 0)
    throw new TypeError("A non-empty note path is required");
}

function validKeys(keys: unknown): asserts keys is readonly string[] {
  if (!Array.isArray(keys) || keys.length > 1000 || keys.some((key) => typeof key !== "string"))
    throw new TypeError("Invalid record keys");
}

function vectorBytes(values: readonly number[], dimensions?: number): Uint8Array {
  if (!Array.isArray(values) || values.length === 0 || (dimensions && values.length !== dimensions))
    throw new TypeError("Vector dimensions are invalid");
  let norm = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new TypeError("Vector values must be finite");
    norm += value * value;
  }
  if (!Number.isFinite(norm) || norm === 0) throw new TypeError("Vector magnitude is invalid");
  const output = new Float32Array(values.length);
  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < values.length; index++) output[index] = values[index] * scale;
  return new Uint8Array(output.buffer);
}

function ftsTerms(query: string): string {
  return (query.match(/[\p{L}\p{N}_]+/gu) ?? [])
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" AND ");
}

export class NoteSqliteDatabase {
  constructor(
    private readonly db: SqliteConnection,
    private readonly shardPool?: SqliteEmbeddingShardPool
  ) {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(`CREATE TABLE IF NOT EXISTS note_index(
      note_id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      current_uid TEXT NOT NULL UNIQUE,
      embedding_profile TEXT,
      centroid BLOB
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS note_vectors(
      note_id INTEGER NOT NULL REFERENCES note_index(note_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK(ordinal>=0),
      vector BLOB NOT NULL,
      PRIMARY KEY(note_id,ordinal)
    )`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
      body,path_text,content='',contentless_delete=1,
      tokenize='unicode61 remove_diacritics 2'
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS note_records(
      uid TEXT PRIMARY KEY,
      group_path TEXT,
      updated_at INTEGER NOT NULL
    ) WITHOUT ROWID`);
    db.exec(`CREATE TABLE IF NOT EXISTS note_record_clock(
      id INTEGER PRIMARY KEY CHECK(id=1),
      value INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS embedding_cache(
      cache_id INTEGER PRIMARY KEY,
      profile TEXT NOT NULL,
      task TEXT NOT NULL CHECK(task IN ('document','query')),
      hash TEXT NOT NULL CHECK(length(hash)=64),
      vector BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(profile,task,hash)
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS embedding_cache_query_age
      ON embedding_cache(profile,created_at DESC,hash DESC) WHERE task='query'`);
    db.exec(`CREATE TABLE IF NOT EXISTS embedding_cache_sqlite_imports(
      profile TEXT NOT NULL,
      checksum TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      PRIMARY KEY(profile,checksum)
    ) WITHOUT ROWID`);
    db.exec(`CREATE TABLE IF NOT EXISTS embedding_cache_sqlite_publications(
      profile TEXT NOT NULL,
      hash TEXT NOT NULL,
      checksum TEXT NOT NULL,
      published_at INTEGER NOT NULL,
      PRIMARY KEY(profile,hash)
    ) WITHOUT ROWID`);
    db.exec("INSERT INTO note_record_clock(id,value) VALUES(1,0) ON CONFLICT(id) DO NOTHING");
  }

  async call<M extends NoteStoreMethod>(
    method: M,
    payload: NoteStoreRpc[M],
    signal?: AbortSignal
  ): Promise<unknown> {
    checkAbort(signal);
    switch (method) {
      case "embeddingCacheGet":
        return this.embeddingCacheGet(payload as NoteStoreRpc["embeddingCacheGet"], signal);
      case "embeddingCacheSet":
        return this.embeddingCacheSet(payload as NoteStoreRpc["embeddingCacheSet"], signal);
      case "embeddingCacheDelete":
        return this.embeddingCacheDelete(payload as NoteStoreRpc["embeddingCacheDelete"], signal);
      case "embeddingCacheKeys":
        return this.embeddingCacheKeys(payload as NoteStoreRpc["embeddingCacheKeys"], signal);
      case "embeddingCacheSqliteCheckArtifacts":
        return this.embeddingCacheSqliteCheckArtifacts(
          payload as NoteStoreRpc["embeddingCacheSqliteCheckArtifacts"],
          signal
        );
      case "embeddingCacheSqliteImport":
        return this.embeddingCacheSqliteImport(
          payload as NoteStoreRpc["embeddingCacheSqliteImport"],
          signal
        );
      case "embeddingCacheSqliteExport":
        return this.embeddingCacheSqliteExport(
          payload as NoteStoreRpc["embeddingCacheSqliteExport"],
          signal
        );
      case "embeddingCacheSqliteMarkPublished":
        return this.embeddingCacheSqliteMarkPublished(
          payload as NoteStoreRpc["embeddingCacheSqliteMarkPublished"],
          signal
        );
      case "noteStoreReplace":
        return this.replace(payload as NoteStoreRpc["noteStoreReplace"], signal);
      case "noteStoreDelete": {
        const { uids } = payload as NoteStoreRpc["noteStoreDelete"];
        validKeys(uids);
        this.db.exec("BEGIN IMMEDIATE");
        try {
          for (let index = 0; index < uids.length; index++) {
            const uid = uids[index];
            checkAbort(signal);
            const row = rows(this.db, "SELECT note_id FROM note_index WHERE current_uid=?", [
              uid,
            ])[0];
            if (row) {
              const id = Number(row.note_id);
              this.db.exec({ sql: "DELETE FROM note_fts WHERE rowid=?", bind: [id] });
              this.db.exec({
                sql: "DELETE FROM note_index WHERE note_id=? AND current_uid=?",
                bind: [id, uid],
              });
            }
            if ((index + 1) % 16 === 0 && index + 1 < uids.length) {
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              checkAbort(signal);
            }
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          checkAbort(signal);
          this.db.exec("COMMIT");
          return undefined;
        } catch (error) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            /* preserve original error */
          }
          throw error;
        }
      }
      case "noteStoreReset": {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          checkAbort(signal);
          this.db.exec("DELETE FROM note_fts");
          this.db.exec("DELETE FROM note_records");
          this.db.exec("UPDATE note_record_clock SET value=0 WHERE id=1");
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          checkAbort(signal);
          this.db.exec("DELETE FROM note_index");
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          checkAbort(signal);
          this.db.exec("COMMIT");
          return undefined;
        } catch (error) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            /* preserve original error */
          }
          throw error;
        }
      }
      case "noteStoreHasNotes":
        return Boolean(
          rows(this.db, "SELECT EXISTS(SELECT 1 FROM note_index LIMIT 1) AS present")[0]?.present
        );
      case "recordManagerGetTime":
        return this.reserveRecordTime();
      case "recordManagerUpdate":
        return this.updateRecords(payload as NoteStoreRpc["recordManagerUpdate"]);
      case "recordManagerExists":
        return this.recordExists(payload as NoteStoreRpc["recordManagerExists"]);
      case "recordManagerListKeys":
        return this.listRecordKeys(payload as NoteStoreRpc["recordManagerListKeys"]);
      case "recordManagerDeleteKeys":
        return this.deleteRecords(payload as NoteStoreRpc["recordManagerDeleteKeys"]);
      case "noteStoreSemantic": {
        const { vector, profile, k } = payload as NoteStoreRpc["noteStoreSemantic"];
        return (await this.hybridSearch({ vector, profile, k }, signal)).hits;
      }
      case "noteStoreHybrid":
        return this.hybridSearch(payload as NoteStoreRpc["noteStoreHybrid"], signal);
      case "noteStoreRelated":
        return this.related(payload as NoteStoreRpc["noteStoreRelated"], signal);
    }
  }

  private embeddingCacheGet(
    input: NoteStoreRpc["embeddingCacheGet"],
    signal?: AbortSignal
  ): (Uint8Array | undefined)[] {
    const { profile, task, hashes, now } = input;
    validCacheScope(input);
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid cache timestamp");
    if (!hashes.length) return [];
    if (task === "query") {
      this.db.exec({
        sql: "DELETE FROM embedding_cache WHERE profile=? AND task='query' AND created_at<?",
        bind: [profile, now - QUERY_CACHE_TTL],
      });
    }
    checkAbort(signal);
    const found = rows(
      this.db,
      `SELECT hash,vector FROM embedding_cache
       WHERE profile=? AND task=? AND hash IN (${hashes.map(() => "?").join(",")})`,
      [profile, task, ...hashes]
    );
    const values = new Map(found.map((row) => [String(row.hash), row.vector as Uint8Array]));
    return hashes.map((hash) => values.get(hash));
  }

  private embeddingCacheSet(input: NoteStoreRpc["embeddingCacheSet"], signal?: AbortSignal): void {
    const { profile, task, dimensions, entries, now } = input;
    validCacheScope(input);
    if (
      !Number.isSafeInteger(dimensions) ||
      dimensions < 1 ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Array.isArray(entries) ||
      entries.length > 512 ||
      entries.some(
        ({ hash, vector }) =>
          typeof hash !== "string" ||
          !/^[0-9a-f]{64}$/.test(hash) ||
          !validCacheVector(vector, dimensions)
      )
    )
      throw new TypeError("Invalid embedding cache values");
    checkAbort(signal);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const { hash, vector } of entries) {
        checkAbort(signal);
        this.db.exec({
          sql: `INSERT INTO embedding_cache(profile,task,hash,vector,created_at) VALUES(?,?,?,?,?)
            ON CONFLICT(profile,task,hash) DO UPDATE SET vector=excluded.vector,created_at=excluded.created_at`,
          bind: [profile, task, hash, vector, now],
        });
      }
      if (task === "query") {
        this.db.exec({
          sql: `DELETE FROM embedding_cache WHERE profile=? AND task='query' AND
            (created_at<? OR hash NOT IN (
              SELECT hash FROM embedding_cache WHERE profile=? AND task='query'
              ORDER BY created_at DESC,hash DESC LIMIT ?
            ))`,
          bind: [profile, now - QUERY_CACHE_TTL, profile, QUERY_CACHE_LIMIT],
        });
      }
      checkAbort(signal);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    }
  }

  private embeddingCacheDelete(
    input: NoteStoreRpc["embeddingCacheDelete"],
    signal?: AbortSignal
  ): void {
    const { profile, task, hashes } = input;
    validCacheScope(input);
    if (!hashes.length) return;
    checkAbort(signal);
    this.db.exec({
      sql: `DELETE FROM embedding_cache WHERE profile=? AND task=? AND hash IN (${hashes.map(() => "?").join(",")})`,
      bind: [profile, task, ...hashes],
    });
    checkAbort(signal);
  }

  private embeddingCacheKeys(
    input: NoteStoreRpc["embeddingCacheKeys"],
    signal?: AbortSignal
  ): string[] {
    const { profile, task, after, limit } = input;
    if (
      typeof profile !== "string" ||
      !/^[0-9a-f]{64}$/.test(profile) ||
      (task !== "document" && task !== "query") ||
      (after !== undefined && !/^[0-9a-f]{64}$/.test(after)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 512
    )
      throw new TypeError("Invalid embedding cache key page");
    checkAbort(signal);
    return rows(
      this.db,
      `SELECT hash FROM embedding_cache WHERE profile=? AND task=?${after ? " AND hash>?" : ""}
       ORDER BY hash COLLATE BINARY LIMIT ?`,
      after ? [profile, task, after, limit] : [profile, task, limit]
    ).map((row) => String(row.hash));
  }

  private embeddingCacheSqliteCheckArtifacts(
    input: NoteStoreRpc["embeddingCacheSqliteCheckArtifacts"],
    signal?: AbortSignal
  ): string[] {
    const { profile, checksums } = input;
    if (
      !/^[0-9a-f]{64}$/.test(profile) ||
      !Array.isArray(checksums) ||
      checksums.length > EMBEDDING_ARTIFACT_MAX_ENTRIES ||
      checksums.some((checksum) => typeof checksum !== "string" || !/^[0-9a-f]{64}$/.test(checksum))
    )
      throw new TypeError("Invalid SQLite shard receipt request");
    checkAbort(signal);
    if (!checksums.length) return [];
    const imported = new Set(
      rows(
        this.db,
        `SELECT checksum FROM embedding_cache_sqlite_imports
         WHERE profile=? AND checksum IN (${checksums.map(() => "?").join(",")})`,
        [profile, ...checksums]
      ).map((row) => String(row.checksum))
    );
    return checksums.filter((checksum) => !imported.has(checksum));
  }

  private async embeddingCacheSqliteExport(
    input: NoteStoreRpc["embeddingCacheSqliteExport"],
    signal?: AbortSignal
  ): Promise<SqliteEmbeddingShard | undefined> {
    const { profile, dimensions, limit } = input;
    const pool = this.requireShardPool();
    const maxByBytes = Math.floor(EMBEDDING_ARTIFACT_MAX_VECTOR_BYTES / (dimensions * 4));
    if (
      !/^[0-9a-f]{64}$/.test(profile) ||
      !Number.isSafeInteger(dimensions) ||
      dimensions < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > EMBEDDING_ARTIFACT_MAX_ENTRIES ||
      limit > maxByBytes
    )
      throw new TypeError("Invalid SQLite shard export request");

    const nonce = crypto.randomUUID();
    const scratchPath = `/embedding-shard-scratch-${nonce}.sqlite3`;
    const scratch = pool.openDatabase(scratchPath, "c");
    let attached = false;
    try {
      scratch.exec("PRAGMA trusted_schema=OFF");
      scratch.exec(`PRAGMA application_id=${SQLITE_SHARD_APPLICATION_ID}`);
      scratch.exec("PRAGMA user_version=1");
      scratch.exec(
        "CREATE TABLE metadata(profile TEXT NOT NULL,dimensions INTEGER NOT NULL,task TEXT NOT NULL)"
      );
      scratch.exec("CREATE TABLE vectors(hash TEXT NOT NULL UNIQUE,vector BLOB NOT NULL)");
      scratch.exec({
        sql: "INSERT INTO metadata(profile,dimensions,task) VALUES(?,?,'document')",
        bind: [profile, dimensions],
      });
      scratch.exec(`ATTACH DATABASE 'file:${pool.mainPath}?vfs=${pool.vfsName}&mode=ro' AS source`);
      attached = true;
      await yieldSqlite(signal);

      let batchLimit = limit;
      while (batchLimit > 0) {
        checkAbort(signal);
        scratch.exec("DELETE FROM vectors");
        scratch.exec({
          sql: `INSERT INTO vectors(hash,vector)
            SELECT e.hash,e.vector FROM source.embedding_cache e
            LEFT JOIN source.embedding_cache_sqlite_publications p
              ON p.profile=e.profile AND p.hash=e.hash
            WHERE e.profile=? AND e.task='document' AND p.hash IS NULL
            ORDER BY e.hash COLLATE BINARY LIMIT ?`,
          bind: [profile, batchLimit],
        });
        const hashes = rows(scratch, "SELECT hash FROM vectors ORDER BY hash COLLATE BINARY").map(
          (row) => String(row.hash)
        );
        if (hashes.length === 0) return;
        await yieldSqlite(signal);
        scratch.exec("DETACH DATABASE source");
        attached = false;
        const targetPath = `/embedding-shard-${crypto.randomUUID()}.sqlite3`;
        try {
          checkAbort(signal);
          scratch.exec(`VACUUM INTO 'file:${targetPath}?vfs=${pool.vfsName}'`);
          const bytes = pool.exportFile(targetPath);
          checkAbort(signal);
          if (bytes.byteLength < EMBEDDING_ARTIFACT_MAX_FILE_BYTES) return { bytes, hashes };
          if (batchLimit === 1)
            throw new Error("A single-vector SQLite shard exceeds the file size limit.");
        } finally {
          pool.unlink(targetPath);
        }
        batchLimit = Math.max(1, Math.floor(batchLimit / 2));
        scratch.exec(
          `ATTACH DATABASE 'file:${pool.mainPath}?vfs=${pool.vfsName}&mode=ro' AS source`
        );
        attached = true;
        await yieldSqlite(signal);
      }
      return;
    } finally {
      if (attached) {
        try {
          scratch.exec("DETACH DATABASE source");
        } catch {
          // Preserve the operation error; closing the scratch connection releases the attachment.
        }
      }
      try {
        scratch.close();
      } finally {
        pool.unlink(scratchPath);
      }
    }
  }

  private async embeddingCacheSqliteImport(
    input: NoteStoreRpc["embeddingCacheSqliteImport"],
    signal?: AbortSignal
  ): Promise<{ imported: number; alreadyImported: boolean }> {
    const { profile, checksum, dimensions, bytes, now } = input;
    const pool = this.requireShardPool();
    if (
      !/^[0-9a-f]{64}$/.test(profile) ||
      !/^[0-9a-f]{64}$/.test(checksum) ||
      !Number.isSafeInteger(dimensions) ||
      dimensions < 1 ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength >= EMBEDDING_ARTIFACT_MAX_FILE_BYTES
    )
      throw new TypeError("Invalid SQLite embedding shard");

    const importedPath = `/embedding-shard-import-${crypto.randomUUID()}.sqlite3`;
    let importedDb: SqliteConnection | undefined;
    let attached = false;
    let inTransaction = false;
    try {
      pool.importDb(importedPath, bytes);
      await yieldSqlite(signal);
      importedDb = pool.openDatabase(importedPath, "r");
      importedDb.exec("PRAGMA trusted_schema=OFF");
      await yieldSqlite(signal);

      const appId = rows(importedDb, "PRAGMA application_id");
      const userVersion = rows(importedDb, "PRAGMA user_version");
      if (
        Number(Object.values(appId[0] ?? {})[0]) !== SQLITE_SHARD_APPLICATION_ID ||
        Number(Object.values(userVersion[0] ?? {})[0]) !== 1
      )
        throw new TypeError("SQLite shard application id or version is invalid");

      const schema = rows(
        importedDb,
        `SELECT type,name,sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`
      );
      const normalized = new Map(
        schema.map((row) => [String(row.name), String(row.sql).replace(/\s/g, "").toLowerCase()])
      );
      if (
        schema.length !== 3 ||
        schema.some((row) => row.type !== "table") ||
        normalized.get("metadata") !==
          "createtablemetadata(profiletextnotnull,dimensionsintegernotnull,tasktextnotnull)" ||
        normalized.get("vectors") !==
          "createtablevectors(hashtextnotnullunique,vectorblobnotnull)" ||
        normalized.get("_sqliteai_vector") !==
          "createtable_sqliteai_vector(tblnametext,colnametext,keytext,valueany,primarykey(tblname,colname,key))" ||
        Number(rows(importedDb, "SELECT count(*) AS count FROM _sqliteai_vector")[0].count) !== 0
      )
        throw new TypeError("SQLite shard schema is invalid");

      const metadata = rows(importedDb, "SELECT profile,dimensions,task FROM metadata");
      const vectorCount = Number(
        rows(importedDb, "SELECT count(*) AS count FROM vectors")[0].count
      );
      const vectorBytes = Number(
        rows(importedDb, "SELECT coalesce(sum(length(vector)),0) AS bytes FROM vectors")[0].bytes
      );
      if (
        metadata.length !== 1 ||
        metadata[0].profile !== profile ||
        Number(metadata[0].dimensions) !== dimensions ||
        metadata[0].task !== "document" ||
        vectorCount < 1 ||
        vectorCount > EMBEDDING_ARTIFACT_MAX_ENTRIES ||
        vectorBytes > EMBEDDING_ARTIFACT_MAX_VECTOR_BYTES
      )
        throw new TypeError("SQLite shard profile or size is invalid");
      await yieldSqlite(signal);
      const malformed = Number(
        rows(
          importedDb,
          `SELECT count(*) AS count FROM vectors WHERE
            typeof(hash)!='text' OR length(hash)!=64 OR hash GLOB '*[^0-9a-f]*' OR
            typeof(vector)!='blob' OR length(vector)!=? OR
            typeof(trama_vector_dot(vector,vector)) NOT IN ('integer','real') OR
            trama_vector_dot(vector,vector)<0 OR trama_vector_dot(vector,vector)>1e100`,
          [dimensions * 4]
        )[0].count
      );
      const integrity = rows(importedDb, "PRAGMA quick_check");
      if (malformed !== 0 || integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok")
        throw new TypeError("SQLite shard data failed validation");
      await yieldSqlite(signal);

      importedDb.close();
      importedDb = undefined;
      this.db.exec(
        `ATTACH DATABASE 'file:${importedPath}?vfs=${pool.vfsName}&mode=ro' AS imported`
      );
      attached = true;
      await yieldSqlite(signal);

      const previouslyImported =
        rows(
          this.db,
          "SELECT 1 AS found FROM embedding_cache_sqlite_imports WHERE profile=? AND checksum=?",
          [profile, checksum]
        ).length > 0;
      if (previouslyImported) return { imported: 0, alreadyImported: true };

      checkAbort(signal);
      this.db.exec("BEGIN IMMEDIATE");
      inTransaction = true;
      this.db.exec({
        sql: `INSERT INTO embedding_cache(profile,task,hash,vector,created_at)
          SELECT ?,'document',hash,vector,? FROM imported.vectors WHERE 1
          ON CONFLICT(profile,task,hash) DO NOTHING`,
        bind: [profile, now],
      });
      const imported = Number(rows(this.db, "SELECT changes() AS count")[0].count);
      await yieldSqlite(signal);
      this.db.exec({
        sql: `INSERT INTO embedding_cache_sqlite_publications(profile,hash,checksum,published_at)
          SELECT ?,hash,?,? FROM imported.vectors WHERE 1
          ON CONFLICT(profile,hash) DO NOTHING`,
        bind: [profile, checksum, now],
      });
      this.db.exec({
        sql: "INSERT INTO embedding_cache_sqlite_imports(profile,checksum,imported_at) VALUES(?,?,?)",
        bind: [profile, checksum, now],
      });
      await yieldSqlite(signal);
      this.db.exec("COMMIT");
      inTransaction = false;
      return { imported, alreadyImported: false };
    } catch (error) {
      if (inTransaction) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Preserve the original validation, cancellation, or write error.
        }
      }
      throw error;
    } finally {
      if (attached) {
        try {
          this.db.exec("DETACH DATABASE imported");
        } catch {
          // Closing the main connection also releases the attachment.
        }
      }
      importedDb?.close();
      pool.unlink(importedPath);
    }
  }

  private async embeddingCacheSqliteMarkPublished(
    input: NoteStoreRpc["embeddingCacheSqliteMarkPublished"],
    signal?: AbortSignal
  ): Promise<void> {
    const { profile, checksum, hashes, now } = input;
    if (
      !/^[0-9a-f]{64}$/.test(profile) ||
      !/^[0-9a-f]{64}$/.test(checksum) ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Array.isArray(hashes) ||
      hashes.length < 1 ||
      hashes.length > EMBEDDING_ARTIFACT_MAX_ENTRIES ||
      hashes.some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
    )
      throw new TypeError("Invalid SQLite shard publication receipt");
    checkAbort(signal);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec({
        sql: `INSERT INTO embedding_cache_sqlite_publications(profile,hash,checksum,published_at)
          SELECT ?,e.hash,?,? FROM embedding_cache e
          WHERE e.profile=? AND e.task='document' AND e.hash IN (${hashes.map(() => "?").join(",")})
          ON CONFLICT(profile,hash) DO NOTHING`,
        bind: [profile, checksum, now, profile, ...hashes],
      });
      await yieldSqlite(signal);
      this.db.exec({
        sql: `INSERT INTO embedding_cache_sqlite_imports(profile,checksum,imported_at)
          VALUES(?,?,?) ON CONFLICT(profile,checksum) DO NOTHING`,
        bind: [profile, checksum, now],
      });
      await yieldSqlite(signal);
      checkAbort(signal);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  private requireShardPool(): SqliteEmbeddingShardPool {
    if (!this.shardPool) throw new Error("SQLite shard storage is unavailable");
    return this.shardPool;
  }

  private async hybridSearch(
    input: NoteStoreRpc["noteStoreHybrid"],
    signal?: AbortSignal
  ): Promise<NoteStoreHybridResult> {
    const { query, vector, profile, k } = input;
    if (
      (query !== undefined && (typeof query !== "string" || query.length > 4096)) ||
      (vector === undefined && query === undefined) ||
      !Number.isSafeInteger(k) ||
      k < 0 ||
      k > 100 ||
      (profile !== undefined && typeof profile !== "string") ||
      (vector !== undefined && (!profile || !Array.isArray(vector)))
    )
      throw new TypeError("Invalid note search request");

    if (vector !== undefined) vectorBytes(vector);

    const stored =
      vector && profile
        ? rows(
            this.db,
            "SELECT length(centroid) AS bytes FROM note_index WHERE embedding_profile=? AND centroid IS NOT NULL LIMIT 1",
            [profile]
          )[0]
        : undefined;
    checkAbort(signal);
    const semanticAvailable = stored !== undefined;
    if (stored && Number(stored.bytes) !== vector!.length * 4)
      throw new TypeError("Query vector dimensions do not match the profile");
    const needle = semanticAvailable ? vectorBytes(vector!) : null;
    const expression = query === undefined ? "" : ftsTerms(query);
    const candidateLimit = Math.min(200, k * 4);
    const lexicalCte = expression
      ? `lexical_base AS (
          SELECT n.note_id,n.path,bm25(note_fts) AS lexicalScore
          FROM note_fts JOIN note_index n ON n.note_id=note_fts.rowid
          WHERE note_fts MATCH ?
          ORDER BY lexicalScore ASC,n.path COLLATE BINARY ASC LIMIT ?
        ), lexical AS (
          SELECT *,ROW_NUMBER() OVER(ORDER BY lexicalScore ASC,path COLLATE BINARY ASC) AS lexicalRank FROM lexical_base
        ),`
      : `lexical AS (SELECT NULL AS note_id,NULL AS path,NULL AS lexicalScore,NULL AS lexicalRank WHERE 0),`;
    const found = rows(
      this.db,
      `WITH ${lexicalCte}
      semantic_base AS (
        SELECT n.note_id,n.path,MAX(trama_vector_dot(v.vector,?)) AS semanticScore
        FROM note_index n JOIN note_vectors v USING(note_id)
        WHERE n.embedding_profile=? AND ?=1
        GROUP BY n.note_id
        ORDER BY semanticScore DESC,n.path COLLATE BINARY ASC LIMIT ?
      ), semantic AS (
        SELECT *,ROW_NUMBER() OVER(ORDER BY semanticScore DESC,path COLLATE BINARY ASC) AS semanticRank FROM semantic_base
      ), combined AS (
        SELECT l.note_id,l.path,l.lexicalScore,s.semanticScore,
          1.0/(60+l.lexicalRank)+COALESCE(1.0/(60+s.semanticRank),0) AS fusedScore
        FROM lexical l LEFT JOIN semantic s ON s.note_id=l.note_id
        UNION ALL
        SELECT s.note_id,s.path,NULL,s.semanticScore,1.0/(60+s.semanticRank)
        FROM semantic s LEFT JOIN lexical l ON l.note_id=s.note_id WHERE l.note_id IS NULL
      )
      SELECT path,fusedScore,lexicalScore,semanticScore FROM combined
      ORDER BY fusedScore DESC,path COLLATE BINARY ASC LIMIT ?`,
      [
        ...(expression ? [expression, candidateLimit] : []),
        needle,
        semanticAvailable ? profile : null,
        semanticAvailable ? 1 : 0,
        candidateLimit,
        k,
      ]
    );
    checkAbort(signal);
    const hits = found.map((row) => {
      const semanticScore = row.semanticScore === null ? undefined : Number(row.semanticScore);
      const lexicalScore = row.lexicalScore === null ? undefined : Number(row.lexicalScore);
      const score = query === undefined ? (semanticScore ?? 0) : Number(row.fusedScore);
      return {
        path: String(row.path),
        score,
        ...(lexicalScore === undefined ? {} : { lexicalScore }),
        ...(semanticScore === undefined ? {} : { semanticScore }),
      } satisfies NoteStoreHit;
    });
    const degraded = vector !== undefined && !semanticAvailable;
    return {
      hits,
      mode: semanticAvailable ? "hybrid" : "lexical",
      degraded,
      ...(degraded ? { degradationReason: "semantic-unavailable" as const } : {}),
    };
  }

  private related(
    input: NoteStoreRpc["noteStoreRelated"],
    signal?: AbortSignal
  ): NoteStoreRelatedResult {
    const { sourcePath, profile, k } = input;
    validPath(sourcePath);
    if (typeof profile !== "string" || !Number.isSafeInteger(k) || k < 0 || k > 20)
      throw new TypeError("Invalid related-note request");
    const sourceAvailable =
      Number(
        rows(
          this.db,
          "SELECT EXISTS(SELECT 1 FROM note_index WHERE path=? AND embedding_profile=? AND centroid IS NOT NULL) AS available",
          [sourcePath, profile]
        )[0].available
      ) === 1;
    if (!sourceAvailable) return { hits: [], available: false };
    checkAbort(signal);
    const hits = rows(
      this.db,
      `SELECT other.path,trama_vector_dot(other.centroid,source.centroid) AS score
      FROM note_index source JOIN note_index other
        ON other.embedding_profile=source.embedding_profile
      WHERE source.path=? AND source.embedding_profile=? AND source.centroid IS NOT NULL
        AND other.centroid IS NOT NULL AND other.note_id<>source.note_id
      ORDER BY score DESC,other.path COLLATE BINARY ASC LIMIT ?`,
      [sourcePath, profile, k]
    ).map((row) => ({ path: String(row.path), score: Number(row.score) }));
    checkAbort(signal);
    return { hits, available: true };
  }

  private async replace(
    input: NoteStoreRpc["noteStoreReplace"],
    signal?: AbortSignal
  ): Promise<{ path: string }> {
    const { uid, path, profile, markdown, vectors } = input;
    validPath(path);
    if (
      typeof uid !== "string" ||
      !uid ||
      (profile !== null && typeof profile !== "string") ||
      typeof markdown !== "string" ||
      !Array.isArray(vectors)
    )
      throw new TypeError("Invalid note replacement");
    const dimensions = vectors[0]?.length;
    const normalized = vectors.map((vector) => vectorBytes(vector, dimensions));
    checkAbort(signal);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      checkAbort(signal);
      const existing = rows(this.db, "SELECT note_id FROM note_index WHERE path=?", [path])[0];
      let id: number;
      if (existing) {
        id = Number(existing.note_id);
        this.db.exec({ sql: "DELETE FROM note_fts WHERE rowid=?", bind: [id] });
        this.db.exec({
          sql: "UPDATE note_index SET current_uid=?,embedding_profile=?,centroid=NULL WHERE note_id=?",
          bind: [uid, profile, id],
        });
      } else {
        this.db.exec({
          sql: "INSERT INTO note_index(path,current_uid,embedding_profile) VALUES(?,?,?)",
          bind: [path, uid, profile],
        });
        id = Number(rows(this.db, "SELECT last_insert_rowid() AS id")[0].id);
      }
      this.db.exec({ sql: "DELETE FROM note_vectors WHERE note_id=?", bind: [id] });
      for (let i = 0; i < normalized.length; i++) {
        checkAbort(signal);
        this.db.exec({
          sql: "INSERT INTO note_vectors(note_id,ordinal,vector) VALUES(?,?,?)",
          bind: [id, i, normalized[i]],
        });
        if ((i + 1) % 16 === 0 && i + 1 < normalized.length) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          checkAbort(signal);
        }
      }
      if (profile !== null) {
        this.db.exec({
          sql: `UPDATE note_index SET centroid=(
            SELECT trama_vector_centroid(vector) FROM note_vectors WHERE note_id=?
          ) WHERE note_id=?`,
          bind: [id, id],
        });
      }
      this.db.exec({
        sql: "INSERT INTO note_fts(rowid,body,path_text) VALUES(?,?,?)",
        bind: [id, markdown, path],
      });
      const updatedAt = this.tickRecordClock();
      this.db.exec({
        sql: `INSERT INTO note_records(uid,group_path,updated_at) VALUES(?,?,?)
          ON CONFLICT(uid) DO UPDATE SET group_path=excluded.group_path,updated_at=excluded.updated_at`,
        bind: [uid, path, updatedAt],
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      checkAbort(signal);
      this.db.exec("COMMIT");
      return { path };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    }
  }

  private async updateRecords(input: NoteStoreRpc["recordManagerUpdate"]): Promise<void> {
    const { keys, groupIds, timeAtLeast } = input;
    validKeys(keys);
    if (
      (groupIds !== undefined &&
        (!Array.isArray(groupIds) ||
          groupIds.length !== keys.length ||
          groupIds.some((group) => group !== null && typeof group !== "string"))) ||
      (timeAtLeast !== undefined && !Number.isSafeInteger(timeAtLeast))
    )
      throw new TypeError("Invalid record update");
    if (!keys.length) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = Number(
        rows(this.db, "SELECT value FROM note_record_clock WHERE id=1")[0].value
      );
      if (timeAtLeast !== undefined && current < timeAtLeast)
        throw new Error("Record manager time is earlier than timeAtLeast");
      const updatedAt = Math.max(current + 1, (timeAtLeast ?? 0) + 1);
      if (!Number.isSafeInteger(updatedAt)) throw new Error("Record manager clock is exhausted");
      this.db.exec({
        sql: "UPDATE note_record_clock SET value=? WHERE id=1",
        bind: [updatedAt],
      });
      for (let offset = 0; offset < keys.length; offset += 100) {
        const batch = keys.slice(offset, offset + 100);
        const values = batch.map(() => (groupIds === undefined ? "(?,NULL,?)" : "(?,?,?)"));
        const bind: unknown[] = [];
        for (let index = offset; index < offset + batch.length; index++) {
          bind.push(keys[index]);
          if (groupIds !== undefined) bind.push(groupIds[index]);
          bind.push(updatedAt);
        }
        this.db.exec({
          sql: `INSERT INTO note_records(uid,group_path,updated_at) VALUES ${values.join(",")}
            ON CONFLICT(uid) DO UPDATE SET ${groupIds === undefined ? "" : "group_path=excluded.group_path,"}updated_at=excluded.updated_at`,
          bind,
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    }
  }

  private reserveRecordTime(): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const next = this.tickRecordClock();
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    }
  }

  private tickRecordClock(): number {
    const current = Number(
      rows(this.db, "SELECT value FROM note_record_clock WHERE id=1")[0].value
    );
    const next = current + 1;
    if (!Number.isSafeInteger(next)) throw new Error("Record manager clock is exhausted");
    this.db.exec({ sql: "UPDATE note_record_clock SET value=? WHERE id=1", bind: [next] });
    return next;
  }

  private recordExists(input: NoteStoreRpc["recordManagerExists"]): boolean[] {
    const { keys } = input;
    validKeys(keys);
    if (!keys.length) return [];
    const found = rows(
      this.db,
      `SELECT r.uid FROM note_records r JOIN note_index n ON n.current_uid=r.uid
      WHERE r.uid IN (${keys.map(() => "?").join(",")})`,
      keys
    );
    const existing = new Set(found.map((row) => String(row.uid)));
    return keys.map((key) => existing.has(key));
  }

  private listRecordKeys(input: NoteStoreRpc["recordManagerListKeys"]): string[] {
    const { before, after, groupIds, limit } = input;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      (before !== undefined && !Number.isSafeInteger(before)) ||
      (after !== undefined && !Number.isSafeInteger(after)) ||
      (groupIds !== undefined &&
        (!Array.isArray(groupIds) ||
          groupIds.length > 1000 ||
          groupIds.some((group) => group !== null && typeof group !== "string")))
    )
      throw new TypeError("Invalid record key page");
    if (groupIds?.length === 0) return [];
    const clauses: string[] = [];
    const binds: unknown[] = [];
    if (before !== undefined) {
      clauses.push("updated_at<?");
      binds.push(before);
    }
    if (after !== undefined) {
      clauses.push("updated_at>?");
      binds.push(after);
    }
    if (groupIds !== undefined) {
      const values = groupIds.filter((group): group is string => group !== null);
      const hasNull = values.length !== groupIds.length;
      clauses.push(
        `(${values.length ? `group_path IN (${values.map(() => "?").join(",")})` : "0"}${hasNull ? " OR group_path IS NULL" : ""})`
      );
      binds.push(...values);
    }
    binds.push(limit);
    return rows(
      this.db,
      `SELECT uid FROM note_records${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY uid COLLATE BINARY LIMIT ?`,
      binds
    ).map((row) => String(row.uid));
  }

  private deleteRecords(input: NoteStoreRpc["recordManagerDeleteKeys"]): void {
    const { keys } = input;
    validKeys(keys);
    if (!keys.length) return;
    this.db.exec({
      sql: `DELETE FROM note_records WHERE uid IN (${keys.map(() => "?").join(",")})`,
      bind: keys,
    });
  }
}
