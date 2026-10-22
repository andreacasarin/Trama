import { describe, expect, it } from "vitest";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { sha256 } from "@langchain/core/utils/hash";
import { embeddingCacheIdentity, SqliteEmbeddingCache } from "@/index/SqliteEmbeddingCache";
import { embeddingEndpointFingerprint } from "@/index/SqliteNoteVectorStore";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import type { SqliteConnection } from "@/index/note-sqlite/protocol";
import { loadTestSqlite } from "./note-sqlite-test-client";

class CountingEmbeddings implements EmbeddingsInterface<number[]> {
  readonly documentCalls: string[][] = [];
  readonly queryCalls: string[] = [];
  fail = false;
  holdDocuments = false;
  holdQuery = false;
  releaseDocuments?: (vectors: number[][]) => void;
  releaseQuery?: (vector: number[]) => void;

  async embedDocuments(texts: string[]): Promise<number[][]> {
    this.documentCalls.push([...texts]);
    if (this.fail) throw new Error("provider failed");
    if (this.holdDocuments) return new Promise((resolve) => (this.releaseDocuments = resolve));
    return texts.map(() => [0.25, 0.75]);
  }

  async embedQuery(text: string): Promise<number[]> {
    this.queryCalls.push(text);
    if (this.fail) throw new Error("provider failed");
    if (this.holdQuery) return new Promise((resolve) => (this.releaseQuery = resolve));
    return [0.5, 0.5];
  }

  withSignal(signal?: AbortSignal): EmbeddingsInterface<number[]> {
    return {
      embedDocuments: async (texts) => {
        if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
        const operation = this.embedDocuments(texts);
        if (!signal) return operation;
        return Promise.race([
          operation,
          new Promise<number[][]>((_, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Request cancelled", "AbortError")),
              { once: true }
            );
          }),
        ]);
      },
      embedQuery: async (text) => {
        if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
        const operation = this.embedQuery(text);
        if (!signal) return operation;
        return Promise.race([
          operation,
          new Promise<number[]>((_, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Request cancelled", "AbortError")),
              { once: true }
            );
          }),
        ]);
      },
    };
  }
}

async function fixture() {
  const sqlite = await loadTestSqlite();
  const db = new sqlite.oo1.DB(":memory:", "c") as SqliteConnection;
  const database = new NoteSqliteDatabase(db);
  return { db, database };
}

async function publicationFixture() {
  const sqlite = await loadTestSqlite();
  const db = new sqlite.oo1.DB(":memory:", "c") as SqliteConnection;
  const publicationStatements: string[] = [];
  let cancelAfterPublication: AbortController | undefined;
  const connection: SqliteConnection = {
    exec(statement) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (sql.startsWith("INSERT INTO embedding_cache_sqlite_publications")) {
        publicationStatements.push(sql);
        if (cancelAfterPublication) {
          const controller = cancelAfterPublication;
          cancelAfterPublication = undefined;
          setTimeout(() => controller.abort(), 0);
        }
      }
      db.exec(statement as any);
    },
    close: () => db.close(),
  };
  return {
    db,
    database: new NoteSqliteDatabase(connection),
    publicationStatements,
    cancelAfterPublication(controller: AbortController) {
      cancelAfterPublication = controller;
    },
  };
}

function queryRows(
  db: SqliteConnection,
  sql: string,
  bind: readonly unknown[] = []
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  db.exec({ sql, bind, rowMode: "object", callback: (row) => result.push(row) });
  return result;
}

const profile = embeddingCacheIdentity("test", 2);

describe("SQLite embedding cache", () => {
  it("records only existing document hashes in one bounded set-based publication statement", async () => {
    const f = await publicationFixture();
    const cacheProfile = sha256(profile);
    const otherProfile = sha256("other profile");
    const existingHash = sha256("existing document");
    const unpublishedHash = sha256("unpublished document");
    const queryHash = sha256("query vector");
    const otherProfileHash = sha256("other profile document");
    const newChecksum = sha256("new artifact");
    const oldChecksum = sha256("first artifact");
    try {
      const vector = new Uint8Array(new Float32Array([0.6, 0.8]).buffer);
      await f.database.call("embeddingCacheSet", {
        profile: cacheProfile,
        task: "document",
        dimensions: 2,
        entries: [existingHash, unpublishedHash].map((hash) => ({ hash, vector })),
        now: 1,
      });
      await f.database.call("embeddingCacheSet", {
        profile: cacheProfile,
        task: "query",
        dimensions: 2,
        entries: [{ hash: queryHash, vector }],
        now: 1,
      });
      await f.database.call("embeddingCacheSet", {
        profile: otherProfile,
        task: "document",
        dimensions: 2,
        entries: [{ hash: otherProfileHash, vector }],
        now: 1,
      });
      f.db.exec({
        sql: "INSERT INTO embedding_cache_sqlite_publications(profile,hash,checksum,published_at) VALUES(?,?,?,?)",
        bind: [cacheProfile, existingHash, oldChecksum, 2],
      });
      expect(queryRows(f.db, "SELECT profile,task,hash FROM embedding_cache")).toHaveLength(4);

      await f.database.call("embeddingCacheSqliteMarkPublished", {
        profile: cacheProfile,
        checksum: newChecksum,
        hashes: [existingHash, unpublishedHash, queryHash, otherProfileHash, existingHash],
        now: 3,
      });
      expect(f.publicationStatements).toHaveLength(1);
      expect(f.publicationStatements[0]).toContain("e.task='document'");
      expect(f.publicationStatements[0]).toContain("e.hash IN (?,?,?,?,?)");
      expect(
        queryRows(
          f.db,
          "SELECT hash,checksum FROM embedding_cache_sqlite_publications WHERE profile=? ORDER BY hash",
          [cacheProfile]
        )
      ).toEqual([
        { hash: existingHash, checksum: oldChecksum },
        { hash: unpublishedHash, checksum: newChecksum },
      ]);
      expect(
        queryRows(f.db, "SELECT checksum FROM embedding_cache_sqlite_imports WHERE profile=?", [
          cacheProfile,
        ])
      ).toEqual([{ checksum: newChecksum }]);
    } finally {
      f.db.close();
    }
  });

  it("rolls back the bounded publication and artifact receipt when cancelled after its SQL step", async () => {
    const f = await publicationFixture();
    const cacheProfile = sha256(profile);
    const documentHash = sha256("cancelled receipt document");
    const checksum = sha256("cancelled receipt artifact");
    const controller = new AbortController();
    try {
      await f.database.call("embeddingCacheSet", {
        profile: cacheProfile,
        task: "document",
        dimensions: 2,
        entries: [
          { hash: documentHash, vector: new Uint8Array(new Float32Array([0.6, 0.8]).buffer) },
        ],
        now: 1,
      });
      f.cancelAfterPublication(controller);
      await expect(
        f.database.call(
          "embeddingCacheSqliteMarkPublished",
          { profile: cacheProfile, checksum, hashes: [documentHash], now: 2 },
          controller.signal
        )
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(f.publicationStatements).toHaveLength(1);
      expect(
        Number(
          queryRows(
            f.db,
            "SELECT count(*) AS count FROM embedding_cache_sqlite_publications WHERE profile=?",
            [cacheProfile]
          )[0].count
        )
      ).toBe(0);
      expect(
        Number(
          queryRows(
            f.db,
            "SELECT count(*) AS count FROM embedding_cache_sqlite_imports WHERE profile=? AND checksum=?",
            [cacheProfile, checksum]
          )[0].count
        )
      ).toBe(0);
    } finally {
      f.db.close();
    }
  });

  it("reuses document and query vectors across endpoint changes for the same model and dimensions", async () => {
    const f = await fixture();
    try {
      const endpointA = {
        endpoint: "http://127.0.0.1:1234/v1",
        modelId: "test",
        dimensions: 2,
      };
      const endpointB = { ...endpointA, endpoint: "http://127.0.0.1:4321/v1" };
      const firstProvider = new CountingEmbeddings();
      const secondProvider = new CountingEmbeddings();
      const first = new SqliteEmbeddingCache(
        firstProvider,
        f.database.call.bind(f.database),
        embeddingCacheIdentity(endpointA.modelId, endpointA.dimensions),
        endpointA.dimensions
      );
      const second = new SqliteEmbeddingCache(
        secondProvider,
        f.database.call.bind(f.database),
        embeddingCacheIdentity(endpointB.modelId, endpointB.dimensions),
        endpointB.dimensions
      );
      expect(await first.embedDocuments(["same exact input"])).toEqual([[0.25, 0.75]]);
      expect(await second.embedDocuments(["same exact input"])).toEqual([[0.25, 0.75]]);
      expect(firstProvider.documentCalls).toEqual([["same exact input"]]);
      expect(secondProvider.documentCalls).toEqual([]);

      expect(await first.embedQuery("same exact input")).toEqual([0.5, 0.5]);
      expect(await second.embedQuery("same exact input")).toEqual([0.5, 0.5]);
      expect(firstProvider.queryCalls).toEqual(["same exact input"]);
      expect(secondProvider.queryCalls).toEqual([]);

      const rows = queryRows(
        f.db,
        "SELECT profile,task,hash,length(vector) AS bytes FROM embedding_cache ORDER BY task"
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.task)).toEqual(["document", "query"]);
      expect(rows.every((row) => row.bytes === 8 && row.profile === sha256(profile))).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("same exact input");
      expect(JSON.stringify(rows)).not.toContain("127.0.0.1");
    } finally {
      f.db.close();
    }
  });

  it("separates cached vectors for endpoint query variants without storing query text", async () => {
    const f = await fixture();
    try {
      const endpointA = "https://user:secret@embed.example.com/v1?tenant=alpha#one";
      const endpointB = "https://user:secret@embed.example.com/v1?tenant=beta#one";
      const firstProvider = new CountingEmbeddings();
      const secondProvider = new CountingEmbeddings();
      const identity = (endpoint: string) =>
        embeddingCacheIdentity("same-model", 2, embeddingEndpointFingerprint(endpoint));
      const first = new SqliteEmbeddingCache(
        firstProvider,
        f.database.call.bind(f.database),
        identity(endpointA),
        2
      );
      const second = new SqliteEmbeddingCache(
        secondProvider,
        f.database.call.bind(f.database),
        identity(endpointB),
        2
      );

      await first.embedDocuments(["same document"]);
      await second.embedDocuments(["same document"]);
      await first.embedQuery("same query");
      await second.embedQuery("same query");

      expect(firstProvider.documentCalls).toEqual([["same document"]]);
      expect(secondProvider.documentCalls).toEqual([["same document"]]);
      expect(firstProvider.queryCalls).toEqual(["same query"]);
      expect(secondProvider.queryCalls).toEqual(["same query"]);
      const stored = JSON.stringify(queryRows(f.db, "SELECT profile FROM embedding_cache"));
      expect(stored).not.toContain("secret");
      expect(stored).not.toContain("tenant=");
      expect(stored).not.toContain("#one");
      expect(stored).not.toContain("same document");
    } finally {
      f.db.close();
    }
  });

  it("separates exact inputs and embedding profiles", async () => {
    const f = await fixture();
    try {
      const provider = new CountingEmbeddings();
      const first = new SqliteEmbeddingCache(
        provider,
        f.database.call.bind(f.database),
        profile,
        2
      );
      const otherProfile = new SqliteEmbeddingCache(
        provider,
        f.database.call.bind(f.database),
        embeddingCacheIdentity("other-model", 2),
        2
      );
      const otherDimensions = new SqliteEmbeddingCache(
        provider,
        f.database.call.bind(f.database),
        embeddingCacheIdentity("test", 3),
        3
      );
      await first.embedDocuments(["same text"]);
      await first.embedDocuments(["same text "]);
      await otherProfile.embedDocuments(["same text"]);
      await expect(otherDimensions.embedDocuments(["same text"])).rejects.toThrow(
        "Embedding vector dimensions or values are invalid"
      );
      expect(provider.documentCalls).toEqual([
        ["same text"],
        ["same text "],
        ["same text"],
        ["same text"],
      ]);
      expect(queryRows(f.db, "SELECT count(*) AS count FROM embedding_cache")[0].count).toBe(3);
    } finally {
      f.db.close();
    }
  });

  it("canonicalizes the shared cache identity from trimmed model and dimensions only", () => {
    expect(embeddingCacheIdentity("  local-model  ", 768)).toBe(
      JSON.stringify({ modelId: "local-model", dimensions: 768 })
    );
  });

  it("bounds and expires query entries while preserving document entries", async () => {
    const f = await fixture();
    try {
      const hashes = Array.from({ length: 512 }, (_, index) =>
        sha256(`query-${index.toString().padStart(4, "0")}`)
      );
      const vectors = hashes.map((hash) => ({
        hash,
        vector: new Uint8Array(new Float32Array([0.5, 0.5]).buffer),
      }));
      const cacheProfile = sha256(profile);
      await f.database.call("embeddingCacheSet", {
        profile: cacheProfile,
        task: "query",
        dimensions: 2,
        entries: vectors,
        now: 1_000_000,
      });
      const later = Array.from({ length: 512 }, (_, index) => ({
        hash: sha256(`later-${index.toString().padStart(4, "0")}`),
        vector: new Uint8Array(new Float32Array([0.25, 0.75]).buffer),
      }));
      await f.database.call("embeddingCacheSet", {
        profile: cacheProfile,
        task: "query",
        dimensions: 2,
        entries: later,
        now: 2_000_000,
      });
      await f.database.call("embeddingCacheSet", {
        profile: cacheProfile,
        task: "document",
        dimensions: 2,
        entries: [{ hash: sha256("document"), vector: vectors[0].vector }],
        now: 1_000_000,
      });
      const beforeExpiry = queryRows(
        f.db,
        "SELECT task,count(*) AS count FROM embedding_cache GROUP BY task ORDER BY task"
      );
      expect(beforeExpiry).toEqual([
        { task: "document", count: 1 },
        { task: "query", count: 1000 },
      ]);
      await f.database.call("embeddingCacheGet", {
        profile: cacheProfile,
        task: "query",
        hashes: [later[0].hash],
        now: 2_000_000 + 30 * 24 * 60 * 60 * 1000 + 1,
      });
      expect(
        queryRows(f.db, "SELECT task,count(*) AS count FROM embedding_cache GROUP BY task")
      ).toEqual([{ task: "document", count: 1 }]);
    } finally {
      f.db.close();
    }
  });

  it("does not persist failed or cancelled provider results and rejects invalid cache vectors", async () => {
    const f = await fixture();
    try {
      const provider = new CountingEmbeddings();
      const embeddings = new SqliteEmbeddingCache(
        provider,
        f.database.call.bind(f.database),
        profile,
        2
      );
      provider.fail = true;
      await expect(embeddings.embedDocuments(["failed document"])).rejects.toThrow(
        "provider failed"
      );
      await expect(embeddings.embedQuery("failed query")).rejects.toThrow("provider failed");
      const controller = new AbortController();
      controller.abort();
      await expect(
        embeddings.withSignal(controller.signal).embedQuery("cancelled query")
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(queryRows(f.db, "SELECT count(*) AS count FROM embedding_cache")[0].count).toBe(0);
      provider.fail = false;
      provider.holdDocuments = true;
      const documentController = new AbortController();
      const pendingDocuments = embeddings
        .withSignal(documentController.signal)
        .embedDocuments(["in-flight document"]);
      await Promise.resolve();
      documentController.abort();
      await expect(pendingDocuments).rejects.toMatchObject({ name: "AbortError" });
      provider.releaseDocuments?.([[0.25, 0.75]]);
      await Promise.resolve();
      expect(queryRows(f.db, "SELECT count(*) AS count FROM embedding_cache")[0].count).toBe(0);
      provider.holdDocuments = false;
      provider.holdQuery = true;
      const inFlightController = new AbortController();
      const inFlight = embeddings
        .withSignal(inFlightController.signal)
        .embedQuery("in-flight query");
      await Promise.resolve();
      inFlightController.abort();
      await expect(inFlight).rejects.toMatchObject({ name: "AbortError" });
      provider.releaseQuery?.([0.5, 0.5]);
      await Promise.resolve();
      expect(queryRows(f.db, "SELECT count(*) AS count FROM embedding_cache")[0].count).toBe(0);
      await expect(
        f.database.call("embeddingCacheSet", {
          profile: sha256(profile),
          task: "document",
          dimensions: 2,
          entries: [
            { hash: sha256("invalid"), vector: new Uint8Array(new Float32Array([NaN, 1]).buffer) },
          ],
          now: Date.now(),
        })
      ).rejects.toThrow("Invalid embedding cache values");
      expect(queryRows(f.db, "SELECT count(*) AS count FROM embedding_cache")[0].count).toBe(0);
    } finally {
      f.db.close();
    }
  });
});
