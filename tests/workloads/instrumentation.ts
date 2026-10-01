import { performance } from "node:perf_hooks";
import type { IndexProgress } from "@/domain/contracts";
import type { SqliteWorkerClient } from "@/index/sqlite/client";
import type { SemanticPhaseObservation } from "../sqlite-test-client";

export interface SemanticCallObservation {
  readonly scenario: string;
  readonly method: "prepareSemanticWork" | "commitSemanticResults";
  readonly ordinal: number;
  readonly rpcMs: number;
  readonly handlerMs: number;
  readonly boundaryUnattributedMs: number;
  readonly surroundingJsEstimateMs: number;
  readonly phases: readonly (SemanticPhaseObservation & { readonly samples: number })[];
  readonly requestCount: number;
  readonly inputBytes: number;
  readonly vectorPayloadBytes: number;
  readonly blobCopyBytes: number;
  readonly hasMore: boolean;
  readonly promoted: number;
  readonly stored: number;
  readonly skipped: number;
  readonly progressCallbacks: number;
}

function summarizePhases(phases: readonly SemanticPhaseObservation[]) {
  const grouped = new Map<string, SemanticPhaseObservation & { samples: number }>();
  for (const phase of phases) {
    const key = `${phase.operation}:${phase.phase}:${phase.nested}`;
    const prior = grouped.get(key);
    grouped.set(
      key,
      prior
        ? {
            ...prior,
            wallMs: prior.wallMs + phase.wallMs,
            sqlMs: prior.sqlMs + phase.sqlMs,
            sqlCalls: prior.sqlCalls + phase.sqlCalls,
            callbackRows: prior.callbackRows + phase.callbackRows,
            copiedBytes: prior.copiedBytes + phase.copiedBytes,
            jsEstimateMs: prior.jsEstimateMs + phase.jsEstimateMs,
            samples: prior.samples + 1,
          }
        : { ...phase, samples: 1 }
    );
  }
  return [...grouped.values()];
}

export interface BenchmarkMemorySampler {
  readonly peak: number;
  readonly sampleCount: number;
  sample(): number;
  reset(): number;
  stop(): number;
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
    reset() {
      if (stopped) return peak;
      peak = 0;
      sampleCount = 0;
      return sample();
    },
    stop() {
      if (stopped) return peak;
      const final = sample();
      stopped = true;
      clearInterval(interval);
      return final;
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
  semanticScenario: string;
  semanticPhases: SemanticPhaseObservation[];
  semanticHandlerMs: number[];
  semanticCalls: SemanticCallObservation[];
  providerElapsedMs: number[];
  providerInputDigests: string[];
  vectorConversionMs: number;
  vectorConversionBytes: number;
  vectorConversionCount: number;
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
    semanticScenario: "outside-lifecycle",
    semanticPhases: [],
    semanticHandlerMs: [],
    semanticCalls: [],
    providerElapsedMs: [],
    providerInputDigests: [],
    vectorConversionMs: 0,
    vectorConversionBytes: 0,
    vectorConversionCount: 0,
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
  sampleMemory?: () => void,
  diagnostics = true
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
    if (diagnostics) {
      counters.rpcCalls++;
      counters.rpcByMethod[method] = (counters.rpcByMethod[method] ?? 0) + 1;
    }
    if (method === "applyLexicalBatch") {
      // The Worker hashes every Markdown item before parsing, including items
      // that it later skips as unchanged.
      const notes = payload.notes ?? payload.markdown ?? [];
      if (diagnostics) counters.contentHashCalls += notes.length;
      if (diagnostics)
        counters.contentHashBytes += notes.reduce(
          (sum: number, note: { markdown?: unknown }) =>
            sum + Buffer.byteLength(String(note.markdown ?? ""), "utf8"),
          0
        );
    }
    if (method === "getState" || method === "boot") counters.stateCalls++;
    if (method === "prepareSemanticWork") counters.semanticPrepareCalls++;
    if (method === "commitSemanticResults") counters.semanticCommitCalls++;
    const semantic = method === "prepareSemanticWork" || method === "commitSemanticResults";
    const phaseStart = counters.semanticPhases.length;
    const handlerStart = counters.semanticHandlerMs.length;
    const progressStart = counters.progressCallbacks;
    const started = performance.now();
    let rpcMs = 0;
    let result: unknown;
    try {
      result = await original(method, payload, signal, options);
    } finally {
      rpcMs = performance.now() - started;
      if (diagnostics) (counters.rpcElapsedMs[method] ??= []).push(rpcMs);
      sampleMemory?.();
    }
    if (method === "applyLexicalBatch") {
      const batch = result as { inputHashCount?: unknown; inputHashBytes?: unknown };
      if (diagnostics) {
        counters.inputHashCount += Number(batch.inputHashCount ?? 0);
        counters.inputHashBytes += Number(batch.inputHashBytes ?? 0);
      }
    }
    if (method === "prepareSemanticWork") {
      if (diagnostics && payload.promoteUnrestricted !== false)
        counters.semanticUnrestrictedPromotionCalls++;
      const work = result as { requests?: readonly { serialization?: unknown }[] };
      if (diagnostics) counters.semanticPreparedItems += work.requests?.length ?? 0;
      if (diagnostics)
        counters.semanticPreparedInputBytes += (work.requests ?? []).reduce(
          (sum, request) => sum + Buffer.byteLength(String(request.serialization ?? ""), "utf8"),
          0
        );
    } else if (method === "commitSemanticResults") {
      if (diagnostics)
        counters.semanticStoredRows += Number((result as { stored?: unknown }).stored ?? 0);
    }
    if (diagnostics && semantic) {
      const work = result as {
        requests?: readonly { serialization: string }[];
        hasMore?: boolean;
        promoted?: number;
        stored?: number;
        skipped?: number;
      };
      const sent = payload.results as
        readonly { serialization: string; vector: Float32Array }[] | undefined;
      const requests = work.requests ?? sent ?? [];
      const vectorPayloadBytes = sent?.reduce((sum, item) => sum + item.vector.byteLength, 0) ?? 0;
      const phases = summarizePhases(counters.semanticPhases.slice(phaseStart));
      const handlerMs = counters.semanticHandlerMs[handlerStart] ?? 0;
      counters.semanticCalls.push({
        scenario: counters.semanticScenario,
        method,
        ordinal:
          counters.semanticCalls.filter(
            (call) => call.scenario === counters.semanticScenario && call.method === method
          ).length + 1,
        rpcMs,
        handlerMs,
        boundaryUnattributedMs: Math.max(0, rpcMs - handlerMs),
        surroundingJsEstimateMs: Math.max(
          0,
          handlerMs -
            counters.semanticPhases
              .slice(phaseStart)
              .filter((phase) => !phase.nested)
              .reduce((sum, phase) => sum + phase.wallMs, 0)
        ),
        phases,
        requestCount: requests.length,
        inputBytes: requests.reduce(
          (sum, item) => sum + Buffer.byteLength(item.serialization, "utf8"),
          0
        ),
        vectorPayloadBytes,
        blobCopyBytes: phases.find((phase) => phase.phase === "knownBlobCopy")?.copiedBytes ?? 0,
        hasMore: Boolean(work.hasMore),
        promoted: Number(work.promoted ?? 0),
        stored: Number(work.stored ?? 0),
        skipped: Number(work.skipped ?? 0),
        progressCallbacks: counters.progressCallbacks - progressStart,
      });
      counters.semanticPhases.length = 0;
      counters.semanticHandlerMs.length = 0;
    }
    if (method === "preparePublication") {
      if (diagnostics) {
        counters.publicationValidationPasses += 2;
        counters.publicationValidationVectorRows += Number(
          (result as any)?.state?.vectorCount ?? 0
        );
      }
    } else if (method === "inspectPublication") {
      if (diagnostics) {
        counters.publicationValidationPasses++;
        counters.publicationValidationVectorRows += Number(
          (result as any)?.state?.vectorCount ?? 0
        );
      }
    } else if (method === "adoptPublication") {
      if (diagnostics) {
        counters.publicationValidationPasses++;
        counters.publicationValidationVectorRows += Number((result as any)?.vectorCount ?? 0);
      }
    }
    return result;
  };
  return client;
}
