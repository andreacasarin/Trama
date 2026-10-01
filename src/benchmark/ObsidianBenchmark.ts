import type { ChatSession } from "@/chat/ChatSession";
import type { TramaPerformanceRecord } from "@/diagnostics/TramaDiagnostics";
import type { IndexManager } from "@/index/IndexManager";
import type { RelatedNotes } from "@/index/RelatedNotes";
import type { PublicationManager } from "@/index/publications/PublicationManager";
import type { LenteSearchPort } from "@/plugin/ModelRuntime";
import type { TramaSettings } from "@/settings/Settings";
import { SQLITE_BUILD_IDENTITY } from "@/build/identity";
import { BENCHMARK_REPORT, readBenchmarkManifest, type BenchmarkManifest } from "./Manifest";
import { expectedOutputsV1ByProfile } from "./Oracle";

const ORACLE_COUNTS = {
  "trama-small": { initial: 128, final: 125 },
  "trama-10k": { initial: 10000, final: 9993 },
  "trama-large": { initial: 25000, final: 24993 },
} as const;

/** References to the already-composed production runtime, not benchmark substitutes. */
export interface BenchmarkRuntime {
  readonly index: IndexManager;
  readonly publication: PublicationManager;
  readonly related: RelatedNotes;
  readonly session: ChatSession;
  getLenteSearch(): LenteSearchPort;
  getSettings(): TramaSettings;
  saveSettings(settings: TramaSettings): Promise<void>;
  rebuild(): Promise<void>;
  update(): Promise<void>;
  publish(): Promise<void>;
  checkPublication(): Promise<void>;
  stop(): Promise<void>;
}

interface PhaseAggregate {
  count: number;
  durationMs: number;
  sqlMs: number;
  sqlCalls: number;
  byteCount: number;
  itemCount: number;
}

export interface BenchmarkReport {
  readonly version: "trama-obsidian-report-v2";
  readonly status: "completed" | "error" | "timeout";
  readonly runId: string;
  readonly profile: BenchmarkManifest["profile"];
  readonly host: "obsidian-desktop";
  readonly appVersion: string;
  readonly pluginVersion: string;
  readonly buildIdentity: string;
  readonly runtime: "standard-trama-worker-wasm-opfs";
  readonly storage: "vault-opfs-identity";
  readonly transport: "browser-worker";
  readonly providerTransport: "loopback-http-fixture";
  readonly publication: "vault-filesystem";
  readonly diagnosticsMode: "performance";
  readonly sourceDigest: string;
  readonly workloadContractVersion: "trama-workload-contract-v1";
  readonly oracleVersion: "expected-outputs-v1";
  readonly providerChallengeSha256: string;
  readonly queryVectorSha256: string;
  readonly memory: { readonly rssBytes: "unsupported"; readonly heapBytes: "unsupported" };
  readonly boundaries: readonly string[];
  readonly scenarios: Readonly<Record<string, { completed: boolean }>>;
  readonly phases: Readonly<Record<string, PhaseAggregate>>;
  readonly correctness: Readonly<Record<string, boolean>>;
  readonly provider: { readonly calls: number; readonly texts: number };
  readonly error?: string;
}

/** Fixed workload driver over normal Trama operations; timing comes from production diagnostics. */
export async function runObsidianBenchmark(
  app: { vault: any; version?: string },
  manifest: BenchmarkManifest,
  pluginVersion: string,
  runtime: BenchmarkRuntime
): Promise<BenchmarkReport> {
  const adapter = app.vault.adapter;
  const ensureMarked = async () => {
    const fresh = await readBenchmarkManifest(adapter, app.vault.getName());
    if (
      !fresh ||
      adapter.getBasePath?.() !== manifest.expectedPath ||
      JSON.stringify(fresh) !== JSON.stringify(manifest)
    )
      throw new Error("Benchmark vault marker changed; refusing mutation.");
  };
  await ensureMarked();
  const settings = runtime.getSettings();
  const endpoint = settings.embedding.endpoint;
  if (
    !/^http:\/\/127\.0\.0\.1:[0-9]+\/v1$/.test(endpoint) ||
    settings.chat.endpoint !== endpoint ||
    settings.embedding.modelId !== `trama-benchmark-fixture-${manifest.runId}` ||
    settings.chat.modelId !== settings.embedding.modelId ||
    settings.embedding.dimensions !== 768 ||
    settings.diagnosticsMode !== "performance" ||
    settings.automaticMaintenance ||
    settings.filo.excludedPaths.length > 0
  )
    throw new Error(
      "Run npm run benchmark to configure the marked vault's fixture provider and Performance logging."
    );
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
  const timeout = setTimeout(() => {
    controller.abort();
    void runtime.stop();
    runtime.session.cancel();
  }, manifest.timeoutMs);
  const signal = controller.signal;
  const phases: Record<string, PhaseAggregate> = {};
  const scenarios: Record<string, { completed: boolean }> = {};
  const correctness: Record<string, boolean> = {};
  let provider = { calls: 0, texts: 0 };
  let providerVerified = false;
  const stats = async (requestSignal = signal): Promise<{ calls: number; texts: number }> => {
    const response = await fetch(`${endpoint}/benchmark-stats`, { signal: requestSignal });
    if (!response.ok) throw new Error("Benchmark fixture provider is unavailable.");
    const value = await response.json();
    if (
      value.runId !== manifest.runId ||
      !Number.isSafeInteger(value.calls) ||
      !Number.isSafeInteger(value.texts)
    )
      throw new Error("Benchmark fixture provider identity mismatch.");
    providerVerified = true;
    provider = { calls: value.calls, texts: value.texts };
    return provider;
  };
  const scenario = async (name: string, work: () => Promise<unknown>) => {
    if (signal.aborted) throw new Error("Benchmark timed out.");
    await ensureMarked();
    await work();
    if (signal.aborted) throw new Error("Benchmark timed out.");
    scenarios[name] = { completed: true };
  };
  let status: BenchmarkReport["status"] = "completed";
  let error: string | undefined;
  try {
    await stats();
    await runtime.index.capturePerformance(
      async () => {
        await scenario("fullRebuild", () => runtime.rebuild());
        const initial = await runtime.index.getState();
        correctness.initialNoteCount = initial?.noteCount === manifest.noteCount;
        correctness.initialOccurrenceCount =
          initial?.chunkCount === ORACLE_COUNTS[manifest.profile].initial;
        const beforeCached = await stats();
        await scenario("cachedUpdate", () => runtime.update());
        correctness.semanticCachedNoProviderWork = (await stats()).texts === beforeCached.texts;
        for (const mutation of manifest.mutations) {
          await scenario(
            `scoped${mutation.kind[0].toUpperCase()}${mutation.kind.slice(1)}`,
            async () => {
              if (mutation.kind === "add") {
                await app.vault.createFolder("mutations");
                await app.vault.create(mutation.path, mutation.content);
              } else {
                const file = app.vault.getFileByPath(mutation.path);
                if (!file) throw new Error("Benchmark mutation target missing.");
                if (mutation.kind === "modify") await app.vault.modify(file, mutation.content);
                else if (mutation.kind === "delete") await app.vault.delete(file);
                else await app.vault.rename(file, mutation.to);
              }
              // The normal VaultEventRouter owns the journal; never inject benchmark mutations.
              await runtime.update();
            }
          );
        }
        await scenario("publish", () => runtime.publish());
        const bytes = await runtime.publication.store.read();
        correctness.publicationCompleted = !!bytes;
        correctness.publicationBytesPresent = !!bytes?.byteLength;
        if (!bytes) throw new Error("Publication bytes missing.");
        await scenario("publicationCheck", () => runtime.checkPublication());
        const state = await runtime.index.getState();
        correctness.finalNoteCount = state?.noteCount === manifest.noteCount;
        correctness.finalOccurrenceCount =
          state?.chunkCount === ORACLE_COUNTS[manifest.profile].final;
        correctness.semanticEligibleCount = state?.semanticEligibleCount === manifest.noteCount;
        correctness.semanticHeadCount = state?.semanticHeadCount === manifest.noteCount;
        // Live storage retains reusable entries; convergence/missing-count gates verify current coverage.
        correctness.compatibleVectorCoverage =
          (state?.compatibleVectorCount ?? 0) >= ORACLE_COUNTS[manifest.profile].final;
        correctness.semanticReady = state?.semanticReady === true;
        correctness.semanticConverged =
          state?.semanticLagCount === 0 && state?.semanticMissingCount === 0;
        const query = 'alpha OR beta "quoted" -tag NEAR/3 (unsafe)';
        const expected = expectedOutputsV1ByProfile[manifest.profile];
        const identities = (results: readonly { path: string; ordinal: number }[]) =>
          results.map((result) => ({ path: result.path, occurrenceOrdinal: result.ordinal }));
        await scenario("lexicalRetrieval", async () => {
          await runtime.saveSettings({
            ...runtime.getSettings(),
            lente: { ...settings.lente, searchMethod: "keyword" },
          });
          const batch = await runtime.getLenteSearch().search(query, { signal });
          correctness.lexicalOracleMatches =
            JSON.stringify(identities(batch.results)) === JSON.stringify(expected.probes.lexical);
        });
        await runtime.saveSettings({
          ...runtime.getSettings(),
          lente: { ...settings.lente, searchMethod: "hybrid" },
        });
        await scenario("hybridRetrieval", async () => {
          const batch = await runtime.getLenteSearch().search(query, { signal });
          correctness.hybridOracleMatches =
            JSON.stringify(identities(batch.canonicalResults ?? [])) ===
            JSON.stringify(expected.probes.hybrid);
        });
        await scenario("relatedRetrieval", async () => {
          const batch = await runtime.related.find("00-special/a.md", signal, 7, true);
          correctness.relatedOracleMatches =
            JSON.stringify(batch.results.map(({ path }) => ({ path }))) ===
            JSON.stringify(expected.probes.filo);
        });
        await scenario("chatToolTurn", async () => {
          const result = await runtime.session.send({
            content: "Find relevant notes",
            attachmentPaths: [],
          });
          const answer = result.turns[result.turns.length - 1];
          correctness.chatToolTurnCompleted =
            answer?.role === "assistant" &&
            answer.status === "complete" &&
            answer.content === "done";
          correctness.voceOracleMatches =
            JSON.stringify(
              answer?.role === "assistant"
                ? (answer.provenance?.map(({ path }) => ({ path })) ?? [])
                : []
            ) === JSON.stringify(expected.probes.voce);
        });
        provider = await stats();
      },
      (record: TramaPerformanceRecord) => {
        const key = `${record.operation}.${record.phase}`;
        const value = (phases[key] ??= {
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
    );
    const failed = Object.keys(correctness).filter((gate) => !correctness[gate]);
    if (failed.length) throw new Error(`Benchmark correctness gate failed: ${failed.join(", ")}`);
  } catch (caught) {
    status = signal.aborted ? "timeout" : "error";
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearTimeout(timeout);
    if (status !== "completed" && providerVerified)
      await stats(AbortSignal.timeout(1000)).catch(() => undefined);
    await ensureMarked();
    await runtime.saveSettings({ ...runtime.getSettings(), lente: settings.lente });
  }
  const report: BenchmarkReport = {
    version: "trama-obsidian-report-v2",
    status,
    runId: manifest.runId,
    profile: manifest.profile,
    host: "obsidian-desktop",
    appVersion: app.version ?? "unknown",
    pluginVersion,
    buildIdentity: SQLITE_BUILD_IDENTITY,
    runtime: "standard-trama-worker-wasm-opfs",
    storage: "vault-opfs-identity",
    transport: "browser-worker",
    providerTransport: "loopback-http-fixture",
    publication: "vault-filesystem",
    diagnosticsMode: "performance",
    sourceDigest: manifest.sourceDigest,
    workloadContractVersion: "trama-workload-contract-v1",
    oracleVersion: "expected-outputs-v1",
    providerChallengeSha256: manifest.providerChallengeSha256,
    queryVectorSha256: manifest.queryVectorSha256,
    memory: { rssBytes: "unsupported", heapBytes: "unsupported" },
    boundaries: [
      "publication filesystem adapter included",
      "loopback provider transport included",
      "host generation excluded",
      "Obsidian startup excluded",
      "memory unsupported",
    ],
    scenarios,
    phases,
    correctness,
    provider,
    ...(error ? { error } : {}),
  };
  await ensureMarked();
  await adapter.write(BENCHMARK_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  if (status === "completed") {
    // eslint-disable-next-line no-console
    console.info("[Trama] benchmark_completed", { runId: report.runId, report: BENCHMARK_REPORT });
  }
  return report;
}
