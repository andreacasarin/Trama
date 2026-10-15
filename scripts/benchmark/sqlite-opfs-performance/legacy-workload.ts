/* global Worker, crypto, performance */
import type { EmbeddingModel } from "@/domain/contracts";
import { IndexManager } from "@/index/IndexManager";
import { LenteSearch } from "@/index/LenteSearch";
import { RelatedNotes } from "@/index/RelatedNotes";
import { MaintenanceScheduler } from "@/index/MaintenanceScheduler";
import { PublicationManager } from "@/index/publications/PublicationManager";

type Plan = {
  corpusSha256: string;
  dimensions: number;
  namespace: string;
  endpoint: string;
  modelId: string;
  queries: { lexical: string[]; hybrid: string[]; relatedPaths: string[] };
};
type Note = { path: string; content: string };
function stage(name: string) {
  void fetch(`/__bench-stage?stage=${encodeURIComponent(name)}`).catch(() => undefined);
}

function vectorFor(input: string, dimensions: number): number[] {
  const vector = new Float32Array(dimensions);
  for (const term of input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let hash = 2166136261;
    for (let index = 0; index < term.length; index++)
      hash = Math.imul(hash ^ term.charCodeAt(index), 16777619) >>> 0;
    vector[hash % dimensions] += hash & 0x80000000 ? 1 : -1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm) for (let index = 0; index < dimensions; index++) vector[index] /= norm;
  return Array.from(vector);
}

class FixtureEmbedding implements EmbeddingModel {
  readonly dimensions: number;
  calls = 0;
  texts = 0;
  characters = 0;
  elapsedMs = 0;
  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }
  async embed(texts: readonly string[]): Promise<readonly number[][]> {
    const started = performance.now();
    this.calls++;
    this.texts += texts.length;
    this.characters += texts.reduce((sum, text) => sum + text.length, 0);
    const vectors = texts.map((text) => vectorFor(text, this.dimensions));
    this.elapsedMs += performance.now() - started;
    return vectors;
  }
  snapshot() {
    return {
      calls: this.calls,
      texts: this.texts,
      characters: this.characters,
      elapsedMs: this.elapsedMs,
    };
  }
}

class MemoryVault {
  readonly files = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();
  writes = 0;
  writtenBytes = 0;
  async exists(path: string) {
    return this.files.has(path) || this.folders.has(path);
  }
  async list(path: string) {
    const prefix = `${path}/`;
    const files = [...this.files.keys()].filter((name) => name.startsWith(prefix));
    const folders = [...this.folders].filter((name) => name.startsWith(prefix));
    return { files, folders };
  }
  async mkdir(path: string) {
    this.folders.add(path);
  }
  async stat(path: string) {
    const bytes = this.files.get(path);
    return bytes ? { size: bytes.byteLength } : null;
  }
  async readBinary(path: string) {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`Missing legacy publication artifact ${path}`);
    return bytes.slice().buffer;
  }
  async writeBinary(path: string, value: ArrayBuffer) {
    const bytes = new Uint8Array(value.slice(0));
    this.writes++;
    this.writtenBytes += bytes.byteLength;
    this.files.set(path, bytes);
  }
  async rename(from: string, to: string) {
    const bytes = this.files.get(from);
    if (!bytes) throw new Error(`Missing temporary publication file ${from}`);
    this.files.delete(from);
    this.files.set(to, bytes);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  totalBytes() {
    return [...this.files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
  }
}

async function makeRuntime(
  plan: Plan,
  contents: Map<string, string>,
  provider: FixtureEmbedding,
  artifacts: MemoryVault,
  workerUrl: string
) {
  stage("make-runtime-start");
  const identity = crypto.randomUUID().replaceAll("-", "");
  const workerFactory = () => {
    const worker = new Worker(workerUrl, { type: "module" });
    worker.addEventListener("error", (event) =>
      stage(`worker-error-${(event as ErrorEvent).message}`)
    );
    worker.addEventListener("messageerror", () => stage("worker-messageerror"));
    return worker;
  };
  const vault = {
    listMarkdownPaths: async () => [...contents.keys()].sort(),
    readMarkdown: async (path: string) => {
      const content = contents.get(path);
      if (content === undefined) throw new Error(`Missing benchmark note ${path}`);
      return { path, content };
    },
  };
  const manager = new IndexManager(vault, provider, plan.endpoint, plan.modelId, {
    workerFactory,
    sqliteIdentity: identity,
  });
  const publication = new PublicationManager(manager, artifacts, { directory: "Trama/index" });
  const originalPublish = publication.publish.bind(publication);
  (publication as any).lastBenchmark = { elapsedMs: 0 };
  publication.publish = async (shouldYield?: () => boolean) => {
    const started = performance.now();
    try {
      return await originalPublish(shouldYield);
    } finally {
      (publication as any).lastBenchmark = { elapsedMs: performance.now() - started };
    }
  };
  const scheduler = new MaintenanceScheduler({
    semanticConfigured: true,
    synchronize: async (signal) => {
      stage("sync-start");
      const result = await manager.reconcileQueuedChanges(signal);
      stage(`sync-done-${result.converged}`);
      return result;
    },
    prepareSemantic: async (signal, shouldYield) => {
      stage("semantic-start");
      const result = await manager.prepareSemantic(signal, shouldYield);
      stage(`semantic-done-${result.converged}`);
      return result;
    },
    rebuildSemantic: async (signal, shouldYield) => {
      stage("semantic-rebuild-start");
      return manager.rebuildSemantic(signal, shouldYield);
    },
    rebuild: async (signal) => {
      stage("rebuild-start");
      return manager.build(signal);
    },
    publish: async (shouldYield) => {
      stage("publish-start");
      const result = await publication.publish(shouldYield);
      stage(`publish-done-${result.published}`);
      return result;
    },
    adoptCurrent: (shouldYield) => publication.adoptCurrent(shouldYield),
  });
  const loaded = await manager.load();
  stage(`manager-load-${loaded}`);
  if (!loaded) {
    const error = (manager as any).runtime.loadError;
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(`Legacy IndexManager.load failed: ${detail}`);
  }
  return { manager, publication, scheduler, identity };
}

async function snapshot(manager: IndexManager) {
  return manager.getState();
}

async function inspect(manager: IndexManager) {
  return (manager as any).runtime.client.call("__benchSnapshot", {});
}

export async function runWorkload(
  plan: Plan,
  notes: readonly Note[],
  queryWarmups: number,
  querySamples: number,
  workerUrl: string
) {
  stage("workload-start");
  const contents = new Map(notes.map((note) => [note.path, note.content]));
  const provider = new FixtureEmbedding(plan.dimensions);
  const artifacts = new MemoryVault();
  const runtime = await makeRuntime(plan, contents, provider, artifacts, workerUrl);
  const started = performance.now();
  stage("scheduler-update-start");
  await runtime.scheduler.update();
  stage("scheduler-update-complete");
  const coldIndexMs = performance.now() - started;
  const coldPublication = Object.freeze({
    captureStage: "cold-scheduler-update-complete",
    elapsedMs: (runtime.publication as any).lastBenchmark.elapsedMs,
    temporaryFileWrites: artifacts.writes,
    temporaryBytesWritten: artifacts.writtenBytes,
    files: artifacts.files.size,
    bytes: artifacts.totalBytes(),
  });
  stage("cold-publication-captured");
  const initialProvider = provider.snapshot();
  const initialState = await snapshot(runtime.manager);
  const initialArtifactCount = artifacts.files.size;
  const initialArtifactBytes = artifacts.totalBytes();
  const initialSqlite = await inspect(runtime.manager);
  const search = new LenteSearch(runtime.manager, { getMtime: () => 1 });
  const related = new RelatedNotes(runtime.manager);
  const queries = await querySuite(
    async (kind, ordinal) => {
      if (kind === "lexical") {
        const result = await search.search(plan.queries.lexical[ordinal % 5], {
          searchMethod: "keyword",
        });
        return result.results.map((row) => ({ path: row.path }));
      }
      if (kind === "hybrid") {
        const result = await search.search(plan.queries.hybrid[ordinal % 5]);
        return result.results.map((row) => ({ path: row.path }));
      }
      const result = await related.find(
        plan.queries.relatedPaths[ordinal % 5],
        new AbortController().signal,
        7,
        true
      );
      return result.results.map((row) => ({ path: row.path }));
    },
    queryWarmups,
    querySamples,
    () => provider.snapshot()
  );

  const bootstrapProviderBefore = provider.snapshot();
  const bootstrap = await makeRuntime(plan, contents, provider, artifacts, workerUrl);
  const bootstrapStart = performance.now();
  await bootstrap.publication.adoptCurrent();
  await bootstrap.scheduler.update();
  const bootstrapProviderAfter = provider.snapshot();
  const bootstrapSqlite = await inspect(bootstrap.manager);
  const sharedBootstrap = {
    elapsedMs: performance.now() - bootstrapStart,
    artifactFiles: artifacts.files.size,
    artifactBytes: artifacts.totalBytes(),
    noteCount: (await bootstrap.manager.getState())?.noteCount ?? 0,
    providerCalls: bootstrapProviderAfter.calls - bootstrapProviderBefore.calls,
    providerTexts: bootstrapProviderAfter.texts - bootstrapProviderBefore.texts,
    sharing: "complete",
    sqlite: bootstrapSqlite,
  };
  await bootstrap.manager.disposeImmediately();

  const operation = async (action: () => Promise<void>) => {
    const before = provider.snapshot();
    const writes = artifacts.writes;
    const bytes = artifacts.writtenBytes;
    const operationStart = performance.now();
    await action();
    return {
      elapsedMs: performance.now() - operationStart,
      publication: {
        elapsedMs: (runtime.publication as any).lastBenchmark.elapsedMs,
        temporaryFileWrites: artifacts.writes - writes,
        temporaryBytesWritten: artifacts.writtenBytes - bytes,
        files: artifacts.files.size,
        bytes: artifacts.totalBytes(),
      },
      provider: providerDelta(before, provider.snapshot()),
    };
  };
  const unchanged = await operation(async () => runtime.scheduler.update());
  const firstPath = notes[0].path;
  contents.set(firstPath, `${notes[0].content.slice(0, -1)}y`);
  runtime.manager.recordPathMutation({ type: "upsert", path: firstPath });
  const oneEdit = await operation(async () => runtime.scheduler.update());
  const deletedPath = notes.at(-1)!.path;
  contents.delete(deletedPath);
  runtime.manager.recordPathMutation({ type: "delete", path: deletedPath });
  const oneDelete = await operation(async () => runtime.scheduler.update());
  const finalNoteCount = (await snapshot(runtime.manager))?.noteCount ?? notes.length - 1;
  const finalSqlite = await inspect(runtime.manager);
  await runtime.manager.disposeImmediately();
  return {
    coldIndexMs,
    initial: {
      noteCount: initialState?.noteCount ?? 0,
      vectorCount: initialSqlite.counts.embedding_cache_document,
      chunkCount: initialSqlite.counts.chunk_occurrences,
      provider: initialProvider,
      publication: coldPublication,
      artifactCount: initialArtifactCount,
      artifactBytes: initialArtifactBytes,
      opfsPoolBytes: initialSqlite.mainDatabaseBytes,
      sqlite: initialSqlite,
      sharedBootstrap,
    },
    operations: { unchanged, oneEdit, oneDelete },
    queries,
    finalNoteCount,
    finalSqlite,
  };
}

function providerDelta(
  before: ReturnType<FixtureEmbedding["snapshot"]>,
  after: ReturnType<FixtureEmbedding["snapshot"]>
) {
  return {
    calls: after.calls - before.calls,
    texts: after.texts - before.texts,
    characters: after.characters - before.characters,
    elapsedMs: after.elapsedMs - before.elapsedMs,
  };
}

async function querySuite(
  query: (kind: "lexical" | "hybrid" | "related", ordinal: number) => Promise<{ path: string }[]>,
  warmups: number,
  samples: number,
  snapshot: () => ReturnType<FixtureEmbedding["snapshot"]>
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
      if (rows.length > (kind === "related" ? 7 : 20)) throw new Error(`${kind} exceeded bound`);
      if (ordinal >= warmups) {
        timingsMs.push(elapsed);
        returned += rows.length;
        const delta = providerDelta(before, after);
        provider.calls += delta.calls;
        provider.texts += delta.texts;
        provider.characters += delta.characters;
        provider.elapsedMs += delta.elapsedMs;
      }
    }
    const sentinel = await query(kind, 0);
    if (kind === "lexical" && !sentinel.some((row) => row.path === "notes/0000.md"))
      throw new Error("Legacy lexical sentinel missing");
    if (
      kind === "hybrid" &&
      !sentinel.some((row) => row.path === "notes/0001.md" || row.path === "notes/0002.md")
    )
      throw new Error("Legacy hybrid sentinel missing");
    if (kind === "related" && !sentinel.some((row) => row.path === "notes/0002.md"))
      throw new Error("Legacy related sentinel missing");
    results[kind] = {
      timingsMs,
      meanResults: returned / Math.max(1, timingsMs.length),
      sentinelPaths: sentinel.map((row) => row.path),
      provider,
    };
  }
  return results;
}
