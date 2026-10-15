/* global Worker, crypto, performance, navigator */
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { ManualIndex, type ManualIndexVault } from "@/index/ManualIndex";
import { embeddingCacheIdentity, SqliteEmbeddingCache } from "@/index/SqliteEmbeddingCache";
import { SqliteNoteRecordManager } from "@/index/SqliteNoteRecordManager";
import { SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { VaultRetrieval } from "@/index/VaultRetrieval";
import { NoteStoreClient } from "@/index/note-sqlite/client";
import { VaultEmbeddingCache } from "@/plugin/VaultEmbeddingCache";
function deterministicVector(input: string): number[] {
  const vector = new Float32Array(768);
  for (const term of input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let hash = 2166136261;
    for (let i = 0; i < term.length; i++)
      hash = Math.imul(hash ^ term.charCodeAt(i), 16777619) >>> 0;
    vector[hash % 768] += hash & 0x80000000 ? 1 : -1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm) for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return Array.from(vector);
}

type Plan = {
  corpusSha256: string;
  dimensions: number;
  namespace: string;
  endpoint: string;
  modelId: string;
  queries: { lexical: string[]; hybrid: string[]; relatedPaths: string[] };
};
type Note = { path: string; content: string };
type Stats = { calls: number; texts: number; characters: number; elapsedMs: number };
type SqliteSnapshot = {
  pageCount: number;
  pageSize: number;
  mainDatabaseBytes: number;
  counts: Record<string, number>;
  poolNames?: string[];
  poolFileCount?: number;
  poolCapacity?: number;
  profile?: Record<string, { calls: number; elapsedMs: number; rows: number; bytes: number }>;
};

type ProfileValues = Record<
  string,
  { calls: number; elapsedMs: number; rows: number; bytes: number }
>;

function recordProfile(name: string, elapsedMs: number, rows = 0, bytes = 0): void {
  const profile = (globalThis as any).__tramaBenchProfile as { phases?: ProfileValues } | undefined;
  if (!profile) return;
  const value = ((profile.phases ??= {})[name] ??= { calls: 0, elapsedMs: 0, rows: 0, bytes: 0 });
  value.calls++;
  value.elapsedMs += elapsedMs;
  value.rows += rows;
  value.bytes += bytes;
}

async function measureProfile<T>(
  name: string,
  work: () => Promise<T>,
  rows = 0,
  bytes = 0
): Promise<T> {
  if (!(globalThis as any).__tramaBenchProfile) return work();
  const started = performance.now();
  try {
    return await work();
  } finally {
    recordProfile(name, performance.now() - started, rows, bytes);
  }
}

function profileSnapshot(): ProfileValues {
  return structuredClone(((globalThis as any).__tramaBenchProfile?.phases ?? {}) as ProfileValues);
}

function profileDelta(before: ProfileValues, after: ProfileValues): ProfileValues {
  const result: ProfileValues = {};
  for (const [name, value] of Object.entries(after)) {
    const previous = before[name] ?? { calls: 0, elapsedMs: 0, rows: 0, bytes: 0 };
    result[name] = {
      calls: value.calls - previous.calls,
      elapsedMs: value.elapsedMs - previous.elapsedMs,
      rows: value.rows - previous.rows,
      bytes: value.bytes - previous.bytes,
    };
  }
  return result;
}

function instrumentCacheRpc(cache: SqliteEmbeddingCache): void {
  const target = cache as any;
  for (const method of ["exportNextDocumentShard", "markDocumentShardPublished"] as const) {
    const original = target[method].bind(cache) as (...args: any[]) => Promise<any>;
    target[method] = async (...args: any[]) => {
      const started = performance.now();
      let result: any;
      try {
        result = await original(...args);
        return result;
      } finally {
        const rows =
          method === "exportNextDocumentShard"
            ? Number(result?.hashes?.length ?? 0)
            : Number(args[1]?.length ?? 0);
        const bytes =
          method === "exportNextDocumentShard" ? Number(result?.bytes?.byteLength ?? 0) : 0;
        recordProfile(`cache.${method}`, performance.now() - started, rows, bytes);
      }
    };
  }
}

(globalThis as any).__tramaBenchMeasureAsync = measureProfile;

class FixtureEmbeddings implements EmbeddingsInterface<number[]> {
  readonly stats: Stats = { calls: 0, texts: 0, characters: 0, elapsedMs: 0 };
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts);
  }
  async embedQuery(text: string): Promise<number[]> {
    return this.embed([text])[0];
  }
  private embed(texts: readonly string[]): number[][] {
    const started = performance.now();
    this.stats.calls++;
    this.stats.texts += texts.length;
    this.stats.characters += texts.reduce((sum, text) => sum + text.length, 0);
    const vectors = texts.map(deterministicVector) as number[][];
    this.stats.elapsedMs += performance.now() - started;
    return vectors;
  }
  snapshot(): Stats {
    return { ...this.stats };
  }
}

class FixtureAdapter {
  readonly files = new Map<string, Uint8Array>();
  private readonly folders = new Set<string>();
  writeCount = 0;
  writeBytes = 0;
  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return {
      files: [...this.files.keys()].filter((file) => file.startsWith(`${path}/`)),
      folders: [],
    };
  }
  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }
  async stat(path: string) {
    if (this.folders.has(path)) return { type: "folder" as const, ctime: 0, mtime: 0, size: 0 };
    const bytes = this.files.get(path);
    return bytes ? { type: "file" as const, ctime: 0, mtime: 0, size: bytes.byteLength } : null;
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`Missing artifact ${path}`);
    return bytes.slice().buffer;
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const bytes = new Uint8Array(data.slice(0));
    this.writeCount++;
    this.writeBytes += bytes.byteLength;
    this.files.set(path, bytes);
  }
  async rename(from: string, to: string): Promise<void> {
    const bytes = this.files.get(from);
    if (!bytes) throw new Error(`Missing temporary artifact ${from}`);
    this.files.delete(from);
    this.files.set(to, bytes);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  get totalBytes(): number {
    return [...this.files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
  }
}

class MeasuredArtifacts extends VaultEmbeddingCache {
  lastPublication = {
    elapsedMs: 0,
    temporaryFileWrites: 0,
    temporaryBytesWritten: 0,
    profile: {} as ProfileValues,
  };
  constructor(
    private readonly adapter: FixtureAdapter,
    cache: SqliteEmbeddingCache,
    dimensions: number
  ) {
    super(adapter as never, cache, dimensions);
    for (const method of [
      "exists",
      "list",
      "mkdir",
      "stat",
      "readBinary",
      "writeBinary",
      "rename",
      "remove",
    ] as const) {
      const target = adapter as any;
      const original = target[method].bind(adapter) as (...args: any[]) => Promise<any>;
      target[method] = async (...args: any[]) => {
        const started = performance.now();
        let result: any;
        try {
          result = await original(...args);
          return result;
        } finally {
          const bytes =
            method === "writeBinary"
              ? Number(args[1]?.byteLength ?? 0)
              : method === "readBinary"
                ? Number(result?.byteLength ?? 0)
                : 0;
          recordProfile(`vault.adapter.${method}`, performance.now() - started, 0, bytes);
        }
      };
    }
  }
  async publishAvailable(signal: AbortSignal): Promise<void> {
    const started = performance.now();
    const count = this.adapter.writeCount;
    const bytes = this.adapter.writeBytes;
    const profile = profileSnapshot();
    try {
      await super.publishAvailable(signal);
    } finally {
      this.lastPublication = {
        elapsedMs: performance.now() - started,
        temporaryFileWrites: this.adapter.writeCount - count,
        temporaryBytesWritten: this.adapter.writeBytes - bytes,
        profile: profileDelta(profile, profileSnapshot()),
      };
    }
  }
}

export async function runWorkload(
  plan: Plan,
  notes: readonly Note[],
  queryWarmups: number,
  querySamples: number,
  workerUrl: string
) {
  const namespace = crypto.randomUUID().replaceAll("-", "").padStart(64, "0").slice(0, 64);
  const contents = new Map(notes.map((note) => [note.path, note.content]));
  const worker = new Worker(workerUrl, { type: "module" });
  const client = new NoteStoreClient(worker, namespace);
  await client.initialize();
  const embeddings = new FixtureEmbeddings();
  const profile = { endpoint: plan.endpoint, modelId: plan.modelId, dimensions: plan.dimensions };
  const cache = new SqliteEmbeddingCache(
    embeddings,
    client.call,
    embeddingCacheIdentity(profile.modelId, profile.dimensions),
    profile.dimensions
  );
  instrumentCacheRpc(cache);
  const artifacts = new FixtureAdapter();
  const measured = new MeasuredArtifacts(artifacts, cache, profile.dimensions);
  const store = new SqliteNoteVectorStore(
    cache,
    client.call,
    async (path) => contents.get(path) ?? null,
    profile
  );
  const vault: ManualIndexVault = {
    listMarkdownPaths: async () => {
      const started = performance.now();
      try {
        return [...contents.keys()].sort();
      } finally {
        recordProfile("vault.listMarkdownPaths", performance.now() - started, contents.size);
      }
    },
    readMarkdown: async (path) => {
      const started = performance.now();
      try {
        const content = contents.get(path);
        if (content === undefined) throw new Error(`Missing benchmark note ${path}`);
        return { path, content };
      } finally {
        recordProfile("vault.readMarkdown", performance.now() - started, 1);
      }
    },
  };
  const manager = new ManualIndex(vault, store, new SqliteNoteRecordManager(client.call), measured);
  const started = performance.now();
  const indexed = await manager.update();
  if (indexed.sharing !== "complete") throw new Error(`Cold index sharing ${indexed.sharing}`);
  const coldIndexMs = performance.now() - started;
  const initialProvider = embeddings.snapshot();
  const coldPublication = { ...measured.lastPublication };
  const initialArtifactCount = artifacts.files.size;
  const initialArtifactBytes = artifacts.totalBytes;
  const initialSqlite = await inspectSqlite(client);
  const databaseBytes = await opfsPoolBytes(namespace);
  const retrieval = new VaultRetrieval(client.call, cache, store.embeddingProfile, async (path) => {
    const content = contents.get(path);
    return content === undefined ? null : { path, content };
  });
  const queries = await querySuite(
    async (kind, ordinal) => {
      if (kind === "lexical") {
        const result = await retrieval.runnable.invoke({
          query: plan.queries.lexical[ordinal % plan.queries.lexical.length],
          mode: "lexical",
        });
        return result.documents.map((document) => ({ path: document.metadata.path }));
      }
      if (kind === "hybrid") {
        const result = await retrieval.runnable.invoke({
          query: plan.queries.hybrid[ordinal % plan.queries.hybrid.length],
          mode: "hybrid",
        });
        return result.documents.map((document) => ({ path: document.metadata.path }));
      }
      const result = await retrieval.related(
        plan.queries.relatedPaths[ordinal % plan.queries.relatedPaths.length],
        new AbortController().signal,
        7
      );
      return result.documents.map((document) => ({ path: document.metadata.path }));
    },
    queryWarmups,
    querySamples,
    () => embeddings.snapshot()
  );

  const bootstrapNs = crypto.randomUUID().replaceAll("-", "").padStart(64, "0").slice(0, 64);
  const bootstrapWorker = new Worker(workerUrl, { type: "module" });
  const bootstrapClient = new NoteStoreClient(bootstrapWorker, bootstrapNs);
  await bootstrapClient.initialize();
  const bootstrapProviderBefore = embeddings.snapshot();
  const bootstrapStart = performance.now();
  const bootstrapCache = new SqliteEmbeddingCache(
    embeddings,
    bootstrapClient.call,
    embeddingCacheIdentity(profile.modelId, profile.dimensions),
    profile.dimensions
  );
  const bootstrapStore = new SqliteNoteVectorStore(
    bootstrapCache,
    bootstrapClient.call,
    async (path) => contents.get(path) ?? null,
    profile
  );
  const bootstrapVault: ManualIndexVault = {
    listMarkdownPaths: async () => notes.map((note) => note.path).sort(),
    readMarkdown: async (path) => ({
      path,
      content: notes.find((note) => note.path === path)!.content,
    }),
  };
  const bootstrapResult = await new ManualIndex(
    bootstrapVault,
    bootstrapStore,
    new SqliteNoteRecordManager(bootstrapClient.call),
    new VaultEmbeddingCache(artifacts as never, bootstrapCache, profile.dimensions)
  ).update();
  const bootstrapProviderAfter = embeddings.snapshot();
  if (
    bootstrapResult.sharing !== "complete" ||
    bootstrapProviderAfter.calls !== bootstrapProviderBefore.calls
  )
    throw new Error("Shared-artifact bootstrap failed or called the provider");
  const sharedBootstrap = {
    elapsedMs: performance.now() - bootstrapStart,
    artifactFiles: artifacts.files.size,
    artifactBytes: artifacts.totalBytes,
    noteCount: bootstrapResult.visited,
    providerCalls: bootstrapProviderAfter.calls - bootstrapProviderBefore.calls,
    providerTexts: bootstrapProviderAfter.texts - bootstrapProviderBefore.texts,
    sharing: bootstrapResult.sharing,
    sqlite: await inspectSqlite(bootstrapClient),
  };
  await bootstrapClient.close();

  const before = embeddings.snapshot();
  const unchangedProfileBefore = await inspectSqlite(client);
  const unchangedVaultBefore = profileSnapshot();
  const operationStart = performance.now();
  const unchanged = await manager.update();
  if (unchanged.sharing !== "complete")
    throw new Error(`Unchanged update sharing ${unchanged.sharing}`);
  const unchangedElapsedMs = performance.now() - operationStart;
  const unchangedProfileAfter = await inspectSqlite(client);
  const unchangedResult = operationResult(
    unchangedElapsedMs,
    before,
    embeddings.snapshot(),
    measured.lastPublication,
    profileDelta(unchangedProfileBefore.profile ?? {}, unchangedProfileAfter.profile ?? {}),
    profileDelta(unchangedVaultBefore, profileSnapshot())
  );

  const firstPath = notes[0].path;
  contents.set(firstPath, `${notes[0].content.slice(0, -1)}y`);
  const editBefore = embeddings.snapshot();
  const editStart = performance.now();
  const edited = await manager.update();
  if (edited.sharing !== "complete") throw new Error(`Edit sharing ${edited.sharing}`);
  const editResult = operationResult(
    performance.now() - editStart,
    editBefore,
    embeddings.snapshot(),
    measured.lastPublication
  );

  contents.delete(notes.at(-1)!.path);
  const deleteBefore = embeddings.snapshot();
  const deleteProfileBefore = await inspectSqlite(client);
  const deleteVaultBefore = profileSnapshot();
  const deleteStart = performance.now();
  const deleted = await manager.update();
  if (deleted.sharing !== "complete") throw new Error(`Delete sharing ${deleted.sharing}`);
  const deleteElapsedMs = performance.now() - deleteStart;
  const deleteProfileAfter = await inspectSqlite(client);
  const deleteResult = operationResult(
    deleteElapsedMs,
    deleteBefore,
    embeddings.snapshot(),
    measured.lastPublication,
    profileDelta(deleteProfileBefore.profile ?? {}, deleteProfileAfter.profile ?? {}),
    profileDelta(deleteVaultBefore, profileSnapshot())
  );

  const finalSqlite = await inspectSqlite(client);
  await client.close();
  return {
    coldIndexMs,
    initial: {
      noteCount: indexed.visited,
      vectorCount: initialSqlite.counts.note_vectors,
      chunkCount: initialSqlite.counts.note_vectors,
      provider: initialProvider,
      publication: coldPublication,
      artifactCount: initialArtifactCount,
      artifactBytes: initialArtifactBytes,
      opfsPoolBytes: databaseBytes,
      sqlite: initialSqlite,
      sharedBootstrap,
    },
    operations: { unchanged: unchangedResult, oneEdit: editResult, oneDelete: deleteResult },
    queries,
    finalNoteCount: notes.length - 1,
    finalSqlite,
  };
}

function inspectSqlite(client: NoteStoreClient): Promise<SqliteSnapshot> {
  return (client.call as any)("__benchSnapshot", {}) as Promise<SqliteSnapshot>;
}

async function opfsPoolBytes(namespace: string): Promise<number> {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(`trama-note-v2-${namespace}`);
  let bytes = 0;
  for await (const [, handle] of directory.entries()) {
    if (handle.kind === "file") bytes += (await handle.getFile()).size;
    else {
      const opaque = await directory.getDirectoryHandle(handle.name);
      for await (const [, child] of opaque.entries())
        if (child.kind === "file") bytes += (await child.getFile()).size;
    }
  }
  return bytes;
}

async function querySuite(
  query: (kind: "lexical" | "hybrid" | "related", ordinal: number) => Promise<{ path: string }[]>,
  warmups: number,
  samples: number,
  snapshot: () => Stats
) {
  const results: Record<string, unknown> = {};
  let random = 0x5eed768;
  for (const kind of ["lexical", "hybrid", "related"] as const) {
    const timingsMs: number[] = [];
    let returned = 0;
    const provider = { calls: 0, texts: 0, characters: 0, elapsedMs: 0 };
    for (let ordinal = 0; ordinal < warmups + samples; ordinal++) {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      random >>>= 0;
      const before = snapshot();
      const start = performance.now();
      const rows = await query(kind, random % 5);
      const elapsed = performance.now() - start;
      const after = snapshot();
      if (rows.length > (kind === "related" ? 7 : 20))
        throw new Error(`${kind} exceeded result bound`);
      if (ordinal >= warmups) {
        timingsMs.push(elapsed);
        returned += rows.length;
        provider.calls += after.calls - before.calls;
        provider.texts += after.texts - before.texts;
        provider.characters += after.characters - before.characters;
        provider.elapsedMs += after.elapsedMs - before.elapsedMs;
      }
    }
    const sentinel = await query(kind, 0);
    if (kind === "lexical" && !sentinel.some((row) => row.path === "notes/0000.md"))
      throw new Error("Lexical sentinel missing");
    if (
      kind === "hybrid" &&
      !sentinel.some((row) => row.path === "notes/0001.md" || row.path === "notes/0002.md")
    )
      throw new Error("Hybrid sentinel missing");
    if (kind === "related" && !sentinel.some((row) => row.path === "notes/0002.md"))
      throw new Error("Related sentinel missing");
    results[kind] = {
      timingsMs,
      meanResults: returned / Math.max(1, timingsMs.length),
      sentinelPaths: sentinel.map((row) => row.path),
      provider,
    };
  }
  return results;
}

function operationResult(
  elapsedMs: number,
  before: Stats,
  after: Stats,
  publication: MeasuredArtifacts["lastPublication"],
  recordManagerProfile: ProfileValues = {},
  vaultProfile: ProfileValues = {}
) {
  return {
    elapsedMs,
    publication: { ...publication },
    recordManagerProfile,
    vaultProfile,
    provider: {
      calls: after.calls - before.calls,
      texts: after.texts - before.texts,
      characters: after.characters - before.characters,
      elapsedMs: after.elapsedMs - before.elapsedMs,
    },
  };
}
