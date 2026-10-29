import { encodeVector, decodeVector } from "@/domain/vectors";
import { checkAbort, isCancelled } from "@/domain/errors";
import { CacheBackedEmbeddings } from "@langchain/classic/embeddings/cache_backed";
import { EncoderBackedStore } from "@langchain/classic/storage/encoder_backed";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { sha256 } from "@langchain/core/utils/hash";
import { BaseStore } from "@langchain/core/stores";
import type { NoteStoreCall, SqliteEmbeddingShard } from "./note-sqlite/protocol";

export function embeddingCacheIdentity(
  modelId: string,
  dimensions: number,
  endpointFingerprint?: string
): string {
  return JSON.stringify({
    modelId: modelId.trim(),
    dimensions,
    ...(endpointFingerprint ? { endpointFingerprint } : {}),
  });
}

type ScopedEmbeddings = EmbeddingsInterface<number[]> & {
  withSignal?(signal?: AbortSignal): EmbeddingsInterface<number[]>;
};

class SqliteVectorBytes extends BaseStore<string, Uint8Array> {
  lc_namespace = ["trama", "sqlite_embedding_cache"];

  constructor(
    private readonly call: NoteStoreCall,
    private readonly profile: string,
    private readonly task: "document" | "query",
    private readonly dimensions: number,
    private readonly signal?: AbortSignal
  ) {
    super();
  }

  async mget(keys: string[]): Promise<(Uint8Array | undefined)[]> {
    checkAbort(this.signal);
    const values = (await this.call(
      "embeddingCacheGet",
      { profile: this.profile, task: this.task, hashes: keys, now: Date.now() },
      this.signal
    )) as (Uint8Array | undefined)[];
    const invalid: string[] = [];
    const result = values.map((value, index) => {
      if (!value) return undefined;
      try {
        decodeVector(value, this.dimensions);
        return value.slice();
      } catch {
        invalid.push(keys[index]);
        return undefined;
      }
    });
    if (invalid.length) await this.mdelete(invalid);
    return result;
  }

  async mset(entries: [string, Uint8Array][]): Promise<void> {
    checkAbort(this.signal);
    if (entries.length > 512) throw new TypeError("Embedding cache batch is too large");
    await this.call(
      "embeddingCacheSet",
      {
        profile: this.profile,
        task: this.task,
        dimensions: this.dimensions,
        entries: entries.map(([hash, vector]) => ({ hash, vector })),
        now: Date.now(),
      },
      this.signal
    );
  }

  async mdelete(keys: string[]): Promise<void> {
    checkAbort(this.signal);
    if (keys.length > 512) throw new TypeError("Embedding cache batch is too large");
    await this.call(
      "embeddingCacheDelete",
      { profile: this.profile, task: this.task, hashes: keys },
      this.signal
    );
  }

  async *yieldKeys(prefix?: string): AsyncGenerator<string> {
    if (prefix) throw new TypeError("Embedding cache key prefixes are not supported");
    let after: string | undefined;
    while (true) {
      checkAbort(this.signal);
      const keys = (await this.call(
        "embeddingCacheKeys",
        {
          profile: this.profile,
          task: this.task,
          ...(after ? { after } : {}),
          limit: 512,
        },
        this.signal
      )) as string[];
      for (const key of keys) yield key;
      if (keys.length < 512) return;
      after = keys[keys.length - 1];
    }
  }
}

export class SqliteEmbeddingCache implements EmbeddingsInterface<number[]> {
  private readonly documents: CacheBackedEmbeddings;
  private readonly queries: SqliteVectorBytes;
  private readonly cacheProfile: string;

  constructor(
    private readonly underlying: ScopedEmbeddings,
    private readonly call: NoteStoreCall,
    private readonly profile: string,
    private readonly dimensions: number,
    private readonly signal?: AbortSignal
  ) {
    const cacheProfile = cacheHash(profile);
    this.cacheProfile = cacheProfile;
    const documentBytes = new SqliteVectorBytes(call, cacheProfile, "document", dimensions, signal);
    const encodedDocuments = new EncoderBackedStore<string, number[], Uint8Array>({
      store: documentBytes,
      keyEncoder: cacheHash,
      valueSerializer: (vector) => encodeVector(vector, dimensions),
      valueDeserializer: (bytes) => decodeVector(bytes, dimensions),
    });
    this.documents = new CacheBackedEmbeddings({
      underlyingEmbeddings: underlying,
      documentEmbeddingStore: encodedDocuments,
    });
    this.queries = new SqliteVectorBytes(call, cacheProfile, "query", dimensions, signal);
  }

  withSignal(signal?: AbortSignal): SqliteEmbeddingCache {
    const underlying = this.underlying.withSignal?.(signal) ?? this.underlying;
    return new SqliteEmbeddingCache(underlying, this.call, this.profile, this.dimensions, signal);
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    checkAbort(this.signal);
    return this.documents.embedDocuments(texts);
  }

  get profileFingerprint(): string {
    return this.cacheProfile;
  }

  unimportedSqliteShards(checksums: readonly string[], signal?: AbortSignal): Promise<string[]> {
    return this.call(
      "embeddingCacheSqliteCheckArtifacts",
      { profile: this.cacheProfile, checksums },
      signal
    ) as Promise<string[]>;
  }

  reconcileDocumentShards(checksums: readonly string[], signal?: AbortSignal): Promise<void> {
    return this.call(
      "embeddingCacheSqliteReconcile",
      { profile: this.cacheProfile, checksums },
      signal
    ).then(() => undefined);
  }

  importDocumentShard(
    checksum: string,
    bytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<{ imported: number; alreadyImported: boolean }> {
    return this.call(
      "embeddingCacheSqliteImport",
      {
        profile: this.cacheProfile,
        checksum,
        dimensions: this.dimensions,
        bytes,
        now: Date.now(),
      },
      signal
    ) as Promise<{ imported: number; alreadyImported: boolean }>;
  }

  exportNextDocumentShard(
    limit: number,
    signal?: AbortSignal
  ): Promise<SqliteEmbeddingShard | undefined> {
    return this.call(
      "embeddingCacheSqliteExport",
      { profile: this.cacheProfile, dimensions: this.dimensions, limit },
      signal
    ) as Promise<SqliteEmbeddingShard | undefined>;
  }

  markDocumentShardPublished(
    checksum: string,
    hashes: readonly string[],
    signal?: AbortSignal
  ): Promise<void> {
    return this.call(
      "embeddingCacheSqliteMarkPublished",
      { profile: this.cacheProfile, checksum, hashes, now: Date.now() },
      signal
    ).then(() => undefined);
  }

  async embedQuery(text: string): Promise<number[]> {
    checkAbort(this.signal);
    const hash = cacheHash(text);
    const cached = (await this.queries.mget([hash]))[0];
    if (cached) return decodeVector(cached, this.dimensions);
    const vector = await this.underlying.embedQuery(text);
    const bytes = encodeVector(vector, this.dimensions);
    checkAbort(this.signal);
    try {
      await this.queries.mset([[hash, bytes]]);
    } catch (error) {
      if (isCancelled(error)) throw error;
      // Persistence is optional once a valid provider vector is available.
    }
    checkAbort(this.signal);
    return vector;
  }
}

function cacheHash(value: string): string {
  return sha256(value);
}
