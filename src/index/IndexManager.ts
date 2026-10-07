import {
  StructuredError,
  type EmbeddingModel,
  type IndexCapabilities,
  type ProvenanceRecord,
} from "@/domain/contracts";
import { compareCodeUnits, normalizeEmbeddingEndpoint, normalizeVaultPath } from "@/index/Identity";
import {
  CHUNK_ALGORITHM_VERSION,
  CHUNK_OVERLAP,
  CHUNK_SIZE,
  EXTRACTION_VERSION,
  INDEX_SCHEMA_VERSION,
} from "@/index/chunking";
import type { RetrievalResult } from "@/index/retrieval/contracts";
import type { SqliteState } from "@/index/sqlite/protocol";
import { NOOP_TRAMA_DIAGNOSTICS, type TramaDiagnostics } from "@/diagnostics/TramaDiagnostics";
import type { VaultRetrievalPort } from "@/index/VaultSearch";
import type {
  IndexFingerprint,
  IndexJournalSnapshot,
  IndexManagerOptions,
  IndexOperationResult,
  IndexPathMutation,
  IndexSyncResult,
  IndexVaultPort,
  RelatedIndexHit,
  RelatedIndexState,
  SemanticPrepareResult,
} from "./manager/contracts";
import { IndexJournal } from "./manager/journal";
import { LexicalCoordinator } from "./manager/lexical";
import { LexicalSnapshotService } from "./manager/lexical-snapshot";
import { PublicationService } from "./manager/publication";
import { RetrievalService } from "./manager/retrieval";
import { IndexRuntime } from "./manager/runtime";
import { EmbeddingResolver } from "./manager/embedding-resolver";
import { SemanticCoordinator } from "./manager/semantic";

export type {
  IndexFingerprint,
  IndexOperationName,
  IndexOperationResult,
  IndexPathMutation,
  IndexSyncResult,
  IndexVaultDocument,
  IndexVaultPort,
  RelatedIndexHit,
  RelatedIndexState,
  SemanticPrepareResult,
  SnapshotDataAdapter,
} from "./manager/contracts";

export function createIndexFingerprint(
  embeddingBaseUrl: string,
  modelId: string,
  dimensions: number,
  options: {
    readonly size?: number;
    readonly overlap?: number;
    readonly excludedPaths?: readonly string[];
    readonly publicationDirectory?: string;
  } = {}
): IndexFingerprint {
  const excludedPaths = options.excludedPaths ?? [];
  const effectiveExcludedPaths = [
    ...excludedPaths,
    ...(options.publicationDirectory ? [options.publicationDirectory] : []),
  ];
  return {
    embeddingBaseUrl: normalizeEmbeddingEndpoint(embeddingBaseUrl),
    modelId,
    dimensions,
    excludedPaths: Object.freeze(
      [...new Set(excludedPaths.map(normalizeVaultPath))].sort(compareCodeUnits)
    ),
    effectiveExcludedPaths: Object.freeze(
      [...new Set(effectiveExcludedPaths.map(normalizeVaultPath))].sort(compareCodeUnits)
    ),
    chunking: {
      algorithmVersion: CHUNK_ALGORITHM_VERSION,
      size: options.size ?? CHUNK_SIZE,
      overlap: options.overlap ?? CHUNK_OVERLAP,
    },
    extractionVersion: EXTRACTION_VERSION,
    schemaVersion: INDEX_SCHEMA_VERSION,
  };
}

export class IndexManager implements VaultRetrievalPort {
  private readonly fingerprintValue: IndexFingerprint;
  private readonly runtime: IndexRuntime;
  private readonly journal = new IndexJournal();
  private readonly lexical: LexicalCoordinator;
  private readonly semantic: SemanticCoordinator;
  private readonly publication: PublicationService;
  private readonly retrieval: RetrievalService;

  constructor(
    vault: IndexVaultPort,
    private readonly embedding: EmbeddingModel,
    embeddingBaseUrl: string,
    modelId: string,
    private readonly options: IndexManagerOptions = {},
    diagnostics: TramaDiagnostics = NOOP_TRAMA_DIAGNOSTICS
  ) {
    this.fingerprintValue = createIndexFingerprint(
      embeddingBaseUrl,
      modelId,
      this.embedding.dimensions,
      this.options
    );
    this.runtime = new IndexRuntime(vault, this.fingerprintValue, this.options, diagnostics);
    const snapshots = new LexicalSnapshotService(this.runtime, this.journal);
    this.lexical = new LexicalCoordinator(this.runtime, this.journal, snapshots);
    const resolver = new EmbeddingResolver(this.runtime, this.embedding);
    this.semantic = new SemanticCoordinator(this.runtime, this.journal, resolver);
    this.publication = new PublicationService(this.runtime);
    this.retrieval = new RetrievalService(this.runtime, resolver);
  }

  configureDiagnostics(): Promise<void> {
    return this.runtime.client?.configureDiagnostics() ?? Promise.resolve();
  }

  /** Temporary, bounded in-memory capture; settings remain unchanged. */
  capturePerformance(
    work: (
      records: readonly import("@/diagnostics/TramaDiagnostics").TramaPerformanceRecord[]
    ) => Promise<void>,
    onRecord?: (record: import("@/diagnostics/TramaDiagnostics").TramaPerformanceRecord) => void
  ): Promise<readonly import("@/diagnostics/TramaDiagnostics").TramaPerformanceRecord[]> {
    if (!this.runtime.diagnostics.capturePerformance)
      return Promise.reject(new Error("Performance capture is unavailable"));
    return this.runtime.diagnostics.capturePerformance(
      () => this.runtime.client?.configureDiagnostics(true) ?? Promise.resolve(),
      work,
      onRecord
    );
  }

  fingerprint(): IndexFingerprint {
    return this.fingerprintValue;
  }
  isBuilding(): boolean {
    return this.runtime.building;
  }
  isInMaintenance(): boolean {
    return this.runtime.isInMaintenance();
  }
  isComplete(): boolean {
    return this.runtime.state?.incomplete === false;
  }
  capabilities(): IndexCapabilities {
    return this.runtime.capabilities();
  }
  hasUsableIndex(): boolean {
    return this.runtime.hasUsableIndex();
  }
  async getState(): Promise<SqliteState | undefined> {
    if (!this.runtime.loaded) await this.load();
    return this.runtime.state;
  }
  load(options: { readonly emitDiagnostics?: boolean } = {}): Promise<boolean> {
    return this.runtime.load(options.emitDiagnostics === true);
  }
  build(signal: AbortSignal): Promise<IndexOperationResult> {
    return this.lexical.build(signal);
  }
  waitForBuild(): Promise<void> {
    return this.lexical.waitForBuild();
  }
  synchronize(signal: AbortSignal): Promise<IndexSyncResult> {
    return this.lexical.synchronize(signal);
  }
  reconcileChanges(
    changes: readonly IndexPathMutation[],
    signal: AbortSignal
  ): Promise<IndexSyncResult> {
    return this.lexical.reconcileChanges(changes, signal);
  }
  recordPathMutation(mutation: IndexPathMutation): void {
    this.journal.record(mutation);
    this.runtime.freshness = "unknown";
  }
  requestFullRecovery(): void {
    this.journal.requestFullRecovery();
    this.runtime.freshness = "unknown";
  }
  async resetLocalDatabase(): Promise<SqliteState> {
    if (!this.runtime.client)
      throw new StructuredError("unavailable", "SQLite index is unavailable.", true);
    const state = (await this.runtime.client.call("resetLocalDatabase", {})) as SqliteState;
    this.runtime.setState(state);
    this.runtime.freshness = "unknown";
    this.runtime.unavailable = false;
    this.runtime.loaded = true;
    this.runtime.loadError = undefined;
    this.runtime.loadPromise = Promise.resolve(true);
    return state;
  }
  hasPendingWork(): boolean {
    return this.journal.hasPendingWork(this.runtime.state);
  }
  journalSnapshot(): IndexJournalSnapshot {
    return this.journal.snapshot();
  }
  pendingChangeCount(): number {
    return this.journal.changes.length;
  }
  clearJournalIfCurrent(revision: number): void {
    this.journal.clearIfCurrent(revision);
  }
  reconcileQueuedChanges(signal: AbortSignal): Promise<IndexSyncResult> {
    return this.lexical.reconcileQueuedChanges(signal);
  }
  prepareSemantic(
    signal: AbortSignal,
    shouldYield?: () => boolean
  ): Promise<SemanticPrepareResult> {
    return this.semantic.prepareSemantic(signal, shouldYield);
  }
  hasCompatibleSemanticVectors(): boolean {
    return this.semantic.hasCompatibleSemanticVectors();
  }
  hasPendingSemanticWork(): boolean {
    return this.semantic.hasPendingSemanticWork();
  }
  rebuildSemantic(
    signal: AbortSignal,
    shouldYield?: () => boolean
  ): Promise<SemanticPrepareResult> {
    return this.semantic.rebuildSemantic(signal, shouldYield);
  }
  prepareSemanticCacheBatch(signal: AbortSignal): Promise<SemanticPrepareResult> {
    return this.semantic.prepareSemanticCacheBatch(signal);
  }
  promoteCachedSemantic(signal: AbortSignal): Promise<SemanticPrepareResult> {
    return this.semantic.promoteCachedSemantic(signal);
  }
  prepareCacheShard(
    afterActionKey?: string,
    taskKind: "document" | "query" = "document",
    profile?: string,
    sourceDigests?: readonly string[],
    presentDigests?: readonly string[],
    maxPayloadBytes?: number,
    now?: number
  ) {
    return this.publication.prepareCacheShard(
      afterActionKey,
      taskKind,
      profile,
      sourceDigests,
      presentDigests,
      maxPayloadBytes,
      now
    );
  }
  listCacheReceipts(digests: readonly string[]) {
    return this.publication.listCacheReceipts(digests);
  }
  ingestCacheShard(bytes: ArrayBuffer, digest: string) {
    return this.publication.ingestCacheShard(bytes, digest);
  }
  maintainCache(now: number) {
    return this.publication.maintainCache(now);
  }
  recordCacheShard(
    digest: string,
    profile: string,
    taskKind: "document" | "query",
    actionKeys: readonly string[]
  ) {
    return this.publication.recordCacheShard(digest, profile, taskKind, actionKeys);
  }
  recordCacheRetirements(
    sourceDigests: readonly string[],
    replacementDigests: readonly string[],
    now: number
  ) {
    return this.publication.recordCacheRetirements(sourceDigests, replacementDigests, now);
  }
  listCacheRetirements() {
    return this.publication.listCacheRetirements();
  }
  completeCacheRetirement(sourceDigest: string, now: number) {
    return this.publication.completeCacheRetirement(sourceDigest, now);
  }
  search(
    query: string,
    signal: AbortSignal,
    limit: number,
    mode: "lexical" | "hybrid" = "hybrid"
  ): Promise<readonly ProvenanceRecord[]> {
    return this.retrieval.search(query, signal, limit, mode);
  }
  vaultSearchState(): ReturnType<RetrievalService["vaultSearchState"]> {
    return this.retrieval.vaultSearchState();
  }
  retrieveVaultCandidates(
    query: string,
    mode: "hybrid" | "lexical",
    signal?: AbortSignal
  ): Promise<readonly RetrievalResult[]> {
    return this.retrieval.retrieveVaultCandidates(query, mode, signal);
  }
  relatedState(path: string): RelatedIndexState | null {
    return this.retrieval.relatedState(path);
  }
  findRelated(
    path: string,
    signal: AbortSignal,
    limit: number
  ): Promise<readonly RelatedIndexHit[]> {
    return this.retrieval.findRelated(path, signal, limit);
  }
  isIndexEligible(path: string): boolean {
    return this.runtime.isIndexEligible(path);
  }
  invalidate(): void {
    this.runtime.unavailable = true;
    this.runtime.state = undefined;
  }
  async dispose(): Promise<void> {
    this.runtime.terminallyDisposed = true;
    this.runtime.unavailable = true;
    await this.runtime.client?.shutdown().catch(() => undefined);
    this.runtime.client = undefined;
  }
  disposeImmediately(): void {
    this.runtime.terminallyDisposed = true;
    this.runtime.unavailable = true;
    this.runtime.client?.terminateNow();
    this.runtime.client = undefined;
  }
}
