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
    return values.map((value) => value?.slice());
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
    const vector = validateVector(await this.underlying.embedQuery(text), this.dimensions);
    checkAbort(this.signal);
    await this.queries.mset([[hash, encodeVector(vector, this.dimensions)]]);
    return vector;
  }
}

function cacheHash(value: string): string {
  return sha256(value);
}

function encodeVector(vector: number[], dimensions: number): Uint8Array {
  const valid = validateVector(vector, dimensions);
  const bytes = new Uint8Array(dimensions * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < dimensions; index++) view.setFloat32(index * 4, valid[index], true);
  if (
    Array.from({ length: dimensions }, (_, index) => view.getFloat32(index * 4, true)).some(
      (value) => !Number.isFinite(value)
    )
  )
    throw new TypeError("Embedding vector values exceed Float32 range");
  return bytes;
}

function decodeVector(bytes: Uint8Array, dimensions: number): number[] {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== dimensions * 4)
    throw new TypeError("Cached embedding dimensions are invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = Array.from({ length: dimensions }, (_, index) => view.getFloat32(index * 4, true));
  return validateVector(vector, dimensions);
}

function validateVector(vector: number[], dimensions: number): number[] {
  if (
    !Array.isArray(vector) ||
    vector.length !== dimensions ||
    vector.some((value) => !Number.isFinite(value))
  )
    throw new TypeError("Embedding vector dimensions or values are invalid");
  return vector;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
}
