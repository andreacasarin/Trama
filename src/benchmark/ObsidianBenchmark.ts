import type { IndexManager } from "@/index/IndexManager";
import type { RelatedNotes } from "@/index/RelatedNotes";
import type { PublicationManager } from "@/index/publications/PublicationManager";
import type { LenteSearchPort } from "@/plugin/ModelRuntime";
import { sha256Hex } from "@/index/Identity";
import {
  BENCHMARK_NOTE_COUNT,
  BENCHMARK_REPORT,
  readBenchmarkManifest,
  type BenchmarkManifest,
  type BenchmarkReport,
} from "./Manifest";

/** References to the already-composed production runtime. */
export interface BenchmarkRuntime {
  readonly index: IndexManager;
  readonly publication: PublicationManager;
  readonly related: RelatedNotes;
  clearIndexesAndSharedCache(): Promise<void>;
  rebuild(): Promise<void>;
  publish(): Promise<void>;
  checkPublication(): Promise<void>;
  hasPublicationCheckWarning(): boolean;
  getLenteSearch(): LenteSearchPort;
}

export async function writeBenchmarkFailureReport(
  app: { vault: any },
  manifest: BenchmarkManifest,
  failure: unknown
): Promise<void> {
  const adapter = app.vault.adapter;
  const current = await readBenchmarkManifest(adapter, app.vault.getName?.() ?? "");
  if (
    !current ||
    adapter.getBasePath?.() !== manifest.expectedPath ||
    current.corpusSha256 !== manifest.corpusSha256
  )
    return;
  if (await adapter.exists?.(BENCHMARK_REPORT)) return;
  const report: BenchmarkReport = {
    version: "trama-simple-benchmark-report-v1",
    status: "error",
    runId: globalThis.crypto.randomUUID(),
    corpusSha256: manifest.corpusSha256,
    noteCount: BENCHMARK_NOTE_COUNT,
    correctness: {},
    error: failure instanceof Error ? failure.message : String(failure),
  };
  await adapter.write(BENCHMARK_REPORT, `${JSON.stringify(report, null, 2)}\n`);
}

/** Runs a fixed correctness workflow through normal production operations. */
export async function runObsidianBenchmark(
  app: { vault: any },
  manifest: BenchmarkManifest,
  runtime: BenchmarkRuntime
): Promise<BenchmarkReport> {
  const adapter = app.vault.adapter;
  if (adapter.exists && (await adapter.exists(BENCHMARK_REPORT)))
    throw new Error("A benchmark report already exists; refusing to replace it.");
  const verifyMarker = async () => {
    const current = await readBenchmarkManifest(adapter, app.vault.getName?.() ?? "");
    if (
      !current ||
      adapter.getBasePath?.() !== manifest.expectedPath ||
      current.corpusSha256 !== manifest.corpusSha256
    )
      throw new Error("Benchmark vault marker changed; refusing mutation.");
  };
  const report: BenchmarkReport = {
    version: "trama-simple-benchmark-report-v1",
    status: "completed",
    runId: globalThis.crypto.randomUUID(),
    corpusSha256: manifest.corpusSha256,
    noteCount: BENCHMARK_NOTE_COUNT,
    startedAt: new Date().toISOString(),
    correctness: {},
  };
  // eslint-disable-next-line no-console
  console.info("[Trama] benchmark_started", { runId: report.runId });
  const correctness: Record<string, boolean> = {};
  let relatedLookup: BenchmarkReport["relatedLookup"];
  let maintenanceBefore = false;
  let maintenanceAfter = false;
  try {
    await verifyMarker();
    const paths = app.vault
      .getMarkdownFiles()
      .map((file: { path: string }) => file.path)
      .sort();
    correctness.corpusNoteCount = paths.length === BENCHMARK_NOTE_COUNT;
    correctness.corpusPaths = paths.every(
      (path: string, index: number) => path === `notes/${String(index).padStart(4, "0")}.md`
    );
    if (!correctness.corpusNoteCount || !correctness.corpusPaths)
      throw new Error("Benchmark corpus inventory does not match the fixed 3,000-note corpus.");

    await verifyMarker();
    await runtime.clearIndexesAndSharedCache();
    const empty = await runtime.index.getState();
    correctness.coldIndex = !empty || empty.noteCount === 0;
    correctness.cacheCleared = (await runtime.publication.store.listCacheShards()).length === 0;
    if (!correctness.coldIndex || !correctness.cacheCleared)
      throw new Error("Benchmark indexes and shared cache were not empty after clear.");

    await verifyMarker();
    await runtime.rebuild();
    const state = await runtime.index.getState();
    correctness.indexedAllNotes = state?.noteCount === BENCHMARK_NOTE_COUNT;
    correctness.semanticReady = state?.semanticReady === true;
    if (!correctness.indexedAllNotes || !correctness.semanticReady)
      throw new Error("Production index did not reach the expected 3,000-note semantic state.");

    await verifyMarker();
    const lente = await runtime.getLenteSearch().search("D5 lexical sentinel unique phrase");
    correctness.lexicalSentinel = lente.results.some((result) => result.path === "notes/0000.md");
    correctness.hybridSentinel = (lente.canonicalResults ?? []).some(
      (result) => result.path === "notes/0000.md"
    );
    await verifyMarker();
    maintenanceBefore = runtime.index.isInMaintenance();
    const related = await runtime.related.find(
      "notes/0001.md",
      new AbortController().signal,
      20,
      true
    );
    maintenanceAfter = runtime.index.isInMaintenance();
    relatedLookup = {
      results: related.results
        .slice(0, 20)
        .filter((result) => /^notes\/\d{4}\.md$/.test(result.path) && Number.isFinite(result.score))
        .map(({ path, score }) => ({ path, score })),
      ...(related.unavailableReason ? { unavailableReason: related.unavailableReason } : {}),
      semanticPartial: related.semanticPartial === true,
      maintenanceBefore,
      maintenanceAfter,
    };
    correctness.relatedSentinel = related.results.some((result) => result.path === "notes/0002.md");

    await verifyMarker();
    await runtime.publish();
    const shards = await runtime.publication.store.listCacheShards();
    correctness.cacheShardsPublished = shards.length > 0;
    const publishedShards = [...shards].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    );
    correctness.cacheShardHashesValid = publishedShards.length > 0;
    for (const shard of publishedShards) {
      const bytes = await runtime.publication.store.readCacheShard(shard.path);
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > 4_194_304 ||
        (await sha256Hex(bytes)) !== shard.digest
      ) {
        correctness.cacheShardHashesValid = false;
        break;
      }
    }
    const beforeCheckState = await runtime.index.getState();
    await verifyMarker();
    await runtime.checkPublication();
    const checkedShards = [...(await runtime.publication.store.listCacheShards())].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    );
    const checkedState = await runtime.index.getState();
    correctness.cacheShardCheckStable =
      !runtime.hasPublicationCheckWarning() &&
      checkedShards.length === publishedShards.length &&
      checkedShards.every(
        (shard, index) =>
          shard.path === publishedShards[index]?.path &&
          shard.digest === publishedShards[index]?.digest
      ) &&
      beforeCheckState?.noteCount === BENCHMARK_NOTE_COUNT &&
      beforeCheckState.semanticReady === true &&
      checkedState?.noteCount === beforeCheckState.noteCount &&
      checkedState.semanticReady === beforeCheckState.semanticReady &&
      checkedState.lexicalGeneration === beforeCheckState.lexicalGeneration &&
      checkedState.semanticGeneration === beforeCheckState.semanticGeneration &&
      checkedState.embeddingFingerprint === beforeCheckState.embeddingFingerprint;
    if (
      !correctness.cacheShardsPublished ||
      !correctness.cacheShardHashesValid ||
      !correctness.cacheShardCheckStable
    )
      throw new Error(
        "Cache shard publication was not present, valid, and stable after its check."
      );
    if (!correctness.lexicalSentinel || !correctness.hybridSentinel || !correctness.relatedSentinel)
      throw new Error("Production retrieval did not return the fixed sentinel notes.");
  } catch (error) {
    return {
      ...report,
      finishedAt: new Date().toISOString(),
      status: "error",
      correctness,
      ...(relatedLookup ? { relatedLookup } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    ...report,
    finishedAt: new Date().toISOString(),
    correctness,
    ...(relatedLookup ? { relatedLookup } : {}),
  };
}

export async function writeBenchmarkReport(
  app: { vault: any },
  manifest: BenchmarkManifest,
  report: BenchmarkReport
): Promise<void> {
  const current = await readBenchmarkManifest(app.vault.adapter, app.vault.getName?.() ?? "");
  if (
    !current ||
    app.vault.adapter.getBasePath?.() !== manifest.expectedPath ||
    current.corpusSha256 !== manifest.corpusSha256
  )
    throw new Error("Benchmark marker or path changed; refusing report write.");
  await app.vault.adapter.write(BENCHMARK_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.info("[Trama] benchmark_finished", { runId: report.runId, status: report.status });
}
