import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { ManualIndex, type ManualIndexVault } from "@/index/ManualIndex";
import { embeddingCacheIdentity, SqliteEmbeddingCache } from "@/index/SqliteEmbeddingCache";
import { SqliteNoteRecordManager } from "@/index/SqliteNoteRecordManager";
import { SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { VaultRetrieval } from "@/index/VaultRetrieval";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { NoteStoreClient, type NoteStoreWorkerLike } from "@/index/note-sqlite/client";
import type { NoteStoreMethod, NoteStoreRpc } from "@/index/note-sqlite/protocol";
import { VaultEmbeddingCache } from "@/plugin/VaultEmbeddingCache";
import { loadTestSqlite } from "./note-sqlite-test-client";
// @ts-expect-error The copied benchmark fixture is plain ESM shared with the runner.
import { deterministicVector } from "../scripts/benchmark/performance-fixture.mjs";

interface PerformancePlan {
  readonly corpusSha256: string;
  readonly dimensions: number;
  readonly namespace: string;
  readonly endpoint: string;
  readonly modelId: string;
  readonly queries: {
    readonly lexical: readonly string[];
    readonly hybrid: readonly string[];
    readonly relatedPaths: readonly string[];
  };
  readonly runs: readonly {
    readonly count: number;
    readonly warmups: number;
    readonly samples: number;
    readonly queryWarmups: number;
    readonly querySamples: number;
  }[];
}

interface ProviderStats {
  calls: number;
  texts: number;
  characters: number;
  elapsedMs: number;
}

const plan = JSON.parse(readFileSync(process.env.TRAMA_BENCHMARK_PLAN!, "utf8")) as PerformancePlan;
const report: Record<string, unknown>[] = [];

class FixtureEmbeddings implements EmbeddingsInterface<number[]> {
  readonly stats: ProviderStats = { calls: 0, texts: 0, characters: 0, elapsedMs: 0 };
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
    const vectors = texts.map(deterministicVector);
    this.stats.elapsedMs += performance.now() - started;
    return vectors;
  }
  snapshot(): ProviderStats {
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

class MeasuredVaultEmbeddingCache extends VaultEmbeddingCache {
  lastPublication = { elapsedMs: 0, temporaryFileWrites: 0, temporaryBytesWritten: 0 };

  constructor(
    private readonly measuredAdapter: FixtureAdapter,
    cache: SqliteEmbeddingCache,
    dimensions: number
  ) {
    super(measuredAdapter, cache, dimensions);
  }

  async publishAvailable(signal: AbortSignal): Promise<void> {
    const started = performance.now();
    const writesBefore = this.measuredAdapter.writeCount;
    const bytesBefore = this.measuredAdapter.writeBytes;
    try {
      await super.publishAvailable(signal);
    } finally {
      this.lastPublication = {
        elapsedMs: performance.now() - started,
        temporaryFileWrites: this.measuredAdapter.writeCount - writesBefore,
        temporaryBytesWritten: this.measuredAdapter.writeBytes - bytesBefore,
      };
    }
  }
}

class Worker implements NoteStoreWorkerLike {
  private readonly listeners = new Set<(event: any) => void>();
  constructor(
    private readonly db: any,
    private readonly database: NoteSqliteDatabase
  ) {}
  addEventListener(_type: "message" | "error" | "messageerror", listener: (event: any) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "message" | "error" | "messageerror", listener: (event: any) => void) {
    this.listeners.delete(listener);
  }
  terminate(): void {}
  postMessage(raw: unknown): void {
    const request = raw as { id: number; method: string; payload: unknown };
    if (request.method === "cancel") return;
    queueMicrotask(async () => {
      try {
        const result =
          request.method === "init" || request.method === "close"
            ? undefined
            : await this.database.call(
                request.method as NoteStoreMethod,
                request.payload as NoteStoreRpc[NoteStoreMethod]
              );
        if (request.method === "close") this.db.close();
        this.emit({ id: request.id, ok: true, result });
      } catch (error) {
        this.emit({
          id: request.id,
          ok: false,
          error: { name: (error as Error).name, message: (error as Error).message },
        });
      }
    });
  }
  private emit(data: unknown): void {
    for (const listener of this.listeners) listener({ data });
  }
}

describe("paired benchmark current adapter", () => {
  it(
    "runs the shared index, mutation, and retrieval plan on real SQLite WASM",
    async () => {
      const corpus = JSON.parse(readFileSync(process.env.TRAMA_BENCHMARK_CORPUS!, "utf8")) as {
        sha256: string;
        notes: { path: string; content: string }[];
      };
      expect(corpus.sha256).toBe(plan.corpusSha256);
      for (const run of plan.runs) {
        const notes = corpus.notes.slice(0, run.count);
        const warmups: Record<string, unknown>[] = [];
        for (let index = 0; index < run.warmups; index++)
          warmups.push(await runSample(notes, run.queryWarmups, 0));
        const samples = [];
        for (let index = 0; index < run.samples; index++)
          samples.push(await runSample(notes, run.queryWarmups, run.querySamples));
        report.push({ count: run.count, warmups, samples });
      }
      writeFileSync(process.env.TRAMA_BENCHMARK_OUT!, JSON.stringify(report, null, 2));
    },
    30 * 60 * 1000
  );
});

async function runSample(
  sourceNotes: readonly { path: string; content: string }[],
  queryWarmups: number,
  querySamples: number
) {
  const contents = new Map(sourceNotes.map((note) => [note.path, note.content]));
  const started = performance.now();
  const sqlite = await loadTestSqlite();
  const db = new sqlite.oo1.DB(":memory:", "c");
  const database = new NoteSqliteDatabase(db);
  const client = new NoteStoreClient(new Worker(db, database), plan.namespace);
  await client.initialize();
  const embeddings = new FixtureEmbeddings();
  const profile = {
    endpoint: plan.endpoint,
    modelId: plan.modelId,
    dimensions: plan.dimensions,
  };
  const cachedEmbeddings = new SqliteEmbeddingCache(
    embeddings,
    client.call,
    embeddingCacheIdentity(profile.modelId, profile.dimensions),
    plan.dimensions
  );
  const artifactAdapter = new FixtureAdapter();
  const sharedEmbeddings = new MeasuredVaultEmbeddingCache(
    artifactAdapter,
    cachedEmbeddings,
    plan.dimensions
  );
  const store = new SqliteNoteVectorStore(
    cachedEmbeddings,
    client.call,
    async (path) => contents.get(path) ?? null,
    profile
  );
  const vault: ManualIndexVault = {
    listMarkdownPaths: async () => [...contents.keys()].sort(),
    readMarkdown: async (path) => {
      const content = contents.get(path);
      if (content === undefined) throw new Error(`Missing benchmark note ${path}`);
      return { path, content };
    },
  };
  const manager = new ManualIndex(
    vault,
    store,
    new SqliteNoteRecordManager(client.call),
    sharedEmbeddings
  );
  requireSharingComplete(await manager.update(), "cold index");
  const coldIndexMs = performance.now() - started;
  const coldPublication = { ...sharedEmbeddings.lastPublication };
  const initialProvider = embeddings.snapshot();
  const initial = readCounts(db);
  const initialDatabaseExportBytes = sqlite.capi.sqlite3_js_db_export(db.pointer).byteLength;
  const sharedBootstrap = await runSharedBootstrap(
    sqlite,
    sourceNotes,
    artifactAdapter,
    embeddings,
    profile,
    plan.namespace
  );
  if (initial.noteCount !== sourceNotes.length)
    throw new Error(`Current index contains ${initial.noteCount}/${sourceNotes.length} notes`);

  const retrieval = new VaultRetrieval(
    client.call,
    cachedEmbeddings,
    store.embeddingProfile,
    async (path) => {
      const content = contents.get(path);
      return content === undefined ? null : { path, content };
    }
  );
  const queries = await querySuite(
    async (kind, ordinal) => {
      if (kind === "lexical") {
        const result = await retrieval.runnable.invoke({
          query: plan.queries.lexical[ordinal % plan.queries.lexical.length],
          mode: "lexical",
        });
        return { results: result.documents.map((document) => ({ path: document.metadata.path })) };
      }
      if (kind === "hybrid") {
        const result = await retrieval.runnable.invoke({
          query: plan.queries.hybrid[ordinal % plan.queries.hybrid.length],
          mode: "hybrid",
        });
        return { results: result.documents.map((document) => ({ path: document.metadata.path })) };
      }
      const result = await retrieval.related(
        plan.queries.relatedPaths[ordinal % plan.queries.relatedPaths.length],
        new AbortController().signal,
        7
      );
      return { results: result.documents.map((document) => ({ path: document.metadata.path })) };
    },
    queryWarmups,
    querySamples,
    () => embeddings.snapshot()
  );

  const operations: Record<string, unknown> = {};
  let before = embeddings.snapshot();
  let operationStart = performance.now();
  requireSharingComplete(await manager.update(), "unchanged update");
  operations.unchanged = operationResult(
    performance.now() - operationStart,
    before,
    embeddings.snapshot(),
    sharedEmbeddings.lastPublication
  );

  const firstPath = sourceNotes[0].path;
  contents.set(firstPath, `${sourceNotes[0].content.slice(0, -1)}y`);
  before = embeddings.snapshot();
  operationStart = performance.now();
  requireSharingComplete(await manager.update(), "edit update");
  operations.oneEdit = operationResult(
    performance.now() - operationStart,
    before,
    embeddings.snapshot(),
    sharedEmbeddings.lastPublication
  );

  contents.delete(sourceNotes.at(-1)!.path);
  before = embeddings.snapshot();
  operationStart = performance.now();
  requireSharingComplete(await manager.update(), "delete update");
  operations.oneDelete = operationResult(
    performance.now() - operationStart,
    before,
    embeddings.snapshot(),
    sharedEmbeddings.lastPublication
  );

  const final = readCounts(db);
  if (final.noteCount !== sourceNotes.length - 1)
    throw new Error(`Current delete left ${final.noteCount} notes indexed`);
  await client.close();
  return {
    coldIndexMs,
    initial: {
      ...initial,
      databaseExportBytes: initialDatabaseExportBytes,
      provider: initialProvider,
      publication: coldPublication,
      artifactCount: artifactAdapter.files.size,
      artifactBytes: artifactAdapter.totalBytes,
      sharedBootstrap,
    },
    operations,
    queries,
    finalNoteCount: final.noteCount,
  };
}

async function runSharedBootstrap(
  sqlite: any,
  sourceNotes: readonly { path: string; content: string }[],
  artifactAdapter: FixtureAdapter,
  embeddings: FixtureEmbeddings,
  profile: { endpoint: string; modelId: string; dimensions: number },
  namespace: string
) {
  const contents = new Map(sourceNotes.map((note) => [note.path, note.content]));
  const providerBefore = embeddings.snapshot();
  const started = performance.now();
  const db = new sqlite.oo1.DB(":memory:", "c");
  const database = new NoteSqliteDatabase(db);
  const client = new NoteStoreClient(new Worker(db, database), namespace);
  try {
    await client.initialize();
    const cache = new SqliteEmbeddingCache(
      embeddings,
      client.call,
      embeddingCacheIdentity(profile.modelId, profile.dimensions),
      profile.dimensions
    );
    const store = new SqliteNoteVectorStore(
      cache,
      client.call,
      async (path) => contents.get(path) ?? null,
      profile
    );
    const vault: ManualIndexVault = {
      listMarkdownPaths: async () => [...contents.keys()].sort(),
      readMarkdown: async (path) => ({ path, content: contents.get(path)! }),
    };
    const artifacts = new VaultEmbeddingCache(artifactAdapter, cache, profile.dimensions);
    const result = await new ManualIndex(
      vault,
      store,
      new SqliteNoteRecordManager(client.call),
      artifacts
    ).update();
    requireSharingComplete(result, "shared bootstrap");
    const providerAfter = embeddings.snapshot();
    const counts = readCounts(db);
    const output = {
      elapsedMs: performance.now() - started,
      artifactFiles: artifactAdapter.files.size,
      artifactBytes: artifactAdapter.totalBytes,
      noteCount: counts.noteCount,
      vectorCount: counts.vectorCount,
      providerCalls: providerAfter.calls - providerBefore.calls,
      providerTexts: providerAfter.texts - providerBefore.texts,
      numAdded: result.numAdded,
      transport: "in-memory vault-adapter fixture",
    };
    if (
      output.noteCount !== sourceNotes.length ||
      output.providerCalls !== 0 ||
      output.providerTexts !== 0
    )
      throw new Error("Shared artifact bootstrap did not populate the native index from cache");
    return output;
  } finally {
    await client.close();
  }
}

function readCounts(db: any) {
  return {
    noteCount: Number(db.selectValue("SELECT count(*) FROM note_index")),
    vectorCount: Number(db.selectValue("SELECT count(*) FROM note_vectors")),
    documentCacheCount: Number(
      db.selectValue("SELECT count(*) FROM embedding_cache WHERE task='document'")
    ),
    queryCacheCount: Number(
      db.selectValue("SELECT count(*) FROM embedding_cache WHERE task='query'")
    ),
  };
}

async function querySuite(
  query: (kind: "lexical" | "hybrid" | "related", ordinal: number) => Promise<any>,
  warmups: number,
  samples: number,
  providerSnapshot: () => ProviderStats
) {
  const results: Record<string, unknown> = {};
  let random = 0x5eed768;
  for (const kind of ["lexical", "hybrid", "related"] as const) {
    const timings: number[] = [];
    let returned = 0;
    const provider = { calls: 0, texts: 0, characters: 0, elapsedMs: 0 };
    for (let ordinal = 0; ordinal < warmups + samples; ordinal++) {
      random = xorshift(random);
      const providerBefore = providerSnapshot();
      const start = performance.now();
      const result = await query(kind, random % 5);
      const duration = performance.now() - start;
      const providerAfter = providerSnapshot();
      const documents = result.results;
      if (documents.length > (kind === "related" ? 7 : 20))
        throw new Error(`${kind} exceeded its result bound`);
      if (JSON.stringify(result).toLowerCase().includes("vector"))
        throw new Error(`${kind} transferred vector data to the result layer`);
      if (ordinal >= warmups) {
        timings.push(duration);
        returned += documents.length;
        provider.calls += providerAfter.calls - providerBefore.calls;
        provider.texts += providerAfter.texts - providerBefore.texts;
        provider.characters += providerAfter.characters - providerBefore.characters;
        provider.elapsedMs += providerAfter.elapsedMs - providerBefore.elapsedMs;
      }
    }
    const sentinel = await query(kind, 0);
    const paths = sentinel.results.map((result: { path: string }) => result.path);
    if (kind === "lexical" && !paths.includes("notes/0000.md"))
      throw new Error("Lexical sentinel note was not retrieved");
    if (
      kind === "hybrid" &&
      !paths.some((path: string) => path === "notes/0001.md" || path === "notes/0002.md")
    )
      throw new Error("Hybrid sentinel notes were not retrieved");
    if (kind === "related" && !paths.includes("notes/0002.md"))
      throw new Error("Related-note sentinel was not retrieved");
    results[kind] = {
      timingsMs: timings,
      meanResults: returned / Math.max(1, timings.length),
      sentinelPaths: paths,
      provider,
    };
  }
  return results;
}

function operationResult(
  elapsedMs: number,
  before: ProviderStats,
  after: ProviderStats,
  publication: MeasuredVaultEmbeddingCache["lastPublication"]
) {
  return {
    elapsedMs,
    publication: { ...publication },
    provider: {
      calls: after.calls - before.calls,
      texts: after.texts - before.texts,
      characters: after.characters - before.characters,
      elapsedMs: after.elapsedMs - before.elapsedMs,
    },
  };
}

function requireSharingComplete(result: { sharing: string }, phase: string): void {
  if (result.sharing !== "complete")
    throw new Error(`${phase} completed indexing with sharing ${result.sharing}`);
}

function xorshift(value: number): number {
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}
