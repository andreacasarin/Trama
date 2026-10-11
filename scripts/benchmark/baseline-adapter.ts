import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IndexManager } from "@/index/IndexManager";
import { LenteSearch } from "@/index/LenteSearch";
import { RelatedNotes } from "@/index/RelatedNotes";
import { createTestSqliteClient, snapshotFor, inspectWorkloadState } from "./sqlite-test-client";
// @ts-expect-error The copied benchmark fixture is plain ESM shared with the runner.
import { deterministicVector } from "../scripts/benchmark/performance-fixture.mjs";

interface PerformancePlan {
  readonly corpusSha256: string;
  readonly dimensions: number;
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

const controller = new AbortController();
const signal = controller.signal;
const plan = JSON.parse(readFileSync(process.env.TRAMA_BENCHMARK_PLAN!, "utf8")) as PerformancePlan;
const report: Record<string, unknown>[] = [];

class FixtureEmbeddings {
  readonly dimensions = plan.dimensions;
  readonly stats: ProviderStats = { calls: 0, texts: 0, characters: 0, elapsedMs: 0 };
  async embed(texts: readonly string[]): Promise<number[][]> {
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

describe("paired benchmark baseline adapter", () => {
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
  const identity = {};
  const embeddings = new FixtureEmbeddings();
  const vault = {
    listMarkdownPaths: async () => [...contents.keys()].sort(),
    readMarkdown: async (path: string) => {
      const content = contents.get(path);
      if (content === undefined) throw new Error(`Missing benchmark note ${path}`);
      return { path, content };
    },
    isMarkdownAvailable: async (path: string) => contents.has(path),
  };
  const index = new IndexManager(vault, embeddings, plan.endpoint, plan.modelId, {
    sqliteClient: createTestSqliteClient(identity),
  });
  const started = performance.now();
  await index.build(signal);
  await index.prepareSemantic(signal);
  const coldIndexMs = performance.now() - started;
  const state = (await index.getState())!;
  const initialProvider = embeddings.snapshot();
  const initialSnapshot = await snapshotFor(identity);
  const initialStorage = await inspectWorkloadState(initialSnapshot);
  const initialDatabaseExportBytes = initialSnapshot.byteLength;
  if (state.noteCount !== sourceNotes.length)
    throw new Error(`Baseline indexed ${state.noteCount}/${sourceNotes.length} notes`);

  const lente = new LenteSearch(index, { getMtime: () => 1 });
  const related = new RelatedNotes(index);
  const queries = await querySuite(
    async (kind, ordinal) => {
      if (kind === "lexical") {
        const result = await lente.search(
          plan.queries.lexical[ordinal % plan.queries.lexical.length],
          {
            searchMethod: "keyword",
          }
        );
        return { results: result.results };
      }
      if (kind === "hybrid") {
        const result = await lente.search(
          plan.queries.hybrid[ordinal % plan.queries.hybrid.length]
        );
        return { results: result.results };
      }
      const result = await related.find(
        plan.queries.relatedPaths[ordinal % plan.queries.relatedPaths.length],
        signal,
        7,
        true
      );
      return { results: result.results };
    },
    queryWarmups,
    querySamples,
    () => embeddings.snapshot()
  );

  const operations: Record<string, unknown> = {};
  let before = embeddings.snapshot();
  let operationStart = performance.now();
  await index.synchronize(signal);
  await index.prepareSemantic(signal);
  operations.unchanged = operationResult(
    performance.now() - operationStart,
    before,
    embeddings.snapshot()
  );

  const firstPath = sourceNotes[0].path;
  contents.set(firstPath, `${sourceNotes[0].content.slice(0, -1)}y`);
  before = embeddings.snapshot();
  operationStart = performance.now();
  await index.synchronize(signal);
  await index.prepareSemantic(signal);
  operations.oneEdit = operationResult(
    performance.now() - operationStart,
    before,
    embeddings.snapshot()
  );

  contents.delete(sourceNotes.at(-1)!.path);
  before = embeddings.snapshot();
  operationStart = performance.now();
  await index.synchronize(signal);
  await index.prepareSemantic(signal);
  operations.oneDelete = operationResult(
    performance.now() - operationStart,
    before,
    embeddings.snapshot()
  );

  const finalState = (await index.getState())!;
  if (finalState.noteCount !== sourceNotes.length - 1)
    throw new Error(`Baseline delete left ${finalState.noteCount} notes indexed`);
  await index.dispose();
  return {
    coldIndexMs,
    initial: {
      noteCount: state.noteCount,
      chunkCount: state.chunkCount,
      vectorCount: initialStorage.semanticState.compatibleVectorCount,
      databaseExportBytes: initialDatabaseExportBytes,
      provider: initialProvider,
    },
    operations,
    queries,
    finalNoteCount: finalState.noteCount,
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
      const input = random % 5;
      const providerBefore = providerSnapshot();
      const start = performance.now();
      const output = await query(kind, input);
      const elapsed = performance.now() - start;
      const providerAfter = providerSnapshot();
      const count = output.results.length;
      if (count > (kind === "related" ? 7 : 20))
        throw new Error(`${kind} exceeded its result bound`);
      if (JSON.stringify(output).toLowerCase().includes("vector"))
        throw new Error(`${kind} transferred vector data to the result layer`);
      if (ordinal >= warmups) {
        timings.push(elapsed);
        returned += count;
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

function operationResult(elapsedMs: number, before: ProviderStats, after: ProviderStats) {
  return {
    elapsedMs,
    provider: {
      calls: after.calls - before.calls,
      texts: after.texts - before.texts,
      characters: after.characters - before.characters,
      elapsedMs: after.elapsedMs - before.elapsedMs,
    },
  };
}

function xorshift(value: number): number {
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}
