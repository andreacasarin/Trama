import { describe, expect, it } from "vitest";
import { encodeVector, decodeVector, validateVector } from "@/domain/vectors";
import { NoteSqliteDatabase, type SqliteEmbeddingShardPool } from "@/index/note-sqlite/database";
import type { SqliteConnection } from "@/index/note-sqlite/protocol";
import { loadTestSqlite } from "./note-sqlite-test-client";

async function shardFixture(hash = "b".repeat(64)) {
  const sqlite = await loadTestSqlite();
  const db = new sqlite.oo1.DB(":memory:", "c");
  const shard = new sqlite.oo1.DB(":memory:", "c");
  const profile = "a".repeat(64);
  shard.exec(`PRAGMA application_id=1414679873; PRAGMA user_version=1;
      CREATE TABLE metadata(profile TEXT NOT NULL,dimensions INTEGER NOT NULL,task TEXT NOT NULL);
      CREATE TABLE vectors(hash TEXT NOT NULL UNIQUE,vector BLOB NOT NULL);`);
  shard.exec({ sql: "INSERT INTO metadata VALUES(?,2,'document')", bind: [profile] });
  shard.exec({
    sql: "INSERT INTO vectors VALUES(?,?)",
    bind: [hash, encodeVector([1, 0], 2)],
  });
  const pool: SqliteEmbeddingShardPool = {
    mainPath: "/notes.sqlite3",
    vfsName: "test",
    openDatabase: () => shard,
    importDb() {},
    unlink() {},
    exportFile() {
      throw new Error("Unexpected export");
    },
  };
  const database = new NoteSqliteDatabase(db, pool);
  const request = {
    profile,
    checksum: "c".repeat(64),
    dimensions: 2,
    bytes: new Uint8Array([1]),
    now: 1,
  };
  return { db, shard, pool, database, request };
}

describe("Float32 storage and cosine scoring contract", () => {
  it.each([1e-30, 1e20, 2 ** -149, Math.fround(3.402823466e38)])(
    "accepts the same nonzero Float32 magnitudes in JS and native arithmetic: %s",
    async (value) => {
      const sqlite = await loadTestSqlite();
      const db = new sqlite.oo1.DB(":memory:", "c");
      try {
        const vector = [value, -value];
        expect(validateVector(vector, 2)).toBe(2 * Math.fround(value) ** 2);
        const bytes = encodeVector(vector, 2);
        expect(decodeVector(bytes, 2)).toEqual(vector.map(Math.fround));
        const dot = db.selectValue("SELECT trama_vector_dot(?,?)", [bytes, bytes]);
        expect(dot).toBe(2 * Math.fround(value) ** 2);
        expect(dot).toBeGreaterThan(0);
        expect(Number.isFinite(dot)).toBe(true);
      } finally {
        db.close();
      }
    }
  );

  it("checks each shard vector's native magnitude once before cancellation", async () => {
    const { db, shard, pool, database, request } = await shardFixture();
    const controller = new AbortController();
    let magnitudeCalls = 0;
    const connection: SqliteConnection = {
      exec(statement) {
        shard.exec(statement);
        if (typeof statement === "string" || !statement.sql.includes("trama_vector_dot")) return;
        shard.exec({
          sql: `EXPLAIN ${statement.sql}`,
          bind: statement.bind,
          rowMode: "object",
          callback: (row: Record<string, unknown>) => {
            if (row.opcode === "Function" && row.p4 === "trama_vector_dot(2)") magnitudeCalls++;
          },
        });
        controller.abort();
      },
      close: () => shard.close(),
    };
    // Inspect native validation without requiring OPFS; the browser harness covers real files.
    pool.openDatabase = () => connection;
    try {
      await expect(
        database.call("embeddingCacheSqliteImport", request, controller.signal)
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(magnitudeCalls).toBe(1);
    } finally {
      db.close();
    }
  });

  it.each([
    "a".repeat(64) + "\0suffix",
    "a".repeat(64) + "\0",
    "a".repeat(63) + "\0",
    "a".repeat(32) + "\0" + "b".repeat(31),
    "g".repeat(64),
  ])("rejects malformed shard hashes without persisting cache rows: %j", async (hash) => {
    const { db, database, request } = await shardFixture(hash);
    try {
      await expect(database.call("embeddingCacheSqliteImport", request)).rejects.toThrow(
        "SQLite shard data failed validation"
      );
      for (const table of [
        "embedding_cache",
        "embedding_cache_sqlite_imports",
        "embedding_cache_sqlite_publications",
      ])
        expect(db.selectValue(`SELECT count(*) FROM ${table}`)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rejects nonfinite native inputs and dimension mismatches", async () => {
    const sqlite = await loadTestSqlite();
    const db = new sqlite.oo1.DB(":memory:", "c");
    try {
      const good = encodeVector([1, 0], 2);
      for (const value of [NaN, Infinity, -Infinity]) {
        const bad = new Uint8Array(new Float32Array([value, 0]).buffer);
        expect(() => db.selectValue("SELECT trama_vector_dot(?,?)", [bad, good])).toThrow();
        expect(() => validateVector([value, 0])).toThrow();
      }
      expect(() =>
        db.selectValue("SELECT trama_vector_dot(?,?)", [new Uint8Array(3), good])
      ).toThrow();
      expect(() => validateVector([0, 0])).toThrow();
      expect(() => validateVector([1e-50, 0])).toThrow();
    } finally {
      db.close();
    }
  });

  it("uses cosine rankings independent of input magnitude, including rounded Float32 values", async () => {
    const sqlite = await loadTestSqlite();
    const db = new sqlite.oo1.DB(":memory:", "c");
    const database = new NoteSqliteDatabase(db);
    try {
      for (const [path, vector] of [
        ["aligned.md", [1e-30, 0]],
        ["diagonal.md", [1e20, 1e20]],
        ["opposite.md", [-3, 0]],
      ] as const)
        await database.call("noteStoreReplace", {
          uid: path,
          path,
          profile: "p",
          markdown: path,
          vectors: [vector],
        });
      for (const vector of [
        [1e-30, 0],
        [1e20, 0],
        [2 ** -149, 0],
      ]) {
        const hits = (await database.call("noteStoreSemantic", {
          vector,
          profile: "p",
          k: 3,
        })) as any[];
        expect(hits.map((hit) => hit.path)).toEqual(["aligned.md", "diagonal.md", "opposite.md"]);
        expect(hits[0].score).toBeCloseTo(1);
        expect(hits[1].score).toBeCloseTo(Math.SQRT1_2);
        expect(hits[2].score).toBeCloseTo(-1);
      }
    } finally {
      db.close();
    }
  });
});
