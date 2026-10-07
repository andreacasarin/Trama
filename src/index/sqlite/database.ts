import {
  type SqliteEmbeddingResult,
  type SqliteHit,
  type SqliteLexicalBatchResult,
  type SqliteLexicalRevisionInput,
  type SqliteLexicalRunResult,
  type SqliteLexicalScope,
  type SqliteLexicalSummary,
  type SqliteMutationReceipt,
  type SqliteNoteSummary,
  type SqliteSemanticCommitResult,
  type SqliteSemanticWorkBatch,
  type SqliteState,
  sqliteError,
} from "./protocol";
import { SQLITE_BUILD_IDENTITY } from "../../build/identity";
import {
  SqliteContext,
  rows,
  transaction,
  normalizedVector,
  vectorBytes,
  vectorOf,
  type SqliteConnection,
  SQLITE_VECTOR_NORMALIZATION_TOLERANCE,
} from "./core";
import { LexicalRunRegistry } from "./lexical-context";
import { SqliteLexicalBatchStore } from "./lexical-batch";
import { SqliteLexicalStagingStore } from "./lexical-staging";
import { SqliteLexicalRunStore } from "./lexical-runs";
import { literalTerms, SqliteRetrieval } from "./retrieval";
import { SqliteSemanticStore } from "./semantic";
import {
  diagnosticsEnabled,
  NOOP_TRAMA_DIAGNOSTICS,
  type TramaDiagnostics,
} from "@/diagnostics/TramaDiagnostics";
import { SqliteStateStore } from "./state";
import { ingestCacheShard, prepareCacheShard, type CacheShardPool } from "./cache-shards";
import { createEmbeddingActionKey, EMBEDDING_ACTION_OPTIONS, sha256Hex } from "@/index/Identity";

export type { SqliteConnection } from "./core";
export { SQLITE_VECTOR_NORMALIZATION_TOLERANCE, literalTerms };

/** Worker-facing aggregate for one mutable, eventually-consistent SQLite index. */
export class MutableSqliteDatabase {
  private readonly context: SqliteContext;
  private readonly state: SqliteStateStore;
  private readonly registry = new LexicalRunRegistry();
  private readonly lexicalBatch: SqliteLexicalBatchStore;
  private readonly lexicalStaging: SqliteLexicalStagingStore;
  private readonly lexicalRuns: SqliteLexicalRunStore;
  private readonly semantic: SqliteSemanticStore;
  private readonly retrieval: SqliteRetrieval;

  constructor(
    db: SqliteConnection,
    diagnostics: TramaDiagnostics = NOOP_TRAMA_DIAGNOSTICS,
    retrievalPhaseObserver?: (
      phase:
        | "semanticCandidates"
        | "lexicalCandidates"
        | "fusion"
        | "centroid"
        | "relatedCandidates"
        | "relatedRerank",
      durationMs: number,
      itemCount: number
    ) => void
  ) {
    this.context = new SqliteContext(db);
    this.state = new SqliteStateStore(this.context);
    this.lexicalBatch = new SqliteLexicalBatchStore(this.context, this.registry);
    this.lexicalStaging = new SqliteLexicalStagingStore(
      this.context,
      this.registry,
      this.lexicalBatch,
      this.state
    );
    this.lexicalRuns = new SqliteLexicalRunStore(
      this.context,
      this.registry,
      this.lexicalBatch,
      this.lexicalStaging,
      this.state
    );
    this.semantic = new SqliteSemanticStore(this.context, this.state, diagnostics);
    this.retrieval = new SqliteRetrieval(this.context, retrievalPhaseObserver, () =>
      diagnosticsEnabled(diagnostics, "performance")
    );
  }

  hasActiveLexicalRuns(): boolean {
    return this.registry.runs.size > 0;
  }

  boot(
    corpusFingerprint: string,
    dimensions: number,
    embeddingFingerprint = "",
    buildIdentity: string = SQLITE_BUILD_IDENTITY,
    profileMetadata: { readonly modelId?: string; readonly endpointOrigin?: string } = {}
  ): SqliteState {
    return this.state.boot(
      corpusFingerprint,
      dimensions,
      embeddingFingerprint,
      buildIdentity,
      profileMetadata
    );
  }

  getState(): SqliteState {
    return this.state.getState();
  }

  async lookupQueryVector(query: string, fingerprint: string): Promise<Float32Array | undefined> {
    this.context.ensureOpen();
    const digest = await sha256Hex(query);
    const actionKey = createEmbeddingActionKey(digest, fingerprint, "normalized-float32-v1", {
      ...EMBEDDING_ACTION_OPTIONS,
      taskKind: "query",
    });
    const now = Date.now();
    transaction(this.context.db, () => {
      this.context.db.exec({
        sql: `DELETE FROM embedding_cache WHERE task_kind='query' AND cache_id IN (
          SELECT cache_id FROM (SELECT cache_id,created_at,action_key,embedding_fingerprint,
            ROW_NUMBER() OVER(PARTITION BY embedding_fingerprint ORDER BY created_at DESC,action_key COLLATE BINARY ASC) AS position
            FROM embedding_cache WHERE task_kind='query') WHERE created_at<? OR position>1000)`,
        bind: [now - 30 * 24 * 60 * 60 * 1000],
      });
    });
    const result = rows(
      this.context.db,
      "SELECT vector FROM embedding_cache WHERE task_kind='query' AND action_key=? AND embedding_fingerprint=? AND input_digest=? AND created_at>=?",
      [actionKey, fingerprint, digest, now - 30 * 24 * 60 * 60 * 1000]
    )[0];
    if (!result) return undefined;
    return vectorOf(result.vector);
  }

  async storeQueryVector(
    query: string,
    fingerprint: string,
    dimensions: number,
    vector: Float32Array
  ): Promise<void> {
    const digest = await sha256Hex(query);
    const actionKey = createEmbeddingActionKey(digest, fingerprint, "normalized-float32-v1", {
      ...EMBEDDING_ACTION_OPTIONS,
      taskKind: "query",
    });
    const normalized = normalizedVector(vector, dimensions);
    const existing = rows(
      this.context.db,
      "SELECT serialized_input FROM embedding_inputs WHERE action_key=?",
      [digest]
    )[0];
    if (existing && String(existing.serialized_input) !== query)
      throw sqliteError("integrity_failed", "Query digest conflicts with cached input");
    const now = Date.now();
    transaction(this.context.db, () => {
      this.context.db.exec({
        sql: "INSERT INTO embedding_inputs(embedding_fingerprint,serialized_input,preprocessing,action_key) VALUES(?,?,?,?) ON CONFLICT(action_key) DO NOTHING",
        bind: [fingerprint, query, "normalized-float32-v1", digest],
      });
      this.context.db.exec({
        sql: "INSERT INTO embedding_cache(input_digest,action_key,embedding_fingerprint,preprocessing,vector,task_kind,created_at) VALUES(?,?,?,?,?,'query',?) ON CONFLICT(action_key) DO NOTHING",
        bind: [
          digest,
          actionKey,
          fingerprint,
          "normalized-float32-v1",
          vectorBytes(normalized),
          now,
        ],
      });
      const expiresBefore = now - 30 * 24 * 60 * 60 * 1000;
      const cleanupNeeded = rows(
        this.context.db,
        `SELECT 1 WHERE EXISTS (
          SELECT 1 FROM embedding_cache WHERE task_kind='query' AND created_at<?
        ) OR EXISTS (
          SELECT 1 FROM embedding_cache WHERE task_kind='query'
          GROUP BY embedding_fingerprint HAVING COUNT(*)>1000 LIMIT 1
        )`,
        [expiresBefore]
      )[0];
      if (cleanupNeeded)
        this.context.db.exec({
          sql: `DELETE FROM embedding_cache WHERE task_kind='query' AND cache_id IN (
            SELECT cache_id FROM (SELECT cache_id,created_at,action_key,embedding_fingerprint,
              ROW_NUMBER() OVER(PARTITION BY embedding_fingerprint ORDER BY created_at DESC,action_key COLLATE BINARY ASC) AS position
              FROM embedding_cache WHERE task_kind='query') WHERE created_at<? OR position>1000)`,
          bind: [expiresBefore],
        });
    });
  }

  selectEmbeddingProfile(fingerprint: string): SqliteState {
    return this.state.selectEmbeddingProfile(fingerprint);
  }

  getCorpusFingerprint(): string {
    return this.state.getCorpusFingerprint();
  }

  prepareCacheShard(
    pool: CacheShardPool,
    afterActionKey?: string,
    taskKind: "document" | "query" = "document",
    profile = this.context.embeddingFingerprint,
    sourceDigests?: readonly string[],
    presentDigests?: readonly string[],
    maxPayloadBytes?: number,
    now = Date.now()
  ) {
    const storedDimensions = Number(
      rows(this.context.db, "SELECT dimensions FROM embedding_profiles WHERE fingerprint=?", [
        profile,
      ])[0]?.dimensions ?? 0
    );
    return prepareCacheShard(
      this.context.db,
      pool,
      profile,
      storedDimensions || this.context.dimensions,
      afterActionKey,
      taskKind,
      sourceDigests,
      presentDigests,
      maxPayloadBytes,
      now
    );
  }

  listCacheReceipts(digests: readonly string[]): { digest: string; profile: string }[] {
    if (!digests.length) return [];
    return rows(
      this.context.db,
      `SELECT digest,profile FROM cache_artifact_receipts
      WHERE digest IN (${digests.map(() => "?").join(",")})`,
      digests
    ).map((row) => ({ digest: String(row.digest), profile: String(row.profile) }));
  }

  ingestCacheShard(pool: CacheShardPool, bytes: ArrayBuffer, digest: string) {
    return ingestCacheShard(
      this.context.db,
      pool,
      bytes,
      digest,
      this.context.dimensions,
      this.context.embeddingFingerprint
    ).then((result) => {
      if (!result.duplicate && !result.ignored) this.state.reconcileImportedEmbeddingProfiles();
      return result;
    });
  }

  maintainCache(now: number): {
    expiredRows: number;
    unusedRows: number;
    expiredSourceDigests: string[];
    lastCompactionAt: number;
  } {
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    let expiredRows = 0;
    let unusedRows = 0;
    let expiredSourceDigests: string[] = [];
    transaction(this.context.db, () => {
      expiredSourceDigests = rows(
        this.context.db,
        `SELECT DISTINCT m.digest FROM cache_shard_membership m
        LEFT JOIN embedding_cache ec ON m.action_key=ec.action_key AND m.task_kind=ec.task_kind
        WHERE ec.cache_id IS NULL OR (ec.task_kind='query' AND (ec.created_at<? OR ec.cache_id IN (
          SELECT cache_id FROM (SELECT cache_id,embedding_fingerprint,
            ROW_NUMBER() OVER(PARTITION BY embedding_fingerprint ORDER BY created_at DESC,action_key COLLATE BINARY ASC) AS position
            FROM embedding_cache WHERE task_kind='query') WHERE position>1000
        ))) OR (ec.task_kind='document' AND ec.unused_since IS NOT NULL AND ec.unused_since<=?)`,
        [cutoff, cutoff]
      ).map((row) => String(row.digest));
      this.context.db.exec({
        sql: `DELETE FROM embedding_cache WHERE task_kind='query' AND cache_id IN (
          SELECT cache_id FROM (
            SELECT cache_id,created_at,action_key,embedding_fingerprint,
              ROW_NUMBER() OVER(PARTITION BY embedding_fingerprint ORDER BY created_at DESC,action_key COLLATE BINARY ASC) AS position
            FROM embedding_cache WHERE task_kind='query'
          ) WHERE created_at<? OR position>1000
        )`,
        bind: [cutoff],
      });
      expiredRows = Number(rows(this.context.db, "SELECT changes() AS count")[0]?.count ?? 0);
      this.context.db.exec(`UPDATE embedding_cache SET unused_since=NULL WHERE task_kind='document'
        AND EXISTS (SELECT 1 FROM chunk_occurrences o JOIN notes n ON n.note_id=o.note_id
          WHERE o.embedding_input_digest=embedding_cache.input_digest
            AND (n.lexical_revision_id=o.revision_id OR n.semantic_revision_id=o.revision_id))`);
      this.context.db.exec({
        sql: `UPDATE embedding_cache SET unused_since=? WHERE task_kind='document' AND unused_since IS NULL
        AND NOT EXISTS (SELECT 1 FROM chunk_occurrences o JOIN notes n ON n.note_id=o.note_id
          WHERE o.embedding_input_digest=embedding_cache.input_digest
            AND (n.lexical_revision_id=o.revision_id OR n.semantic_revision_id=o.revision_id))`,
        bind: [now],
      });
      this.context.db.exec({
        sql: "DELETE FROM embedding_cache WHERE task_kind='document' AND unused_since<=?",
        bind: [cutoff],
      });
      unusedRows = Number(rows(this.context.db, "SELECT changes() AS count")[0]?.count ?? 0);
      this.context.db.exec(`DELETE FROM embedding_inputs WHERE NOT EXISTS (
        SELECT 1 FROM chunk_occurrences o WHERE o.embedding_input_digest=embedding_inputs.action_key
      ) AND NOT EXISTS (SELECT 1 FROM embedding_cache ec WHERE ec.input_digest=embedding_inputs.action_key)`);
    });
    return {
      expiredRows,
      unusedRows,
      expiredSourceDigests,
      lastCompactionAt: Number(
        rows(this.context.db, "SELECT last_completed_at FROM cache_compaction_state WHERE id=1")[0]
          ?.last_completed_at ?? 0
      ),
    };
  }

  async recordCacheRetirements(
    sourceDigests: readonly string[],
    replacements: readonly string[],
    now: number
  ): Promise<void> {
    const orderedSources = sourceDigests.slice().sort();
    const setId = `${now}-${await sha256Hex(orderedSources.join("\n"))}`;
    transaction(this.context.db, () => {
      let recorded = sourceDigests.length === 0;
      for (const digest of sourceDigests) {
        this.context.db.exec({
          sql: "INSERT OR IGNORE INTO cache_compaction_retirements(source_digest,replacement_set_id,retire_after) VALUES(?,?,?)",
          bind: [digest, setId, now + 30 * 24 * 60 * 60 * 1000],
        });
        recorded ||= Number(rows(this.context.db, "SELECT changes() AS count")[0]?.count) > 0;
      }
      if (!recorded) return;
      for (const digest of replacements)
        this.context.db.exec({
          sql: "INSERT OR IGNORE INTO cache_compaction_replacements(replacement_set_id,digest) VALUES(?,?)",
          bind: [setId, digest],
        });
      this.context.db.exec({
        sql: "UPDATE cache_compaction_state SET last_completed_at=? WHERE id=1",
        bind: [now],
      });
    });
  }

  listCacheRetirements(): import("./cache-shards").CacheRetirement[] {
    return rows(
      this.context.db,
      `SELECT source_digest,replacement_set_id,retire_after FROM cache_compaction_retirements
      ORDER BY retire_after,source_digest`
    ).map((row) => ({
      sourceDigest: String(row.source_digest),
      replacementSetId: String(row.replacement_set_id),
      retireAfter: Number(row.retire_after),
      replacements: rows(
        this.context.db,
        "SELECT digest FROM cache_compaction_replacements WHERE replacement_set_id=? ORDER BY digest",
        [row.replacement_set_id]
      ).map((replacement) => String(replacement.digest)),
    }));
  }

  completeCacheRetirement(sourceDigest: string, now: number): void {
    transaction(this.context.db, () => {
      const retirement = rows(
        this.context.db,
        "SELECT replacement_set_id,retire_after FROM cache_compaction_retirements WHERE source_digest=?",
        [sourceDigest]
      )[0];
      if (!retirement || Number(retirement.retire_after) > now)
        throw sqliteError("invalid_request", "Cache shard retirement is not due");
      this.context.db.exec({
        sql: "DELETE FROM cache_shard_membership WHERE digest=?",
        bind: [sourceDigest],
      });
      this.context.db.exec({
        sql: "DELETE FROM cache_artifact_receipts WHERE digest=?",
        bind: [sourceDigest],
      });
      this.context.db.exec({
        sql: "DELETE FROM cache_compaction_retirements WHERE source_digest=?",
        bind: [sourceDigest],
      });
      if (
        retirement &&
        !rows(
          this.context.db,
          "SELECT 1 FROM cache_compaction_retirements WHERE replacement_set_id=?",
          [retirement.replacement_set_id]
        ).length
      )
        this.context.db.exec({
          sql: "DELETE FROM cache_compaction_replacements WHERE replacement_set_id=?",
          bind: [retirement.replacement_set_id],
        });
    });
  }

  recordCacheShard(
    digest: string,
    profile: string,
    taskKind: "document" | "query",
    actionKeys: readonly string[]
  ): void {
    transaction(this.context.db, () => {
      for (const actionKey of actionKeys)
        this.context.db.exec({
          sql: "INSERT OR IGNORE INTO cache_shard_membership(digest,action_key,task_kind,profile) VALUES(?,?,?,?)",
          bind: [digest, actionKey, taskKind, profile],
        });
      this.context.db.exec({
        sql: "INSERT OR IGNORE INTO cache_artifact_receipts(digest,profile,received_at) VALUES(?,?,?)",
        bind: [digest, profile, Date.now()],
      });
    });
  }

  markIncomplete(): SqliteState {
    return this.state.markIncomplete();
  }

  getLexicalRevisionDigest(path: string): string | undefined {
    return this.lexicalRuns.getLexicalRevisionDigest(path);
  }

  beginLexicalRun(
    options: {
      readonly runId?: string;
      readonly summaries?: readonly SqliteNoteSummary[];
      readonly expectedChangeCounter?: number;
      readonly scope?: SqliteLexicalScope;
    } = {}
  ): {
    readonly runId: string;
    readonly state: SqliteState;
    readonly receipt: SqliteMutationReceipt;
  } {
    return this.lexicalRuns.beginLexicalRun(options);
  }

  applyLexicalBatch(
    runId: string,
    inputs: readonly SqliteLexicalRevisionInput[]
  ): SqliteLexicalBatchResult {
    return this.lexicalBatch.applyLexicalBatch(runId, inputs);
  }

  stageLexicalRevision(
    runId: string,
    input: SqliteLexicalRevisionInput,
    signal?: AbortSignal
  ): SqliteLexicalBatchResult {
    return this.lexicalStaging.stageLexicalRevision(runId, input, signal);
  }

  discardLexicalStaging(runId: string): void {
    this.lexicalStaging.discard(runId);
  }

  finishLexicalRun(runId: string): SqliteLexicalRunResult {
    return this.lexicalRuns.finishLexicalRun(runId);
  }

  abortLexicalRun(runId: string): SqliteLexicalRunResult {
    return this.lexicalRuns.abortLexicalRun(runId);
  }

  listLexicalSummaries(): readonly SqliteLexicalSummary[] {
    return this.lexicalRuns.listLexicalSummaries();
  }

  prepareSemanticWork(
    embeddingFingerprint: string,
    preprocessing?: string,
    limit?: number,
    maxInputBytes?: number,
    promoteUnrestricted?: boolean
  ): SqliteSemanticWorkBatch {
    return this.semantic.prepareSemanticWork(
      embeddingFingerprint,
      preprocessing,
      limit,
      maxInputBytes,
      promoteUnrestricted
    );
  }

  commitSemanticResults(
    results: readonly SqliteEmbeddingResult[],
    embeddingFingerprint: string,
    preprocessing?: string
  ): SqliteSemanticCommitResult {
    return this.semantic.commitSemanticResults(results, embeddingFingerprint, preprocessing);
  }

  clearSemanticCache(): SqliteState {
    return this.semantic.clearSemanticCache();
  }

  retrieve(
    query: string | undefined,
    vector: Float32Array | undefined,
    limit: number,
    currentPath?: string,
    options: {
      readonly semanticCandidateLimit?: number;
      readonly lexicalCandidateLimit?: number;
      readonly lexicalProfile?: "voce" | "lente";
      readonly resultShape?: "chunks" | "notes";
      readonly expectedEmbeddingFingerprint?: string;
    } = {}
  ): readonly SqliteHit[] {
    const currentVector =
      (this.context.configuredEmbeddingFingerprint &&
        this.context.configuredEmbeddingFingerprint !== this.context.embeddingFingerprint) ||
      (options.expectedEmbeddingFingerprint &&
        options.expectedEmbeddingFingerprint !== this.context.embeddingFingerprint)
        ? undefined
        : vector;
    return this.retrieval.retrieve(query, currentVector, limit, currentPath, options);
  }

  async findRelated(
    path: string,
    vector: Float32Array | undefined,
    limit: number,
    signal?: AbortSignal
  ): Promise<readonly SqliteHit[]> {
    if (
      this.context.configuredEmbeddingFingerprint &&
      this.context.configuredEmbeddingFingerprint !== this.context.embeddingFingerprint
    )
      return [];
    return this.retrieval.findRelated(path, vector, limit, signal);
  }

  close(): void {
    if (this.context.closed) return;
    this.context.closed = true;
    this.registry.runs.clear();
    this.context.db.close();
  }
}
