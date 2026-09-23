import { performance } from "node:perf_hooks";
import type { IndexProgress } from "@/domain/contracts";
import type { SqliteWorkerClient } from "@/index/sqlite/client";

export interface BenchmarkMemorySampler {
  readonly peak: number;
  readonly sampleCount: number;
  sample(): number;
  stop(): void;
}

export function createBenchmarkMemorySampler(
  options: {
    readonly intervalMs?: number;
    readonly readRss?: () => number;
  } = {}
): BenchmarkMemorySampler {
  const readRss = options.readRss ?? (() => process.memoryUsage().rss);
  let peak = 0;
  let sampleCount = 0;
  let stopped = false;
  const sample = () => {
    if (stopped) return peak;
    const rss = readRss();
    sampleCount++;
    peak = Math.max(peak, rss);
    return rss;
  };
  const interval = setInterval(sample, options.intervalMs ?? 25);
  interval.unref?.();
  sample();
  return {
    get peak() {
      return peak;
    },
    get sampleCount() {
      return sampleCount;
    },
    sample,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
    },
  };
}

export interface BenchmarkCounters {
  vaultLists: number;
  vaultReads: number;
  vaultReadBytes: number;
  contentHashCalls: number;
  contentHashBytes: number;
  inputHashCount: number;
  inputHashBytes: number;
  providerCalls: number;
  providerTexts: number;
  providerInputBytes: number;
  providerStubTexts: number;
  rpcCalls: number;
  rpcByMethod: Record<string, number>;
  rpcElapsedMs: Record<string, number[]>;
  stateCalls: number;
  semanticPrepareCalls: number;
  semanticUnrestrictedPromotionCalls: number;
  semanticPreparedItems: number;
  semanticPreparedInputBytes: number;
  semanticCommitCalls: number;
  semanticStoredRows: number;
  publicationValidationPasses: number;
  publicationValidationVectorRows: number;
  transactionSqlCalls: number | "unsupported";
  progressCallbacks: number;
  progressByPhase: Record<string, number>;
}

export function createBenchmarkCounters(): BenchmarkCounters {
  return {
    vaultLists: 0,
    vaultReads: 0,
    vaultReadBytes: 0,
    contentHashCalls: 0,
    contentHashBytes: 0,
    inputHashCount: 0,
    inputHashBytes: 0,
    providerCalls: 0,
    providerTexts: 0,
    providerInputBytes: 0,
    providerStubTexts: 0,
    rpcCalls: 0,
    rpcByMethod: {},
    rpcElapsedMs: {},
    stateCalls: 0,
    semanticPrepareCalls: 0,
    semanticUnrestrictedPromotionCalls: 0,
    semanticPreparedItems: 0,
    semanticPreparedInputBytes: 0,
    semanticCommitCalls: 0,
    semanticStoredRows: 0,
    publicationValidationPasses: 0,
    publicationValidationVectorRows: 0,
    transactionSqlCalls: "unsupported",
    progressCallbacks: 0,
    progressByPhase: {},
  };
}

export function observeVaultList(counters: BenchmarkCounters): void {
  counters.vaultLists++;
}

export function observeVaultRead(counters: BenchmarkCounters, content: string): void {
  counters.vaultReads++;
  counters.vaultReadBytes += Buffer.byteLength(content, "utf8");
}

export function observeProvider(
  counters: BenchmarkCounters,
  inputs: readonly string[],
  vectors: readonly number[][],
  sampleMemory?: () => void
): void {
  sampleMemory?.();
  counters.providerCalls++;
  counters.providerTexts += inputs.length;
  counters.providerInputBytes += inputs.reduce(
    (sum, input) => sum + Buffer.byteLength(input, "utf8"),
    0
  );
  if (vectors.some((vector) => vector.length === 0))
    throw new Error("Provider returned an empty vector");
  sampleMemory?.();
}

export function observeProgress(
  counters: BenchmarkCounters,
  progress: IndexProgress,
  sampleMemory?: () => void
): void {
  sampleMemory?.();
  counters.progressCallbacks++;
  counters.progressByPhase[progress.phase] = (counters.progressByPhase[progress.phase] ?? 0) + 1;
}

/** Wrap the public client seam to count protocol calls without changing product code. */
export function instrumentSqliteClient(
  client: SqliteWorkerClient,
  counters: BenchmarkCounters,
  sampleMemory?: () => void
): SqliteWorkerClient {
  const original = (client.call as any).bind(client) as (
    method: string,
    payload: any,
    signal?: AbortSignal,
    options?: any
  ) => Promise<unknown>;
  (client as any).call = async (
    method: string,
    payload: any,
    signal?: AbortSignal,
    options?: any
  ) => {
    sampleMemory?.();
    counters.rpcCalls++;
    counters.rpcByMethod[method] = (counters.rpcByMethod[method] ?? 0) + 1;
    if (method === "hashMarkdown") {
      counters.contentHashCalls++;
      counters.contentHashBytes += Buffer.byteLength(String(payload.markdown ?? ""), "utf8");
    } else if (method === "upsertLexicalRevision") {
      counters.contentHashCalls++;
      counters.contentHashBytes += Buffer.byteLength(String(payload.markdown ?? ""), "utf8");
    } else if (method === "applyLexicalBatch") {
      // The Worker hashes every Markdown item before parsing, including items
      // that it later skips as unchanged.
      const notes = payload.notes ?? payload.markdown ?? [];
      counters.contentHashCalls += notes.length;
      counters.contentHashBytes += notes.reduce(
        (sum: number, note: { markdown?: unknown }) =>
          sum + Buffer.byteLength(String(note.markdown ?? ""), "utf8"),
        0
      );
    }
    if (
      method === "getState" ||
      method === "boot" ||
      method === "finishReconciliation" ||
      method === "finishScopedReconciliation"
    )
      counters.stateCalls++;
    if (method === "prepareSemanticWork") counters.semanticPrepareCalls++;
    if (method === "commitSemanticResults") counters.semanticCommitCalls++;
    const started = performance.now();
    let result: unknown;
    try {
      result = await original(method, payload, signal, options);
    } finally {
      (counters.rpcElapsedMs[method] ??= []).push(performance.now() - started);
      sampleMemory?.();
    }
    if (method === "applyLexicalBatch" || method === "upsertLexicalRevision") {
      const batch = result as { inputHashCount?: unknown; inputHashBytes?: unknown };
      counters.inputHashCount += Number(batch.inputHashCount ?? 0);
      counters.inputHashBytes += Number(batch.inputHashBytes ?? 0);
    }
    if (method === "prepareSemanticWork") {
      if (payload.promoteUnrestricted !== false) counters.semanticUnrestrictedPromotionCalls++;
      const work = result as { requests?: readonly { serialization?: unknown }[] };
      counters.semanticPreparedItems += work.requests?.length ?? 0;
      counters.semanticPreparedInputBytes += (work.requests ?? []).reduce(
        (sum, request) => sum + Buffer.byteLength(String(request.serialization ?? ""), "utf8"),
        0
      );
    } else if (method === "commitSemanticResults") {
      counters.semanticStoredRows += Number((result as { stored?: unknown }).stored ?? 0);
    }
    if (method === "preparePublication") {
      counters.publicationValidationPasses += 2;
      counters.publicationValidationVectorRows += Number((result as any)?.state?.vectorCount ?? 0);
    } else if (method === "inspectPublication") {
      counters.publicationValidationPasses++;
      counters.publicationValidationVectorRows += Number((result as any)?.state?.vectorCount ?? 0);
    } else if (method === "adoptPublication") {
      counters.publicationValidationPasses++;
      counters.publicationValidationVectorRows += Number((result as any)?.vectorCount ?? 0);
    }
    return result;
  };
  return client;
}
