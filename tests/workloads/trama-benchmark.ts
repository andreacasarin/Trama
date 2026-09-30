import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ChatSession } from "@/chat/ChatSession";
import type { ChatModel, EmbeddingModel, ReadonlyVault } from "@/domain/contracts";
import { chunkMarkdownBlocks } from "@/index/chunking";
import { IndexManager, type IndexPathMutation, type IndexVaultPort } from "@/index/IndexManager";
import { LenteSearch } from "@/index/LenteSearch";
import { RelatedNotes } from "@/index/RelatedNotes";
import { PublicationManager } from "@/index/publications/PublicationManager";
import {
  PublicationStore,
  type PublicationDataAdapter,
} from "@/index/publications/PublicationStore";
import { ToolRegistry, VaultSearchTool } from "@/tools/ToolRegistry";
import {
  createTestSqliteClient,
  inspectBenchmarkSnapshot,
  snapshotFor,
} from "../sqlite-test-client";
import {
  deterministicProviderChallengeDigest,
  workloadQueryVectorDigest,
  workloadSourceDigest,
  type Workload,
  type WorkloadMutation,
  type WorkloadNote,
} from "./generator";
import {
  deterministicProviderChallengeSha256,
  DETERMINISTIC_PROVIDER_BEHAVIOR_VERSION,
  expectedOutputsV1ByProfile,
  queryVectorSha256V1,
  referenceBaselineV1,
  REFERENCE_SOURCE_MANIFEST_SHA256,
  sourceDigestsV1,
  WORKLOAD_CONTRACT_VERSION,
} from "./contract-v1";
import { WORKLOAD_DIMENSIONS, WORKLOAD_FINGERPRINT } from "./config";
import { SQLITE_BUILD_IDENTITY } from "@/build/identity";
import {
  createBenchmarkCounters,
  createBenchmarkMemorySampler,
  instrumentSqliteClient,
  observeProgress,
  observeProvider,
  observeVaultList,
  observeVaultRead,
  type BenchmarkCounters,
} from "./instrumentation";

export interface BenchmarkScenario {
  readonly durationMs: number;
  readonly changed?: boolean;
  readonly converged?: boolean;
  readonly providerTexts?: number;
  readonly providerStubTexts?: number;
}

export interface BenchmarkRssWindow {
  readonly start: "before-full-build-call";
  readonly end?: "after-successful-publish";
  readonly excludes: readonly [
    "fixture-generation",
    "manager-construction",
    "adoption",
    "retrieval-queries",
    "chat-tool-turn",
  ];
}

export function benchmarkRssWindow(publicationCompleted: boolean): BenchmarkRssWindow {
  return {
    start: "before-full-build-call",
    ...(publicationCompleted ? { end: "after-successful-publish" as const } : {}),
    excludes: [
      "fixture-generation",
      "manager-construction",
      "adoption",
      "retrieval-queries",
      "chat-tool-turn",
    ],
  };
}

export interface TramaBenchmark {
  readonly reportVersion: "trama-benchmark-report-v2";
  readonly lifecycle: {
    readonly initialState: string;
    readonly completion: string;
    readonly resetBoundary: string;
  };
  readonly workloadContractVersion: string;
  readonly buildIdentity: string;
  readonly provenance: {
    readonly referenceBaseRevision: string;
    readonly referenceTreeStatus: string;
    readonly referenceSourceManifestSha256: string;
  };
  readonly sourceDigest: string;
  readonly provider: {
    readonly name: "deterministic-fixture";
    readonly behaviorVersion: string;
    readonly dimensions: number;
    readonly fingerprint: string;
    readonly challengeSha256: string;
    readonly queryVectorSha256: string;
  };
  readonly profile: string;
  readonly seed: number;
  readonly environment: {
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
    readonly repetitions: number;
    readonly timeoutMs: number;
  };
  readonly notes: number;
  readonly chunks: number;
  readonly durationMs: Readonly<Record<string, number>>;
  readonly latencyMs: Readonly<
    Record<string, { samples: number; p50: number; p95: number; max: number }>
  >;
  readonly semanticPrepareTimingMs?: {
    readonly beginning: number;
    readonly middle: number;
    readonly end: number;
  };
  readonly rpcLatencyMs?: Readonly<
    Record<string, { samples: number; p50: number; p95: number; max: number }>
  >;
  readonly scenarios: Readonly<Record<string, BenchmarkScenario>>;
  readonly counters?: BenchmarkCounters;
  readonly counts: Readonly<Record<string, number>>;
  readonly bytes: Readonly<Record<string, number | "unsupported">>;
  readonly memory: {
    readonly processRssBefore: number;
    readonly processRssAfter: number;
    readonly processRssObservedPeak: number;
    readonly processRssSampleCount: number;
    readonly processRssDelta: number;
    readonly rssWindow: BenchmarkRssWindow;
  };
  readonly correctness: Readonly<Record<string, boolean>>;
  readonly unsupported: readonly string[];
  readonly indexingThroughPublicationMs: number;
  readonly core: {
    readonly scenarioNames: readonly string[];
    readonly rssBytes: {
      readonly before: number;
      readonly after: number;
      readonly peak: number;
      readonly samples: number;
      readonly boundary: string;
    };
    readonly providerCalls: number;
    readonly providerTexts: number;
    readonly observable: {
      readonly initial: {
        readonly noteCount: number;
        readonly occurrenceCount: number;
        readonly perPathOccurrenceCountsSha256: string;
        readonly occurrenceContentSha256: string;
      };
      readonly final: {
        readonly noteCount: number;
        readonly occurrenceCount: number;
        readonly perPathOccurrenceCountsSha256: string;
        readonly occurrenceContentSha256: string;
      };
      readonly semantic: {
        readonly semanticEligibleCount: number;
        readonly semanticHeadCount: number;
        readonly semanticLagCount: number;
        readonly semanticMissingCount: number;
        readonly compatibleVectorCount: number;
        readonly semanticReady: boolean;
      };
      readonly lexical: readonly { readonly path: string; readonly occurrenceOrdinal?: number }[];
      readonly hybrid: readonly { readonly path: string; readonly occurrenceOrdinal?: number }[];
      readonly filo: readonly { readonly path: string }[];
      readonly voce: readonly { readonly path: string; readonly occurrenceOrdinal?: number }[];
    };
  };
  readonly diagnostics?: {
    readonly rpcLatencyMs: Readonly<
      Record<string, { samples: number; p50: number; p95: number; max: number }>
    >;
    readonly phaseCounts: Readonly<Record<string, number>>;
  };
}

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
};

const elapsed = async (operation: () => Promise<unknown>): Promise<number> => {
  const started = performance.now();
  await operation();
  return performance.now() - started;
};

export const latency = async (operation: () => Promise<unknown>, samples = 3) => {
  const values: number[] = [];
  for (let sample = 0; sample < samples; sample++) values.push(await elapsed(operation));
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
};

class BenchmarkVault implements IndexVaultPort, ReadonlyVault {
  readonly notes = new Map<string, string>();
  readonly mtimes = new Map<string, number>();

  constructor(
    readonly counters: BenchmarkCounters,
    notes: readonly WorkloadNote[]
  ) {
    for (const note of notes) this.set(note.path, note.content);
  }

  set(path: string, content: string): void {
    this.notes.set(path, content);
    this.mtimes.set(path, (this.mtimes.get(path) ?? this.mtimes.size) + 1);
  }

  apply(mutation: WorkloadMutation): void {
    if (mutation.kind === "add" || mutation.kind === "modify")
      this.set(mutation.path, mutation.note!.content);
    if (mutation.kind === "delete") {
      this.notes.delete(mutation.path);
      this.mtimes.delete(mutation.path);
    }
    if (mutation.kind === "rename" && mutation.to) {
      const content = this.notes.get(mutation.path);
      this.notes.delete(mutation.path);
      this.mtimes.delete(mutation.path);
      if (content !== undefined) this.set(mutation.to, content);
    }
  }

  async listMarkdownPaths(): Promise<readonly string[]> {
    observeVaultList(this.counters);
    return [...this.notes.keys()];
  }

  async readMarkdown(path: string): Promise<{ path: string; content: string }> {
    const content = this.required(path);
    observeVaultRead(this.counters, content);
    return { path, content };
  }

  async isMarkdownAvailable(path: string): Promise<boolean> {
    return this.notes.has(path);
  }

  async readNote(path: string) {
    const content = this.required(path);
    observeVaultRead(this.counters, content);
    return { path, content, startLine: 1, endLine: content.split("\n").length };
  }

  async currentNotePath(): Promise<string | null> {
    return this.notes.keys().next().value ?? null;
  }

  async resolveLink(): Promise<string | null> {
    return null;
  }

  async discoverLinks(): Promise<readonly []> {
    return [];
  }

  private required(path: string): string {
    const content = this.notes.get(path);
    if (content === undefined) throw new Error(`Missing benchmark note: ${path}`);
    return content;
  }
}

class BenchmarkEmbedding implements EmbeddingModel {
  readonly dimensions = 768;
  private readonly vectors = new Map<string, Float32Array>();

  constructor(
    workload: Workload,
    private readonly counters: BenchmarkCounters,
    private readonly sampleMemory?: () => void
  ) {
    for (const note of [
      ...workload.notes,
      ...workload.mutations.flatMap((mutation) => (mutation.note ? [mutation.note] : [])),
    ])
      for (const chunk of note.chunks) this.vectors.set(chunk.embeddingInput, chunk.vector);
    for (const query of workload.queries) this.vectors.set(query.text, query.vector);
  }

  async embed(texts: readonly string[]): Promise<readonly number[][]> {
    this.sampleMemory?.();
    const vectors = texts.map((text) => {
      const vector = this.vectors.get(text);
      if (vector) return Array.from(vector);
      this.counters.providerStubTexts++;
      return Array.from(this.fallback());
    });
    observeProvider(this.counters, texts, vectors);
    this.sampleMemory?.();
    return vectors;
  }

  private fallback(): Float32Array {
    const vector = new Float32Array(this.dimensions);
    vector[0] = 1;
    return vector;
  }
}

class MemoryPublicationAdapter implements PublicationDataAdapter {
  readonly binary = new Map<string, ArrayBuffer>();
  async exists(path: string): Promise<boolean> {
    return this.binary.has(path);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.binary.get(path);
    if (!value) throw new Error(`Missing benchmark publication: ${path}`);
    return value.slice(0);
  }
  async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
    this.binary.set(path, value.slice(0));
  }
  async mkdir(): Promise<void> {
    // The in-memory adapter does not need directories.
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    const value = this.binary.get(oldPath);
    if (!value) throw new Error(`Missing staged benchmark publication: ${oldPath}`);
    this.binary.set(newPath, value);
    this.binary.delete(oldPath);
  }
  async remove(path: string): Promise<void> {
    this.binary.delete(path);
  }
}

function packageBytes(): number | "unsupported" {
  try {
    return [
      "main.js",
      "sqlite-worker.mjs",
      "sqlite3.mjs",
      "sqlite3.wasm",
      "manifest.json",
      "styles.css",
    ].reduce((sum, file) => sum + statSync(file).size, 0);
  } catch {
    return "unsupported";
  }
}

function manager(
  vault: BenchmarkVault,
  embedding: BenchmarkEmbedding,
  identity: object,
  counters: BenchmarkCounters,
  sampleMemory?: () => void,
  diagnostics = true
): IndexManager {
  const client = instrumentSqliteClient(
    createTestSqliteClient(identity, { persistMutations: false, captureLifecycleSnapshots: true }),
    counters,
    sampleMemory,
    diagnostics
  );
  return new IndexManager(vault, embedding, "http://benchmark.invalid/v1", "fixture", {
    sqliteClient: client,
    publicationDirectory: "Trama/index",
    onProgress: (progress) => observeProgress(counters, progress, sampleMemory),
  });
}

function scenario(
  before: BenchmarkCounters,
  after: BenchmarkCounters,
  duration: number,
  result?: { changed?: boolean; converged?: boolean }
): BenchmarkScenario {
  return {
    durationMs: duration,
    ...(result?.changed === undefined ? {} : { changed: result.changed }),
    ...(result?.converged === undefined ? {} : { converged: result.converged }),
    providerTexts: after.providerTexts - before.providerTexts,
    providerStubTexts: after.providerStubTexts - before.providerStubTexts,
  };
}

function cloneCounters(counters: BenchmarkCounters): BenchmarkCounters {
  return {
    ...counters,
    rpcByMethod: { ...counters.rpcByMethod },
    rpcElapsedMs: Object.fromEntries(
      Object.entries(counters.rpcElapsedMs).map(([method, values]) => [method, [...values]])
    ),
    progressByPhase: { ...counters.progressByPhase },
  };
}

function expectedChunkCount(vault: BenchmarkVault): number {
  return [...vault.notes.values()].reduce(
    (sum, content) => sum + chunkMarkdownBlocks(content).length,
    0
  );
}

export async function runTramaBenchmark(
  workload: Workload,
  options: {
    readonly repetitions?: number;
    readonly timeoutMs?: number;
    readonly diagnostics?: boolean;
    readonly onScenario?: (
      name: string,
      scenario: BenchmarkScenario,
      counters: BenchmarkCounters,
      durationMs: Readonly<Record<string, number>>,
      scenarios: Readonly<Record<string, BenchmarkScenario>>
    ) => void;
  } = {}
): Promise<TramaBenchmark> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const repetitions = Math.max(1, Math.floor(options.repetitions ?? 1));
  const memorySampler = createBenchmarkMemorySampler();
  const sampleMemory = () => {
    memorySampler.sample();
  };
  let rssBefore = memorySampler.peak;
  let rssAfter = memorySampler.peak;
  let indexingThroughPublicationMs = 0;
  let publicationCompleted = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  const signal = controller.signal;
  const counters = createBenchmarkCounters();
  const diagnostics = options.diagnostics ?? true;
  const vault = new BenchmarkVault(counters, workload.notes);
  const embedding = new BenchmarkEmbedding(workload, counters, sampleMemory);
  const publicationAdapter = new MemoryPublicationAdapter();
  const initialIdentity = {};
  const index = manager(vault, embedding, initialIdentity, counters, sampleMemory, diagnostics);
  const publication = new PublicationManager(
    index,
    new PublicationStore(publicationAdapter, { directory: "Trama/index" })
  );
  const durationMs: Record<string, number> = {};
  const scenarios: Record<string, BenchmarkScenario> = {};
  let indexingStarted = 0;
  let restarted: IndexManager | undefined;
  try {
    const measure = async <T extends { changed?: boolean; converged?: boolean } | void>(
      name: string,
      operation: () => Promise<T>
    ) => {
      sampleMemory();
      const before = cloneCounters(counters);
      const started = performance.now();
      const result = await operation();
      sampleMemory();
      const duration = performance.now() - started;
      durationMs[name] = duration;
      scenarios[name] = scenario(before, counters, duration, result ?? undefined);
      try {
        options.onScenario?.(name, scenarios[name], cloneCounters(counters), durationMs, scenarios);
      } catch {
        /* Benchmark evidence must not affect the workload. */
      }
      return result;
    };

    rssBefore = memorySampler.reset();
    indexingStarted = performance.now();
    await measure("fullBuild", async () => {
      await index.build(signal);
      return { changed: true, converged: (await index.getState())?.incomplete === false };
    });
    const initialState = await index.getState();
    const initialSnapshot = await snapshotFor(initialIdentity);
    const initialOutput = await inspectBenchmarkSnapshot(initialSnapshot);
    await measure("immediateNoop", () => index.reconcileQueuedChanges(signal));
    await measure("unchangedFullReconciliation", () => index.synchronize(signal));
    const uncached = await measure("semanticUncached", () => index.prepareSemantic(signal));
    const semanticState = await index.getState();
    const cached = await measure("semanticCached", () => index.prepareSemantic(signal));

    const scopedMutation = (mutation: IndexPathMutation) => {
      index.recordPathMutation(mutation);
      return index.reconcileQueuedChanges(signal);
    };

    const added = workload.mutations.find((mutation) => mutation.kind === "add")!;
    vault.apply(added);
    const scopedAdd = await measure("scopedAdd", () =>
      scopedMutation({ type: "upsert", path: added.path })
    );

    const modified = workload.mutations.find((mutation) => mutation.kind === "modify")!;
    vault.apply(modified);
    const scopedModify = await measure("scopedModify", () =>
      scopedMutation({ type: "upsert", path: modified.path })
    );
    const partial = await measure("semanticPartial", () => index.prepareSemantic(signal));

    const deleted = workload.mutations.find((mutation) => mutation.kind === "delete")!;
    vault.apply(deleted);
    const scopedDelete = await measure("scopedDelete", () =>
      scopedMutation({ type: "delete", path: deleted.path })
    );
    const renamed = workload.mutations.find((mutation) => mutation.kind === "rename")!;
    vault.apply(renamed);
    const scopedRename = await measure("scopedRename", () =>
      scopedMutation({ type: "rename", from: renamed.path, to: renamed.to! })
    );

    const published = await measure("publish", async () => {
      const result = await publication.publish();
      indexingThroughPublicationMs = performance.now() - indexingStarted;
      publicationCompleted = result.published;
      rssAfter = memorySampler.stop();
      return { changed: result.published, converged: result.published };
    });
    const publicationBytes = await publication.store.read();
    const publicationOutput = publicationBytes
      ? await inspectBenchmarkSnapshot(publicationBytes)
      : undefined;
    const restartedIdentity = {};
    const restartedManager = manager(
      vault,
      new BenchmarkEmbedding(workload, counters, sampleMemory),
      restartedIdentity,
      counters,
      sampleMemory,
      diagnostics
    );
    restarted = restartedManager;
    const restartedPublication = new PublicationManager(
      restartedManager,
      new PublicationStore(publicationAdapter, { directory: "Trama/index" })
    );
    const adopted = await measure("publicationAdopt", async () => {
      await restartedManager.load();
      const result = await restartedPublication.adoptCurrent();
      return { changed: result.adopted, converged: result.adopted };
    });
    const adoptedOutput = await inspectBenchmarkSnapshot(await snapshotFor(restartedIdentity));

    const query = workload.queries.find((candidate) => candidate.id === "hostile")!;
    const lente = new LenteSearch(restartedManager, {
      getMtime: (path) => vault.mtimes.get(path) ?? null,
    });
    const queryStarted = performance.now();
    let latestLente: Awaited<ReturnType<LenteSearch["search"]>> | undefined;
    let latestLexical: Awaited<ReturnType<LenteSearch["search"]>> | undefined;
    let latestFilo: Awaited<ReturnType<RelatedNotes["find"]>> | undefined;
    let latestVoce: Awaited<ReturnType<VaultSearchTool["execute"]>> | undefined;
    const latencyMs = {
      lexical: await latency(async () => {
        latestLexical = await lente.search(query.text, { searchMethod: "keyword" });
        return latestLexical;
      }, repetitions),
      hybrid: await latency(async () => {
        latestLente = await lente.search(query.text);
        return latestLente;
      }, repetitions),
      filo: await latency(async () => {
        latestFilo = await new RelatedNotes(restartedManager).find(
          workload.notes[0].path,
          signal,
          7,
          true
        );
        return latestFilo;
      }, repetitions),
      voce: await latency(async () => {
        latestVoce = await new VaultSearchTool(restartedManager).execute(
          { query: query.text },
          signal
        );
        return latestVoce;
      }, repetitions),
    };
    const semanticScores = [
      ...(latestLente?.canonicalResults ?? []).flatMap((hit) => [
        hit.semanticScore,
        hit.fusedScore,
      ]),
      ...(latestFilo?.results ?? []).flatMap((hit) => [hit.similarity, hit.score]),
      ...(latestVoce?.provenance ?? []).map((record) => record.score),
    ].filter((score): score is number => score !== undefined);
    if (!semanticScores.length) throw new Error("Semantic benchmark produced no scores");
    if (semanticScores.some((score) => !Number.isFinite(score)))
      throw new Error("Semantic benchmark produced a non-finite score");
    durationMs.queries = performance.now() - queryStarted;

    let round = 0;
    const chatModel: ChatModel = {
      complete: async () =>
        round++ === 0
          ? {
              message: {
                role: "assistant",
                content: "",
                toolCalls: [
                  { id: "search", name: "vault_search", arguments: { query: query.text } },
                ],
              },
              finishReason: "tool_calls",
            }
          : { message: { role: "assistant", content: "done" }, finishReason: "stop" },
    };
    await measure("chatToolTurn", async () => {
      await new ChatSession(
        chatModel,
        new ToolRegistry([new VaultSearchTool(restartedManager)]),
        vault
      ).send({
        content: "Find relevant notes",
        attachmentPaths: [],
      });
    });

    const finalState = await restartedManager.getState();
    const rpcLatencyMs = Object.fromEntries(
      Object.entries(counters.rpcElapsedMs).map(([method, values]) => [
        method,
        {
          samples: values.length,
          p50: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          max: Math.max(...values),
        },
      ])
    );
    const semanticPrepareSamples = counters.rpcElapsedMs.prepareSemanticWork ?? [];
    const semanticPrepareTimingMs = semanticPrepareSamples.length
      ? {
          beginning: semanticPrepareSamples[0]!,
          middle: semanticPrepareSamples[Math.floor(semanticPrepareSamples.length / 2)]!,
          end: semanticPrepareSamples.at(-1)!,
        }
      : undefined;
    const expectedChunks = expectedChunkCount(vault);
    memorySampler.sample();

    const allConverged = [
      scopedAdd,
      scopedModify,
      partial,
      scopedDelete,
      scopedRename,
      published,
      adopted,
    ].every((result) => result?.converged !== false);
    const finalOutput = await inspectBenchmarkSnapshot(await snapshotFor(restartedIdentity));
    const digestCounts = (value: typeof initialOutput) =>
      createHash("sha256").update(JSON.stringify(value.perPathOccurrenceCounts)).digest("hex");
    const identities = (results: readonly { path: string; ordinal?: number }[] = []) =>
      results.map((result) => ({
        path: result.path,
        ...(result.ordinal === undefined ? {} : { occurrenceOrdinal: result.ordinal }),
      }));
    const adoptedPublicSemanticState = finalState && {
      semanticEligibleCount: finalState.semanticEligibleCount,
      semanticHeadCount: finalState.semanticHeadCount,
      semanticLagCount: finalState.semanticLagCount,
      semanticMissingCount: finalState.semanticMissingCount,
      compatibleVectorCount: finalState.compatibleVectorCount,
      semanticReady: finalState.semanticReady,
    };
    const publishedMatchesAdopted = Boolean(
      publicationOutput &&
      JSON.stringify(publicationOutput.perPathOccurrenceCounts) ===
        JSON.stringify(finalOutput.perPathOccurrenceCounts) &&
      publicationOutput.occurrenceContentSha256 === finalOutput.occurrenceContentSha256 &&
      JSON.stringify(publicationOutput.semanticState) ===
        JSON.stringify(finalOutput.semanticState) &&
      JSON.stringify(publicationOutput.semanticState) === JSON.stringify(adoptedPublicSemanticState)
    );
    const expected = expectedOutputsV1ByProfile[workload.profile.id];
    const sourceDigest = workloadSourceDigest(workload);
    const renamedOriginal = workload.notes.find((note) => note.path === renamed.path)!;
    const modifiedOriginal = workload.notes.find((note) => note.path === modified.path)!;
    const deletedOriginal = workload.notes.find((note) => note.path === deleted.path)!;
    const expectedFinalOccurrenceCount =
      initialOutput.occurrenceCount +
      added.note!.chunks.length +
      (modified.note!.chunks.length - modifiedOriginal.chunks.length) -
      deletedOriginal.chunks.length +
      (renamed.note!.chunks.length - renamedOriginal.chunks.length);
    const expectedFinalNoteCount = initialOutput.noteCount + 1 - 1;
    const actualOracle = {
      initial: {
        noteCount: initialOutput.noteCount,
        occurrenceCount: initialOutput.occurrenceCount,
        perPathOccurrenceCountsSha256: digestCounts(initialOutput),
        occurrenceContentSha256: initialOutput.occurrenceContentSha256,
      },
      final: {
        noteCount: finalOutput.noteCount,
        occurrenceCount: finalOutput.occurrenceCount,
        perPathOccurrenceCountsSha256: digestCounts(finalOutput),
        occurrenceContentSha256: finalOutput.occurrenceContentSha256,
      },
      semantic: publicationOutput?.semanticState ?? {
        semanticEligibleCount: 0,
        semanticHeadCount: 0,
        semanticLagCount: 0,
        semanticMissingCount: 0,
        compatibleVectorCount: 0,
        semanticReady: false,
      },
      probes: {
        lexical: identities(latestLexical?.results ?? []),
        hybrid: identities(latestLente?.canonicalResults ?? []),
        filo: (latestFilo?.results ?? []).map((result) => ({ path: result.path })),
        voce: identities(
          (
            (latestVoce?.provenance ?? []) as readonly {
              path?: string;
              occurrenceOrdinal?: number;
              ordinal?: number;
            }[]
          ).flatMap((result) =>
            result.path
              ? [{ path: result.path, ordinal: result.occurrenceOrdinal ?? result.ordinal }]
              : []
          )
        ),
      },
    };
    return {
      reportVersion: "trama-benchmark-report-v2",
      lifecycle: {
        initialState: "fresh empty SQLite index, fixture vault populated, no publication present",
        completion:
          "semantic cache converged, scoped mutations reconciled, publication adopted, and pinned outputs match",
        resetBoundary:
          "each invocation creates a new vault, SQLite client identity, publication adapter, and deterministic embedding fixture",
      },
      workloadContractVersion: WORKLOAD_CONTRACT_VERSION,
      buildIdentity: SQLITE_BUILD_IDENTITY,
      provenance: {
        referenceBaseRevision: referenceBaselineV1.referenceBaseRevision,
        referenceTreeStatus: referenceBaselineV1.referenceTreeStatus,
        referenceSourceManifestSha256: REFERENCE_SOURCE_MANIFEST_SHA256,
      },
      provider: {
        name: "deterministic-fixture",
        behaviorVersion: DETERMINISTIC_PROVIDER_BEHAVIOR_VERSION,
        dimensions: WORKLOAD_DIMENSIONS,
        fingerprint: WORKLOAD_FINGERPRINT,
        challengeSha256: deterministicProviderChallengeDigest(),
        queryVectorSha256: workloadQueryVectorDigest(workload),
      },
      sourceDigest,
      profile: workload.profile.id,
      seed: workload.seed,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        repetitions,
        timeoutMs,
      },
      notes: workload.notes.length,
      chunks: workload.notes.reduce((sum, note) => sum + note.chunks.length, 0),
      durationMs,
      latencyMs,
      ...(diagnostics
        ? { ...(semanticPrepareTimingMs ? { semanticPrepareTimingMs } : {}), rpcLatencyMs }
        : {}),
      scenarios,
      ...(diagnostics ? { counters } : {}),
      counts: {
        initialIndexedNotes: initialState?.noteCount ?? 0,
        initialIndexedChunks: initialState?.chunkCount ?? 0,
        semanticStored: (uncached as { stored?: number } | undefined)?.stored ?? 0,
        semanticCachedStored: (cached as { stored?: number } | undefined)?.stored ?? 0,
        semanticPartialStored: (partial as { stored?: number } | undefined)?.stored ?? 0,
        semanticIndexedChunks: semanticState?.chunkCount ?? 0,
        semanticPrepareCalls: counters.semanticPrepareCalls,
        semanticCommitCalls: counters.semanticCommitCalls,
        finalIndexedNotes: finalState?.noteCount ?? 0,
        finalIndexedChunks: finalState?.chunkCount ?? 0,
      },
      bytes: {
        package: packageBytes(),
        publication: publicationBytes?.byteLength ?? "unsupported",
      },
      memory: {
        processRssBefore: rssBefore,
        processRssAfter: rssAfter,
        processRssObservedPeak: memorySampler.peak,
        processRssSampleCount: memorySampler.sampleCount,
        processRssDelta: rssAfter - rssBefore,
        rssWindow: benchmarkRssWindow(publicationCompleted),
      },
      correctness: {
        fixtureChunkCount:
          workload.notes.reduce((sum, note) => sum + note.chunks.length, 0) ===
          workload.profile.targetChunks,
        initialCountsMatch:
          initialState?.noteCount === workload.notes.length &&
          initialState.chunkCount === workload.profile.targetChunks,
        semanticUncachedConverged: uncached?.converged === true,
        semanticCachedNoProviderWork: scenarios.semanticCached.providerTexts === 0,
        semanticPartialConverged: partial?.converged === true,
        semanticResultsPresent: semanticScores.length > 0,
        semanticScoresFinite: semanticScores.every((score) => Number.isFinite(score)),
        finalCountsMatch:
          finalState?.noteCount === vault.notes.size && finalState.chunkCount === expectedChunks,
        allMutationsConverged: allConverged,
        publicationPublished: published?.changed === true,
        publicationAdopted: adopted?.changed === true,
        publishedOutputMatchesAdopted: publishedMatchesAdopted,
        initialOutputSnapshotInspected: initialOutput.occurrenceCount === initialState?.chunkCount,
        finalOutputSnapshotInspected: adoptedOutput.occurrenceCount === finalState?.chunkCount,
        sourceDigestPinned: sourceDigest === sourceDigestsV1[workload.profile.id],
        outputOracleMatches: JSON.stringify(actualOracle) === JSON.stringify(expected),
        occurrenceContentMatches:
          actualOracle.initial.occurrenceContentSha256 ===
            expected.initial.occurrenceContentSha256 &&
          actualOracle.final.occurrenceContentSha256 === expected.final.occurrenceContentSha256,
        mutationArithmeticMatches:
          finalOutput.occurrenceCount === expectedFinalOccurrenceCount &&
          finalOutput.noteCount === expectedFinalNoteCount,
        publishedSemanticMatchesAdopted: publishedMatchesAdopted,
        providerIdentityMatches:
          deterministicProviderChallengeDigest() === deterministicProviderChallengeSha256,
        queryVectorIdentityMatches: workloadQueryVectorDigest(workload) === queryVectorSha256V1,
      },
      unsupported: [
        "Worker+OPFS browser harness (repository has no packaged browser benchmark runner)",
        "transaction and SQL statement counts (test RPC seam exposes calls, not SQLite tracing)",
        "real LM Studio inference",
        "real Obsidian UI",
      ],
      indexingThroughPublicationMs,
      core: {
        scenarioNames: Object.keys(scenarios),
        rssBytes: {
          before: rssBefore,
          after: rssAfter,
          peak: memorySampler.peak,
          samples: memorySampler.sampleCount,
          boundary:
            "immediately before fullBuild through successful publish completion; sampled every 25ms and at instrumented boundaries, excluding adoption and queries",
        },
        providerCalls: counters.providerCalls,
        providerTexts: counters.providerTexts,
        observable: {
          initial: actualOracle.initial,
          final: actualOracle.final,
          semantic: actualOracle.semantic,
          ...actualOracle.probes,
        },
      },
      ...(diagnostics
        ? { diagnostics: { rpcLatencyMs, phaseCounts: { ...counters.progressByPhase } } }
        : {}),
    };
  } finally {
    memorySampler.stop();
    clearTimeout(timeout);
    await index.dispose().catch(() => undefined);
    await restarted?.dispose().catch(() => undefined);
  }
}
