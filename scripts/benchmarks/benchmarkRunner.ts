import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { IndexManager } from "@/index/IndexManager";
import { MemoryIndexStorage } from "@/index/storage";
import type { EmbeddingModel } from "@/domain/contracts";
import { UNIFIED_ORAMA_BENCHMARK_CONFIG, type UnifiedOramaBenchmarkScale } from "./benchmarkConfig";
import {
  createSyntheticEmbedding,
  createSyntheticWorkload,
  SyntheticVault,
} from "./syntheticWorkload";
import type { BenchmarkTiming, SanitizedBenchmarkReport, SanitizedBenchmarkScaleResult } from "./benchmarkSchema";

const signal = new AbortController().signal;

function percentile(values: readonly number[], fraction: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))].toFixed(2));
}

function timing(values: readonly number[]): BenchmarkTiming {
  return {
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: percentile(values, 1),
  };
}

async function withEventLoopSamples<T>(operation: () => Promise<T>): Promise<{ value: T; timing: BenchmarkTiming }> {
  const samples: number[] = [];
  const started = Date.now();
  let expected = started + 5;
  const timer = setInterval(() => {
    const now = Date.now();
    samples.push(Math.max(0, now - expected));
    expected += 5;
  }, 5);
  try {
    return { value: await operation(), timing: timing(samples) };
  } finally {
    clearInterval(timer);
  }
}

function storageBytes(storage: MemoryIndexStorage): number {
  let bytes = 0;
  for (const value of storage.files.values()) bytes += new TextEncoder().encode(value).byteLength;
  for (const value of storage.binaryFiles.values()) bytes += value.byteLength;
  return bytes;
}

function rss(): { rss: number; heap: number } {
  const memory = process.memoryUsage();
  return { rss: memory.rss, heap: memory.heapUsed };
}

function manager(vault: SyntheticVault, storage: MemoryIndexStorage, embedding: EmbeddingModel): IndexManager {
  return new IndexManager(
    vault.port(),
    embedding,
    storage,
    "http://synthetic.invalid/v1",
    "synthetic-embedding",
    {
      size: UNIFIED_ORAMA_BENCHMARK_CONFIG.chunkSize,
      overlap: UNIFIED_ORAMA_BENCHMARK_CONFIG.overlap,
    }
  );
}

async function measureSearch(index: IndexManager, queries: readonly string[]): Promise<BenchmarkTiming> {
  const samples: number[] = [];
  for (const query of queries) {
    const started = performance.now();
    await index.search(query, signal, 7);
    samples.push(performance.now() - started);
  }
  return timing(samples);
}

async function runScale(scale: UnifiedOramaBenchmarkScale): Promise<SanitizedBenchmarkScaleResult> {
  const workload = createSyntheticWorkload(scale);
  const vault = new SyntheticVault(workload.notes);
  const storage = new MemoryIndexStorage();
  const embedding = createSyntheticEmbedding();
  const before = rss();
  const index = manager(vault, storage, embedding);
  const buildStarted = performance.now();
  const buildResult = await withEventLoopSamples(() => index.build(signal));
  const buildMs = Number((performance.now() - buildStarted).toFixed(2));
  const afterBuild = rss();
  const search = await measureSearch(index, workload.queries);
  const unchangedEmbeddingCallsBefore = (embedding.embed as unknown as { length?: number }).length;
  const unchangedPublished = await index.synchronizeWithPublication(signal);
  const unchangedEmbeddingCallsAfter = (embedding.embed as unknown as { length?: number }).length;
  // The synthetic embedding function is intentionally uninstrumented in the
  // baseline path; a candidate may provide call telemetry. Preserve this as
  // unsupported rather than inventing a zero.
  void unchangedEmbeddingCallsBefore;
  void unchangedEmbeddingCallsAfter;
  const restartStarted = performance.now();
  const restarted = manager(vault, storage, createSyntheticEmbedding());
  const restartLoaded = await restarted.load();
  const restartMs = Number((performance.now() - restartStarted).toFixed(2));
  if (restartLoaded) await restarted.search("topic alpha", signal, 7);
  const report: SanitizedBenchmarkScaleResult = {
    scale,
    noteCount: workload.notes.length,
    chunkCount: workload.totalChunks,
    buildMs,
    restartMs,
    search,
    eventLoop: buildResult.timing,
    storageBytes: storageBytes(storage),
    memory: {
      rssDeltaBytes: afterBuild.rss - before.rss,
      heapDeltaBytes: afterBuild.heap - before.heap,
    },
    updates: {
      unchangedEmbedCalls: undefined,
      unchangedPublished,
      modifyEmbedCalls: undefined,
      deleteEmbedCalls: undefined,
      renameEmbedCalls: undefined,
    },
    unsupported: ["embedding-call counts are not exposed by the untouched baseline model"],
  };
  await restarted.load().catch(() => false);
  return report;
}

export function requestedScales(): UnifiedOramaBenchmarkScale[] {
  const raw = process.env.TRAMA_BENCH_SCALES?.trim();
  const values = raw ? raw.split(",").map((value) => Number(value.trim())) : [1_000, 25_000];
  const valid = values.filter((value): value is UnifiedOramaBenchmarkScale =>
    (UNIFIED_ORAMA_BENCHMARK_CONFIG.scales as readonly number[]).includes(value)
  );
  if (!valid.length) throw new Error("TRAMA_BENCH_SCALES must contain an approved benchmark scale");
  return valid;
}

export async function runBenchmark(
  backend: SanitizedBenchmarkReport["backend"],
  scales: readonly UnifiedOramaBenchmarkScale[] = requestedScales()
): Promise<SanitizedBenchmarkReport> {
  const results: SanitizedBenchmarkScaleResult[] = [];
  for (const scale of scales) results.push(await runScale(scale));
  const represented = new Set(scales);
  return {
    schemaVersion: 1,
    harness: "unified-orama",
    backend,
    generatedAt: new Date().toISOString(),
    config: {
      dimensions: UNIFIED_ORAMA_BENCHMARK_CONFIG.dimensions,
      chunkSize: UNIFIED_ORAMA_BENCHMARK_CONFIG.chunkSize,
      overlap: UNIFIED_ORAMA_BENCHMARK_CONFIG.overlap,
      scales: [...UNIFIED_ORAMA_BENCHMARK_CONFIG.scales],
    },
    scales: results,
    unsupported: UNIFIED_ORAMA_BENCHMARK_CONFIG.scales
      .filter((scale) => !represented.has(scale))
      .map((scale) => `${scale} chunks not run in this capture`),
  };
}

export async function writeBenchmarkReport(path: string, report: SanitizedBenchmarkReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
