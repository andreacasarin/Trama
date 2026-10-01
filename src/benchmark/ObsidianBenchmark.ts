import type { ChatModel, EmbeddingModel } from "@/domain/contracts";
import { ChatSession } from "@/chat/ChatSession";
import type { TramaDiagnostics, TramaPerformanceRecord } from "@/diagnostics/TramaDiagnostics";
import { bytesToHex, sha256Hex } from "@/index/Identity";
import { IndexManager } from "@/index/IndexManager";
import { LenteSearch } from "@/index/LenteSearch";
import { RelatedNotes } from "@/index/RelatedNotes";
import { PublicationManager } from "@/index/publications/PublicationManager";
import {
  PublicationStore,
  type PublicationDataAdapter,
} from "@/index/publications/PublicationStore";
import { ObsidianIndexVault } from "@/vault/indexing/ObsidianIndexVault";
import { ToolRegistry, VaultSearchTool } from "@/tools/ToolRegistry";
import { SQLITE_BUILD_IDENTITY } from "@/build/identity";
import type { SqliteRuntime } from "@/plugin/SqliteRuntime";
import {
  BENCHMARK_REPORT,
  readBenchmarkManifest,
  type BenchmarkManifest,
  type BenchmarkMutation,
} from "./Manifest";
import { expectedOutputsV1ByProfile } from "./Oracle";

const DIMENSIONS = 768;
const SEED = 0x5eed_768;
const ENDPOINT = "http://benchmark.invalid/v1";
const MODEL = "fixture";
const ORACLE_COUNTS = {
  "trama-small": { initial: 128, final: 125 },
  "trama-10k": { initial: 10000, final: 9993 },
  "trama-large": { initial: 25000, final: 24993 },
} as const;

function nextRandom(state: { value: number }): number {
  let value = state.value | 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.value = value | 0;
  return (value >>> 0) / 0x1_0000_0000;
}

/** Same v1 xorshift/Float32 vector fixture, with browser SHA-256. */
export async function benchmarkVector(key: string, forcedTie = false): Promise<Float32Array> {
  const hash = await sha256Hex(key);
  const state = { value: (SEED ^ Number.parseInt(hash.slice(0, 8), 16)) | 0 };
  const vector = new Float32Array(DIMENSIONS);
  let norm = 0;
  for (let i = 0; i < DIMENSIONS; i++) {
    const value = forcedTie ? (i === 0 ? 1 : 0) : nextRandom(state) * 2 - 1;
    vector[i] = value;
    norm += value * value;
  }
  const scale = 1 / Math.sqrt(norm);
  for (let i = 0; i < DIMENSIONS; i++) vector[i] *= scale;
  return vector;
}

export async function benchmarkFixtureVector(text: string): Promise<Float32Array> {
  const queryKey =
    text === 'alpha OR beta "quoted" -tag NEAR/3 (unsafe)'
      ? "query:hostile"
      : text === "anchor alpha"
        ? "query:semantic"
        : text === "naïve café 東京"
          ? "query:unicode"
          : text === "tie"
            ? "fixed-tie"
            : text === "large"
              ? "query:large"
              : text === ""
                ? "query:empty"
                : text;
  return benchmarkVector(
    queryKey,
    queryKey === "fixed-tie" || /notes\/0000[45]\/note-[45]\.md/.test(text)
  );
}

class FixtureEmbedding implements EmbeddingModel {
  readonly dimensions = DIMENSIONS;
  calls = 0;
  texts = 0;
  async embed(texts: readonly string[], signal: AbortSignal): Promise<readonly number[][]> {
    if (signal.aborted) throw new Error("Operation cancelled");
    this.calls++;
    this.texts += texts.length;
    return Promise.all(
      texts.map(async (text) => {
        return Array.from(await benchmarkFixtureVector(text));
      })
    );
  }
}

class MemoryPublicationAdapter implements PublicationDataAdapter {
  private readonly files = new Map<string, ArrayBuffer>();
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error("Publication missing");
    return bytes.slice(0);
  }
  async writeBinary(path: string, bytes: ArrayBuffer): Promise<void> {
    this.files.set(path, bytes.slice(0));
  }
  async mkdir(): Promise<void> {
    /* in-memory */
  }
  async rename(from: string, to: string): Promise<void> {
    const bytes = await this.readBinary(from);
    this.files.set(to, bytes);
    this.files.delete(from);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

export interface BenchmarkReport {
  readonly version: "trama-obsidian-report-v1";
  readonly status: "completed" | "error" | "timeout";
  readonly runId: string;
  readonly profile: BenchmarkManifest["profile"];
  readonly host: "obsidian-desktop";
  readonly appVersion: string;
  readonly pluginVersion: string;
  readonly buildIdentity: string;
  readonly runtime: "worker-wasm-opfs";
  readonly storage: "fresh-opfs-identity";
  readonly transport: "browser-worker";
  readonly publication: "in-memory";
  readonly diagnosticsMode: "scoped-performance";
  readonly sourceDigest: string;
  readonly workloadContractVersion: "trama-workload-contract-v1";
  readonly oracleVersion: "expected-outputs-v1";
  readonly providerChallengeSha256: string;
  readonly queryVectorSha256: string;
  readonly memory: { readonly rssBytes: "unsupported"; readonly heapBytes: "unsupported" };
  readonly boundaries: readonly string[];
  readonly scenarios: Readonly<
    Record<string, { durationMs: number; changed?: boolean; converged?: boolean }>
  >;
  readonly phases: Readonly<
    Record<
      string,
      {
        count: number;
        durationMs: number;
        sqlMs: number;
        sqlCalls: number;
        byteCount: number;
        itemCount: number;
      }
    >
  >;
  readonly correctness: Readonly<Record<string, boolean>>;
  readonly provider: { readonly calls: number; readonly texts: number };
  readonly error?: string;
}

interface BenchmarkApp {
  vault: any;
  version?: string;
}

function identity(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function aggregatePhase(
  aggregates: Record<
    string,
    {
      count: number;
      durationMs: number;
      sqlMs: number;
      sqlCalls: number;
      byteCount: number;
      itemCount: number;
    }
  >,
  record: TramaPerformanceRecord
): void {
  const key = `${record.operation}.${record.phase}`;
  const value = (aggregates[key] ??= {
    count: 0,
    durationMs: 0,
    sqlMs: 0,
    sqlCalls: 0,
    byteCount: 0,
    itemCount: 0,
  });
  value.count++;
  value.durationMs += record.durationMs;
  value.sqlMs += record.sqlMs ?? 0;
  value.sqlCalls += record.sqlCalls ?? 0;
  value.byteCount += record.byteCount ?? 0;
  value.itemCount += record.itemCount ?? 0;
}

/** Run only from the cold, validated benchmark branch in the plugin. */
export async function runObsidianBenchmark(
  app: BenchmarkApp,
  manifest: BenchmarkManifest,
  pluginVersion: string,
  sqlite: SqliteRuntime,
  diagnostics: TramaDiagnostics
): Promise<BenchmarkReport> {
  const adapter = app.vault.adapter;
  const ensureMarked = async () => {
    const fresh = await readBenchmarkManifest(adapter, app.vault.getName());
    if (
      !fresh ||
      typeof adapter.getBasePath !== "function" ||
      adapter.getBasePath() !== manifest.expectedPath ||
      JSON.stringify(fresh) !== JSON.stringify(manifest)
    )
      throw new Error("Benchmark vault marker changed; refusing mutation.");
  };
  await ensureMarked();
  const initialPaths = app.vault.getMarkdownFiles().map((file: { path: string }) => file.path);
  const expectedPaths = Array.from({ length: manifest.noteCount }, (_, index) =>
    index === 0
      ? "00-special/Ä.md"
      : index === 1
        ? "00-special/a.md"
        : index === 2
          ? "00-special/😀.md"
          : `notes/${String(index).padStart(5, "0")}/note-${index}.md`
  );
  if (
    initialPaths.length !== expectedPaths.length ||
    initialPaths.some((path: string) => !expectedPaths.includes(path))
  )
    throw new Error("Generated benchmark vault note inventory changed; refusing mutation.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), manifest.timeoutMs);
  const signal = controller.signal;
  const phases: Record<
    string,
    {
      count: number;
      durationMs: number;
      sqlMs: number;
      sqlCalls: number;
      byteCount: number;
      itemCount: number;
    }
  > = {};
  const scenarios: Record<string, { durationMs: number; changed?: boolean; converged?: boolean }> =
    {};
  const correctness: Record<string, boolean> = {};
  const embedding = new FixtureEmbedding();
  const publicationStorage = new MemoryPublicationAdapter();
  const vault = new ObsidianIndexVault(
    app.vault,
    (path) => path.endsWith(".md") && !path.startsWith(".")
  );
  const makeManager = () =>
    new IndexManager(
      vault,
      embedding,
      ENDPOINT,
      MODEL,
      {
        workerFactory: () => sqlite.createWorker(app),
        sqliteIdentity: Promise.resolve(identity()),
      },
      diagnostics
    );
  const manager = makeManager();
  let adoptedManager: IndexManager | undefined;
  const publication = new PublicationManager(manager, new PublicationStore(publicationStorage));
  const measure = async <T extends { changed?: boolean; converged?: boolean }>(
    name: string,
    work: () => Promise<T>
  ): Promise<T> => {
    if (signal.aborted) throw new Error("Benchmark timed out.");
    const started = performance.now();
    const result = await work();
    if (signal.aborted) throw new Error("Benchmark timed out.");
    scenarios[name] = {
      durationMs: performance.now() - started,
      ...(result.changed === undefined ? {} : { changed: result.changed }),
      ...(result.converged === undefined ? {} : { converged: result.converged }),
    };
    return result;
  };
  const mutate = async (mutation: BenchmarkMutation) => {
    await ensureMarked();
    if (mutation.kind === "add") {
      const parts = mutation.path.split("/");
      if (parts.length > 1)
        await app.vault.createFolder(parts.slice(0, -1).join("/")).catch(() => undefined);
      await app.vault.create(mutation.path, mutation.content);
      manager.recordPathMutation({ type: "upsert", path: mutation.path });
    } else if (mutation.kind === "modify") {
      const file = app.vault.getFileByPath(mutation.path);
      if (!file) throw new Error("Benchmark mutation target missing.");
      await app.vault.modify(file, mutation.content);
      manager.recordPathMutation({ type: "upsert", path: mutation.path });
    } else if (mutation.kind === "delete") {
      const file = app.vault.getFileByPath(mutation.path);
      if (!file) throw new Error("Benchmark mutation target missing.");
      await app.vault.delete(file);
      manager.recordPathMutation({ type: "delete", path: mutation.path });
    } else {
      const file = app.vault.getFileByPath(mutation.path);
      if (!file || !mutation.to) throw new Error("Benchmark rename target missing.");
      await app.vault.rename(file, mutation.to);
      manager.recordPathMutation({ type: "rename", from: mutation.path, to: mutation.to });
    }
  };
  let status: BenchmarkReport["status"] = "completed";
  let error: string | undefined;
  try {
    await manager.capturePerformance(
      async () => {
        await measure("fullBuild", async () => {
          const result = await manager.build(signal);
          return result;
        });
        const initial = await manager.getState();
        correctness.initialNoteCount = initial?.noteCount === manifest.noteCount;
        correctness.initialOccurrenceCount =
          initial?.chunkCount === ORACLE_COUNTS[manifest.profile].initial;
        await measure("immediateNoop", () => manager.reconcileQueuedChanges(signal));
        await measure("unchangedFullReconciliation", () => manager.synchronize(signal));
        await measure("semanticUncached", () => manager.prepareSemantic(signal));
        const providerBeforeCached = embedding.texts;
        await measure("semanticCached", () => manager.prepareSemantic(signal));
        correctness.semanticCachedNoProviderWork = embedding.texts === providerBeforeCached;
        for (const mutation of manifest.mutations) {
          await mutate(mutation);
          const name = `scoped${mutation.kind[0].toUpperCase()}${mutation.kind.slice(1)}`;
          await measure(name, () => manager.reconcileQueuedChanges(signal));
          if (mutation.kind === "modify")
            await measure("semanticPartial", () => manager.prepareSemantic(signal));
        }
        const published = await measure("publish", async () => {
          const result = await publication.publish();
          return { changed: result.published, converged: result.published };
        });
        correctness.publicationCompleted = published.changed === true;
        const bytes = await publication.store.read();
        correctness.publicationBytesPresent = !!bytes && bytes.byteLength > 0;
        if (!bytes) throw new Error("Publication bytes missing.");
        adoptedManager = makeManager();
        const adoptedIndex = adoptedManager;
        await measure("publicationAdopt", async () => {
          await adoptedIndex.load();
          const inspection = await adoptedIndex.inspectPublication(bytes);
          await adoptedIndex.adoptPublication(bytes, inspection.publicationId, inspection);
          return { changed: true, converged: true };
        });
        const state = await adoptedIndex.getState();
        correctness.finalNoteCount = state?.noteCount === manifest.noteCount;
        correctness.finalOccurrenceCount =
          state?.chunkCount === ORACLE_COUNTS[manifest.profile].final;
        correctness.semanticEligibleCount = state?.semanticEligibleCount === manifest.noteCount;
        correctness.semanticHeadCount = state?.semanticHeadCount === manifest.noteCount;
        correctness.compatibleVectorCount =
          state?.compatibleVectorCount === ORACLE_COUNTS[manifest.profile].final;
        correctness.semanticReady = state?.semanticReady === true;
        correctness.semanticConverged =
          state?.semanticLagCount === 0 && state?.semanticMissingCount === 0;
        const query = 'alpha OR beta "quoted" -tag NEAR/3 (unsafe)';
        const expected = expectedOutputsV1ByProfile[manifest.profile];
        const lente = new LenteSearch(
          adoptedIndex,
          { getMtime: (path) => app.vault.getFileByPath(path)?.stat?.mtime ?? null },
          diagnostics
        );
        let lexicalBatch!: Awaited<ReturnType<LenteSearch["search"]>>;
        const lexical = await measure("lexicalRetrieval", async () => {
          lexicalBatch = await lente.search(query, { searchMethod: "keyword" });
          return { changed: lexicalBatch.results.length > 0 };
        });
        let hybridBatch!: Awaited<ReturnType<LenteSearch["search"]>>;
        const hybrid = await measure("hybridRetrieval", async () => {
          hybridBatch = await lente.search(query);
          return { changed: hybridBatch.results.length > 0 };
        });
        let relatedBatch!: Awaited<ReturnType<RelatedNotes["find"]>>;
        const related = await measure("relatedRetrieval", async () => {
          relatedBatch = await new RelatedNotes(adoptedIndex, diagnostics).find(
            "00-special/a.md",
            signal,
            7,
            true
          );
          return { changed: relatedBatch.results.length > 0 };
        });
        correctness.lexicalResultsPresent = lexical.changed === true;
        correctness.hybridResultsPresent = hybrid.changed === true;
        correctness.relatedResultsPresent = related.changed === true;
        const identities = (results: readonly { path: string; ordinal: number }[]) =>
          results.map((result) => ({ path: result.path, occurrenceOrdinal: result.ordinal }));
        correctness.lexicalOracleMatches =
          JSON.stringify(identities(lexicalBatch.results)) ===
          JSON.stringify(expected.probes.lexical);
        correctness.hybridOracleMatches =
          JSON.stringify(identities(hybridBatch.canonicalResults ?? [])) ===
          JSON.stringify(expected.probes.hybrid);
        correctness.relatedOracleMatches =
          JSON.stringify(relatedBatch.results.map((result) => ({ path: result.path }))) ===
          JSON.stringify(expected.probes.filo);
        let voceBatch!: Awaited<ReturnType<VaultSearchTool["execute"]>>;
        await measure("voceRetrieval", async () => {
          voceBatch = await new VaultSearchTool(adoptedIndex).execute({ query }, signal);
          return { changed: voceBatch.provenance.length > 0 };
        });
        correctness.voceOracleMatches =
          JSON.stringify(voceBatch.provenance.map((result) => ({ path: result.path }))) ===
          JSON.stringify(expected.probes.voce);
        let round = 0;
        const chatModel: ChatModel = {
          complete: async () =>
            round++ === 0
              ? {
                  message: {
                    role: "assistant",
                    content: "",
                    toolCalls: [{ id: "search", name: "vault_search", arguments: { query } }],
                  },
                  finishReason: "tool_calls",
                }
              : { message: { role: "assistant", content: "done" }, finishReason: "stop" },
        };
        await measure("chatToolTurn", async () => {
          const result = await new ChatSession(
            chatModel,
            new ToolRegistry([new VaultSearchTool(adoptedIndex)]),
            {
              readNote: async (path) => {
                const file = app.vault.getFileByPath(path);
                if (!file) throw new Error("Benchmark chat note missing.");
                return { path, content: await app.vault.read(file) };
              },
            },
            diagnostics
          ).send({ content: "Find relevant notes", attachmentPaths: [] });
          correctness.chatToolTurnCompleted = result.turns.some(
            (turn) => turn.role === "assistant" && turn.status === "complete"
          );
          return { changed: correctness.chatToolTurnCompleted };
        });
      },
      (record) => aggregatePhase(phases, record)
    );
    if (Object.values(correctness).some((value) => !value))
      throw new Error("Benchmark correctness gate failed.");
  } catch (caught) {
    status = signal.aborted ? "timeout" : "error";
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearTimeout(timeout);
    adoptedManager?.disposeImmediately();
    manager.disposeImmediately();
  }
  const report: BenchmarkReport = {
    version: "trama-obsidian-report-v1",
    status,
    runId: manifest.runId,
    profile: manifest.profile,
    host: "obsidian-desktop",
    appVersion: app.version ?? "unknown",
    pluginVersion,
    buildIdentity: SQLITE_BUILD_IDENTITY,
    runtime: "worker-wasm-opfs",
    storage: "fresh-opfs-identity",
    transport: "browser-worker",
    publication: "in-memory",
    diagnosticsMode: "scoped-performance",
    sourceDigest: manifest.sourceDigest,
    workloadContractVersion: "trama-workload-contract-v1",
    oracleVersion: "expected-outputs-v1",
    providerChallengeSha256: manifest.providerChallengeSha256,
    queryVectorSha256: manifest.queryVectorSha256,
    memory: { rssBytes: "unsupported", heapBytes: "unsupported" },
    boundaries: [
      "publication filesystem adapter excluded",
      "host generation excluded",
      "Obsidian startup excluded",
      "memory unsupported",
    ],
    scenarios,
    phases,
    correctness,
    provider: { calls: embedding.calls, texts: embedding.texts },
    ...(error ? { error } : {}),
  };
  await ensureMarked();
  await adapter.write(BENCHMARK_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  if (status === "completed") {
    // Exactly one terminal event; the host also verifies the report identity.
    // eslint-disable-next-line no-console
    console.info("[Trama] benchmark_completed", { runId: report.runId, report: BENCHMARK_REPORT });
  }
  return report;
}
