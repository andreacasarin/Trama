import { describe, expect, it, vi } from "vitest";
import {
  createEmbeddingActionKey,
  createInputDigest,
  EMBEDDING_ACTION_OPTIONS,
} from "@/index/Identity";
import { MutableSqliteDatabase } from "@/index/sqlite/database";
import { applyLexicalMarkdownBatch } from "@/index/sqlite/markdown";
import {
  ingestCacheShard,
  prepareCacheShard,
  type CacheShardPool,
} from "@/index/sqlite/cache-shards";
import {
  applyTestLexicalRun,
  createTestSqliteClient,
  embedAllTestInputs,
  loadTestSqlite,
} from "./sqlite-test-client";

const profile = "a".repeat(64);
const preprocessing = "normalized-float32-v1";
const dimensions = 2;

async function database() {
  const sqlite = await loadTestSqlite();
  const raw = new sqlite.oo1.DB(":memory:", "c");
  const db = new MutableSqliteDatabase(raw);
  db.boot("b".repeat(64), dimensions, profile);
  return { sqlite, raw, db };
}

async function poolFixture(sqlite: any): Promise<CacheShardPool> {
  const files = new Map<string, any>();
  class PoolDb extends sqlite.oo1.DB {
    private readonly cacheName: string;
    constructor(name: string, mode: string) {
      super(":memory:", mode);
      this.cacheName = name;
      const imported = files.get(name);
      if (imported instanceof Uint8Array) {
        const pointer = sqlite.wasm.allocFromTypedArray(imported);
        const flags =
          sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite.capi.SQLITE_DESERIALIZE_RESIZEABLE;
        const rc = sqlite.capi.sqlite3_deserialize(
          this.pointer,
          "main",
          pointer,
          imported.byteLength,
          imported.byteLength,
          flags
        );
        if (rc !== 0) throw new Error("candidate deserialize failed");
      }
      files.set(name, this);
    }
    close() {
      files.set(this.cacheName, new Uint8Array(sqlite.capi.sqlite3_js_db_export(this.pointer)));
      super.close();
    }
  }
  return {
    OpfsSAHPoolDb: PoolDb as unknown as CacheShardPool["OpfsSAHPoolDb"],
    exportFile(name) {
      const value = files.get(name);
      if (!value) throw new Error("missing candidate");
      return value instanceof Uint8Array
        ? value.slice()
        : new Uint8Array(sqlite.capi.sqlite3_js_db_export(value.pointer));
    },
    importDb(name, bytes) {
      const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
      files.set(name, view.slice());
      return 0;
    },
    unlink(name) {
      const db = files.get(name);
      if (!db) return false;
      if (!(db instanceof Uint8Array)) db.close();
      files.delete(name);
      return true;
    },
  };
}

async function insertCache(
  raw: any,
  input: string,
  createdAt = 1,
  vector = new Float32Array([1, 0])
) {
  const inputDigest = await createInputDigest(input);
  const actionKey = createEmbeddingActionKey(
    inputDigest,
    profile,
    preprocessing,
    EMBEDDING_ACTION_OPTIONS
  );
  const bytes = new Uint8Array(vector.buffer.slice(0));
  raw.exec({
    sql: "INSERT INTO embedding_inputs(embedding_fingerprint,serialized_input,preprocessing,action_key) VALUES(?,?,?,?)",
    bind: [profile, input, preprocessing, inputDigest],
  });
  raw.exec({
    sql: "INSERT INTO embedding_cache(input_digest,action_key,embedding_fingerprint,preprocessing,vector,task_kind,created_at) VALUES(?,?,?,?,?,'document',?)",
    bind: [inputDigest, actionKey, profile, preprocessing, bytes, createdAt],
  });
}

function seedQueryProfile(raw: any, fingerprint: string, count: number, createdAt: number) {
  raw.exec({
    sql: `WITH RECURSIVE sequence(value) AS (
      SELECT 1 UNION ALL SELECT value+1 FROM sequence WHERE value<?
    )
    INSERT INTO embedding_inputs(embedding_fingerprint,serialized_input,preprocessing,action_key)
    SELECT ?, 'seed query '||value, ?, 'seed-input-'||printf('%04d',value) FROM sequence`,
    bind: [count, fingerprint, preprocessing],
  });
  raw.exec({
    sql: `WITH RECURSIVE sequence(value) AS (
      SELECT 1 UNION ALL SELECT value+1 FROM sequence WHERE value<?
    )
    INSERT INTO embedding_cache(input_digest,action_key,embedding_fingerprint,preprocessing,vector,task_kind,created_at)
    SELECT 'seed-input-'||printf('%04d',value), 'seed-query-'||printf('%04d',value), ?, ?, zeroblob(?), 'query', ?
    FROM sequence`,
    bind: [count, fingerprint, preprocessing, dimensions * 4, createdAt],
  });
}

describe("cache-only SQLite shards", () => {
  it("does not scan corpus status during first or duplicate shard ingestion", async () => {
    const source = await database();
    const target = await database();
    const pool = await poolFixture(source.sqlite);
    try {
      await insertCache(source.raw, "cache import must not scan note heads");
      const shard = await source.db.prepareCacheShard(pool, undefined, "document");
      const state = vi.spyOn((target.db as any).state, "getState");
      await expect(
        target.db.ingestCacheShard(pool, shard!.bytes, shard!.digest)
      ).resolves.toMatchObject({ duplicate: false });
      expect(state).not.toHaveBeenCalled();
      const reconcile = vi.spyOn((target.db as any).state, "reconcileImportedEmbeddingProfiles");
      await expect(
        target.db.ingestCacheShard(pool, shard!.bytes, shard!.digest)
      ).resolves.toMatchObject({ duplicate: true });
      expect(reconcile).not.toHaveBeenCalled();
      expect(state).not.toHaveBeenCalled();
      expect(target.db.getState().compatibleVectorCount).toBe(1);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("records a locally published shard receipt so later ingestion skips its database import", async () => {
    const local = await database();
    const pool = await poolFixture(local.sqlite);
    await insertCache(local.raw, "locally published exact provider input");
    const shard = await local.db.prepareCacheShard(pool, undefined, "document");
    let imports = 0;
    pool.importDb = () => {
      imports++;
      throw new Error("a recorded local shard must not be imported again");
    };

    local.db.recordCacheShard(shard!.digest, profile, "document", shard!.actionKeys);
    await expect(
      local.db.ingestCacheShard(pool, shard!.bytes, shard!.digest)
    ).resolves.toMatchObject({ imported: 0, duplicate: true, profile, taskKind: "document" });
    expect(imports).toBe(0);
    expect(
      Number(
        local.raw.selectValue("SELECT count(*) FROM cache_artifact_receipts WHERE digest=?", [
          shard!.digest,
        ])
      )
    ).toBe(1);
    local.db.close();
  });

  it("exports cache-only bytes and additively ingests vectors with an atomic receipt", async () => {
    const source = await database();
    const target = await database();
    const pool = await poolFixture(source.sqlite);
    await insertCache(source.raw, "exact provider input");
    const shard = await prepareCacheShard(source.raw, pool, profile, dimensions);
    expect(shard).toMatchObject({ rowCount: 1 });
    expect(shard!.bytes.byteLength).toBeLessThanOrEqual(4_194_304);
    let imports = 0;
    const importDb = pool.importDb;
    pool.importDb = (name, bytes) => {
      imports++;
      return importDb(name, bytes);
    };
    const result = await ingestCacheShard(
      target.raw,
      pool,
      shard!.bytes,
      shard!.digest,
      dimensions,
      profile
    );
    expect(result).toMatchObject({ imported: 1, duplicate: false });
    expect(imports).toBe(1);
    expect(
      await ingestCacheShard(target.raw, pool, shard!.bytes, shard!.digest, dimensions, profile)
    ).toEqual({
      imported: 0,
      duplicate: true,
      profile,
      taskKind: "document",
    });
    expect(imports).toBe(1);
    target.raw.exec({
      sql: "DELETE FROM cache_shard_membership WHERE digest=?",
      bind: [shard!.digest],
    });
    await expect(
      ingestCacheShard(target.raw, pool, shard!.bytes, shard!.digest, dimensions, profile)
    ).resolves.toMatchObject({ imported: 0, duplicate: true });
    expect(imports).toBe(2);
    expect(Number(target.raw.selectValue("SELECT count(*) FROM embedding_cache"))).toBe(1);
    expect(Number(target.raw.selectValue("SELECT count(*) FROM cache_shard_membership"))).toBe(1);
    expect(Number(target.raw.selectValue("SELECT count(*) FROM cache_artifact_receipts"))).toBe(1);
    expect(Number(target.raw.selectValue("SELECT count(*) FROM notes"))).toBe(0);
    expect(Number(target.raw.selectValue("SELECT count(*) FROM lexical_notes_fts"))).toBe(0);
    source.db.close();
    target.db.close();
  });

  it("does not reimport an expired query shard with a matching receipt and membership", async () => {
    const source = await database();
    const target = await database();
    const pool = await poolFixture(source.sqlite);
    await source.db.storeQueryVector(
      "expired query shard",
      profile,
      dimensions,
      new Float32Array([1, 0])
    );
    const shard = await prepareCacheShard(
      source.raw,
      pool,
      profile,
      dimensions,
      undefined,
      "query"
    );
    expect(shard).toMatchObject({ rowCount: 1, taskKind: "query", profile });
    let imports = 0;
    const importDb = pool.importDb;
    pool.importDb = (name, bytes) => {
      imports++;
      return importDb(name, bytes);
    };

    await expect(
      ingestCacheShard(target.raw, pool, shard!.bytes, shard!.digest, dimensions, profile)
    ).resolves.toMatchObject({ imported: 1, duplicate: false, taskKind: "query", profile });
    target.db.maintainCache(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(
      Number(target.raw.selectValue("SELECT count(*) FROM embedding_cache WHERE task_kind='query'"))
    ).toBe(0);
    expect(
      Number(
        target.raw.selectValue("SELECT count(*) FROM cache_shard_membership WHERE digest=?", [
          shard!.digest,
        ])
      )
    ).toBe(1);
    expect(
      Number(
        target.raw.selectValue("SELECT count(*) FROM cache_artifact_receipts WHERE digest=?", [
          shard!.digest,
        ])
      )
    ).toBe(1);

    await expect(
      ingestCacheShard(target.raw, pool, shard!.bytes, shard!.digest, dimensions, profile)
    ).resolves.toEqual({ imported: 0, duplicate: true, profile, taskKind: "query" });
    expect(imports).toBe(1);
    expect(
      Number(target.raw.selectValue("SELECT count(*) FROM embedding_cache WHERE task_kind='query'"))
    ).toBe(0);
    source.db.close();
    target.db.close();
  });

  it("resumes cache-shard paging at the first row that exceeded the payload budget", async () => {
    const source = await database();
    const pool = await poolFixture(source.sqlite);
    const inputs = ["pagination input A", "pagination input B"];
    for (const input of inputs) await insertCache(source.raw, input);
    const oneRowBytes =
      Buffer.byteLength(inputs[0]) + dimensions * Float32Array.BYTES_PER_ELEMENT + 256;
    const maxPayloadBytes = oneRowBytes + 1;
    expect(2 * oneRowBytes).toBeGreaterThan(maxPayloadBytes);

    const originalExec = source.raw.exec;
    let priorCursor: unknown;
    let repeatedCursorCount = 0;
    source.raw.exec = function (...args: any[]) {
      const request = args[0];
      if (
        request &&
        typeof request === "object" &&
        typeof request.sql === "string" &&
        request.sql.startsWith("SELECT ec.action_key,ec.input_digest")
      ) {
        const cursor = request.bind[1];
        if (cursor === priorCursor) {
          repeatedCursorCount++;
          if (repeatedCursorCount === 2) throw new Error("bounded repeated cursor detected");
        }
        priorCursor = cursor;
      }
      return originalExec.apply(this, args);
    };
    try {
      const first = await prepareCacheShard(
        source.raw,
        pool,
        profile,
        dimensions,
        undefined,
        "document",
        undefined,
        undefined,
        maxPayloadBytes
      );
      expect(first?.rowCount).toBe(1);
      expect(first?.payloadBytes).toBeLessThanOrEqual(maxPayloadBytes);
      expect(first?.bytes.byteLength).toBeLessThanOrEqual(4_194_304);
      expect(first?.nextActionKey).toBeTruthy();

      const second = await prepareCacheShard(
        source.raw,
        pool,
        profile,
        dimensions,
        first!.nextActionKey,
        "document",
        undefined,
        undefined,
        maxPayloadBytes
      );
      expect(second?.rowCount).toBe(1);
      expect(second?.nextActionKey).not.toBe(first?.nextActionKey);
      expect(second?.bytes.byteLength).toBeLessThanOrEqual(4_194_304);
      expect(
        await prepareCacheShard(
          source.raw,
          pool,
          profile,
          dimensions,
          second!.nextActionKey,
          "document",
          undefined,
          undefined,
          maxPayloadBytes
        )
      ).toBeUndefined();

      const actionKeys = [...first!.actionKeys, ...second!.actionKeys];
      expect(actionKeys).toHaveLength(2);
      expect(new Set(actionKeys).size).toBe(2);
      expect(Number(source.raw.selectValue("SELECT count(*) FROM embedding_cache"))).toBe(2);
      expect(repeatedCursorCount).toBe(0);
    } finally {
      source.raw.exec = originalExec;
      source.db.close();
    }
  });

  it("deduplicates same logical vector rows across distinct shard byte hashes", async () => {
    const source = await database();
    const target = await database();
    const pool = await poolFixture(source.sqlite);
    await insertCache(source.raw, "same exact input", 1);
    const first = await prepareCacheShard(source.raw, pool, profile, dimensions);
    source.raw.exec("UPDATE embedding_cache SET created_at=2");
    const second = await prepareCacheShard(source.raw, pool, profile, dimensions);
    expect(second!.digest).not.toBe(first!.digest);
    await ingestCacheShard(target.raw, pool, first!.bytes, first!.digest, dimensions, profile);
    await ingestCacheShard(target.raw, pool, second!.bytes, second!.digest, dimensions, profile);
    expect(Number(target.raw.selectValue("SELECT count(*) FROM embedding_cache"))).toBe(1);
    expect(Number(target.raw.selectValue("SELECT count(*) FROM cache_artifact_receipts"))).toBe(2);
    source.db.close();
    target.db.close();
  });

  it("transports query vectors and keeps them out of document semantic coverage", async () => {
    const source = await database();
    const target = await database();
    const pool = await poolFixture(source.sqlite);
    await insertCache(source.raw, "document input");
    await source.db.storeQueryVector("exact query", profile, dimensions, new Float32Array([0, 1]));
    const documentShard = await source.db.prepareCacheShard(pool, undefined, "document");
    const queryShard = await source.db.prepareCacheShard(pool, undefined, "query");
    expect(queryShard).toMatchObject({ taskKind: "query", rowCount: 1 });
    await target.db.ingestCacheShard(pool, documentShard!.bytes, documentShard!.digest);
    await target.db.ingestCacheShard(pool, queryShard!.bytes, queryShard!.digest);
    expect(await target.db.lookupQueryVector("exact query", profile)).toEqual(
      new Float32Array([0, 1])
    );
    const state = target.db.getState();
    expect(state.embeddingFingerprint).toBe(profile);
    expect(state.compatibleVectorCount).toBe(1);
    expect(
      Number(target.raw.selectValue("SELECT count(*) FROM embedding_cache WHERE task_kind='query'"))
    ).toBe(1);
    source.db.close();
    target.db.close();
  });

  it("does not renew query-vector retention when an old row is redelivered", async () => {
    const local = await database();
    await local.db.storeQueryVector("old query", profile, dimensions, new Float32Array([1, 0]));
    local.raw.exec({
      sql: "UPDATE embedding_cache SET created_at=? WHERE task_kind='query'",
      bind: [Date.now() - 31 * 24 * 60 * 60 * 1000],
    });
    await local.db.storeQueryVector("old query", profile, dimensions, new Float32Array([1, 0]));
    expect(await local.db.lookupQueryVector("old query", profile)).toBeUndefined();
    expect(
      Number(local.raw.selectValue("SELECT count(*) FROM embedding_cache WHERE task_kind='query'"))
    ).toBe(0);
    local.db.close();
  });

  it("promotes imported document vectors for local notes without calling a provider", async () => {
    const source = await database();
    const target = await database();
    const pool = await poolFixture(source.sqlite);
    const note = [
      {
        path: "offline.md",
        markdown: `# ${"Oversized heading ".repeat(40)}\n\noffline semantic evidence`,
      },
    ];
    for (const db of [source.db, target.db]) {
      const run = db.beginLexicalRun({ scope: { mayClearIncomplete: true } });
      await applyLexicalMarkdownBatch(db, run.runId, note);
      db.finishLexicalRun(run.runId);
    }
    const work = source.db.prepareSemanticWork(profile, preprocessing);
    source.db.commitSemanticResults(
      work.requests.map((request) => ({
        ...request,
        vector: new Float32Array([1, 0]),
      })),
      profile,
      preprocessing
    );
    const shard = await source.db.prepareCacheShard(pool, undefined, "document");
    await target.db.ingestCacheShard(pool, shard!.bytes, shard!.digest);
    expect(target.db.getState().semanticHeadCount).toBe(0);
    const cached = target.db.prepareSemanticWork(profile, preprocessing, 0, 4 * 1024 * 1024, true);
    expect(cached.requests).toEqual([]);
    expect(cached.promoted).toBeGreaterThan(0);
    expect(target.db.getState().semanticHeadCount).toBe(1);
    source.db.close();
    target.db.close();
  });

  it("repairs only missing current document and fresh query cache memberships", async () => {
    const local = await database();
    const pool = await poolFixture(local.sqlite);
    const run = local.db.beginLexicalRun({ scope: { mayClearIncomplete: true } });
    await applyLexicalMarkdownBatch(local.db, run.runId, [
      { path: "present.md", markdown: "present semantic input" },
      { path: "missing.md", markdown: "missing semantic input" },
    ]);
    local.db.finishLexicalRun(run.runId);
    const work = local.db.prepareSemanticWork(profile, preprocessing);
    local.db.commitSemanticResults(
      work.requests.map((request) => ({
        ...request,
        vector: new Float32Array([1, 0]),
      })),
      profile,
      preprocessing
    );
    const missingAction = work.requests.at(-1)!.actionKey;
    await insertCache(local.raw, "unreferenced orphan", 2);
    const orphanAction = String(
      local.raw.selectValue(
        `SELECT action_key FROM embedding_cache WHERE action_key NOT IN (${work.requests.map(() => "?").join(",")})`,
        work.requests.map(({ actionKey }) => actionKey)
      )
    );
    local.raw.exec({
      sql: "INSERT INTO cache_shard_membership(digest,action_key,task_kind,profile) VALUES(?,?,'document',?)",
      bind: ["c".repeat(64), orphanAction, profile],
    });
    for (const request of work.requests.slice(0, -1))
      local.raw.exec({
        sql: "INSERT INTO cache_shard_membership(digest,action_key,task_kind,profile) VALUES(?,?,'document',?)",
        bind: ["d".repeat(64), request.actionKey, profile],
      });
    const documentShard = await local.db.prepareCacheShard(
      pool,
      undefined,
      "document",
      profile,
      undefined,
      ["d".repeat(64)]
    );
    expect(documentShard?.actionKeys).toEqual([missingAction]);
    expect(documentShard?.actionKeys).not.toContain(orphanAction);

    await local.db.storeQueryVector("present query", profile, dimensions, new Float32Array([1, 0]));
    await local.db.storeQueryVector("missing query", profile, dimensions, new Float32Array([0, 1]));
    await local.db.storeQueryVector("expired query", profile, dimensions, new Float32Array([1, 0]));
    const queryKeys = local.raw.exec({
      sql: "SELECT action_key FROM embedding_cache WHERE task_kind='query' ORDER BY action_key",
      rowMode: "array",
      returnValue: "resultRows",
    }) as string[][];
    local.raw.exec({
      sql: "INSERT INTO cache_shard_membership(digest,action_key,task_kind,profile) VALUES(?,?,'query',?)",
      bind: ["e".repeat(64), queryKeys[0][0], profile],
    });
    const expiredRow = queryKeys[2][0];
    const expired = "f".repeat(64);
    local.raw.exec({
      sql: "INSERT INTO cache_shard_membership(digest,action_key,task_kind,profile) VALUES(?,?,'query',?)",
      bind: [expired, expiredRow, profile],
    });
    local.raw.exec({
      sql: "UPDATE embedding_cache SET created_at=? WHERE action_key=?",
      bind: [Date.now() - 31 * 24 * 60 * 60 * 1000, expiredRow],
    });
    const queryShard = await local.db.prepareCacheShard(
      pool,
      undefined,
      "query",
      profile,
      undefined,
      ["e".repeat(64)]
    );
    expect(queryShard?.actionKeys).toEqual([queryKeys[1][0]]);
    local.db.close();
  });

  it("keeps at most 1,000 recent query vectors per profile", async () => {
    const local = await database();
    for (let index = 0; index < 1_001; index++)
      await local.db.storeQueryVector(
        `query ${index}`,
        profile,
        dimensions,
        new Float32Array([1, 0])
      );
    expect(
      Number(local.raw.selectValue("SELECT count(*) FROM embedding_cache WHERE task_kind='query'"))
    ).toBe(1_000);
    local.db.close();
  });

  it("cleans over-cap profiles on a write to another profile and keeps binary timestamp ties", async () => {
    const local = await database();
    const importedProfile = "c".repeat(64);
    seedQueryProfile(local.raw, importedProfile, 1_001, Date.now());

    await local.db.storeQueryVector(
      "active profile query",
      profile,
      dimensions,
      new Float32Array([1, 0])
    );

    expect(
      Number(
        local.raw.selectValue(
          "SELECT count(*) FROM embedding_cache WHERE task_kind='query' AND embedding_fingerprint=?",
          [importedProfile]
        )
      )
    ).toBe(1_000);
    expect(
      local.raw.selectValue(
        "SELECT min(action_key) FROM embedding_cache WHERE task_kind='query' AND embedding_fingerprint=?",
        [importedProfile]
      )
    ).toBe("seed-query-0001");
    expect(
      local.raw.selectValue(
        "SELECT max(action_key) FROM embedding_cache WHERE task_kind='query' AND embedding_fingerprint=?",
        [importedProfile]
      )
    ).toBe("seed-query-1000");
    local.db.close();
  });

  it("removes expired query vectors below the cap across profiles", async () => {
    const local = await database();
    const importedProfile = "d".repeat(64);
    seedQueryProfile(local.raw, importedProfile, 1, Date.now() - 31 * 24 * 60 * 60 * 1000);

    await local.db.storeQueryVector(
      "active profile query",
      profile,
      dimensions,
      new Float32Array([1, 0])
    );

    expect(
      Number(
        local.raw.selectValue(
          "SELECT count(*) FROM embedding_cache WHERE task_kind='query' AND embedding_fingerprint=?",
          [importedProfile]
        )
      )
    ).toBe(0);
    expect(
      Number(local.raw.selectValue("SELECT count(*) FROM embedding_cache WHERE task_kind='query'"))
    ).toBe(1);
    local.db.close();
  });

  it("rejects invalid digest while accepting vectors from another local profile", async () => {
    const source = await database();
    const target = await database();
    const pool = await poolFixture(source.sqlite);
    await insertCache(source.raw, "provider input");
    const shard = await prepareCacheShard(source.raw, pool, profile, dimensions);
    await expect(
      ingestCacheShard(target.raw, pool, shard!.bytes, "0".repeat(64), dimensions, profile)
    ).rejects.toThrow("digest mismatch");
    await expect(
      ingestCacheShard(target.raw, pool, shard!.bytes, shard!.digest, dimensions, "c".repeat(64))
    ).resolves.toMatchObject({ imported: 1, duplicate: false });
    expect(Number(target.raw.selectValue("SELECT count(*) FROM embedding_profiles"))).toBe(1);
    const malformedSource = await database();
    const malformedPool = await poolFixture(malformedSource.sqlite);
    await insertCache(malformedSource.raw, "provider input");
    malformedSource.raw.exec({
      sql: "UPDATE embedding_cache SET action_key=?",
      bind: [
        JSON.stringify({
          exactInput: "wrong",
          embeddingFingerprint: profile,
          preprocessing,
          options: { inputVersion: 1 },
        }),
      ],
    });
    const malformed = await prepareCacheShard(
      malformedSource.raw,
      malformedPool,
      profile,
      dimensions
    );
    await expect(
      ingestCacheShard(
        target.raw,
        malformedPool,
        malformed!.bytes,
        malformed!.digest,
        dimensions,
        profile
      )
    ).rejects.toThrow("row validation failed");
    expect(Number(target.raw.selectValue("SELECT count(*) FROM embedding_cache"))).toBe(1);
    expect(Number(target.raw.selectValue("SELECT count(*) FROM cache_artifact_receipts"))).toBe(1);
    source.db.close();
    target.db.close();
    malformedSource.db.close();
  });

  it("supports more than 2,000 rows without materializing or limiting a whole-corpus dump", async () => {
    const source = await database();
    const pool = await poolFixture(source.sqlite);
    for (let index = 0; index < 2_100; index++) await insertCache(source.raw, `input-${index}`);
    const shard = await prepareCacheShard(source.raw, pool, profile, dimensions);
    expect(shard?.rowCount).toBeGreaterThan(2_000);
    expect(shard!.bytes.byteLength).toBeLessThanOrEqual(4_194_304);
    source.db.close();
  });

  it("does not emit a file for an empty cache", async () => {
    const source = await database();
    const pool = await poolFixture(source.sqlite);
    await expect(prepareCacheShard(source.raw, pool, profile, dimensions)).resolves.toBeUndefined();
    source.db.close();
  });

  it("routes Index Worker shard RPCs to the active local vector cache", async () => {
    const client = createTestSqliteClient({});
    await client.call("boot", {
      corpusFingerprint: "b".repeat(64),
      embeddingFingerprint: profile,
      dimensions,
    });
    await applyTestLexicalRun(client, [{ path: "rpc.md", markdown: "RPC shard input" }]);
    await embedAllTestInputs(client, profile, () => new Float32Array([1, 0]));
    expect(await client.call("getState", {})).toMatchObject({ vectorCount: 1 });
    const shard = await client.call("prepareCacheShard", {});
    expect(shard).toMatchObject({ rowCount: 1 });
    expect(shard.bytes.byteLength).toBeLessThanOrEqual(4_194_304);

    const receiver = createTestSqliteClient({});
    await receiver.call("boot", {
      corpusFingerprint: "b".repeat(64),
      embeddingFingerprint: profile,
      dimensions,
    });
    await applyTestLexicalRun(receiver, [{ path: "rpc.md", markdown: "RPC shard input" }]);
    await receiver.call("ingestCacheShard", { bytes: shard.bytes, digest: shard.digest });
    const cached = await receiver.call("prepareSemanticWork", {
      embeddingFingerprint: profile,
      limit: 8,
      maxInputBytes: 4 * 1024 * 1024,
    });
    expect(cached.requests).toEqual([]);
    expect((await receiver.call("getState", {})).vectorCount).toBe(1);
    await client.call("shutdown", {});
    await receiver.call("shutdown", {});
  });
});
