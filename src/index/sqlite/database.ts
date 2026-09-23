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
} from "./protocol";
import { SQLITE_BUILD_IDENTITY } from "../../build/identity";
import {
  SqliteContext,
  type SqliteConnection,
  SQLITE_VECTOR_NORMALIZATION_TOLERANCE,
} from "./core";
import { LexicalRunRegistry } from "./lexical-context";
import { SqliteLexicalBatchStore } from "./lexical-batch";
import { SqliteLexicalStagingStore } from "./lexical-staging";
import { SqliteLexicalRunStore } from "./lexical-runs";
import { SqlitePublicationStore } from "./publication";
import { literalTerms, SqliteRetrieval } from "./retrieval";
import { SqliteSemanticStore } from "./semantic";
import { SqliteStateStore } from "./state";

export type { SqliteConnection } from "./core";
export { SQLITE_VECTOR_NORMALIZATION_TOLERANCE, literalTerms };

/** Worker-facing aggregate for one mutable, eventually-consistent SQLite index. */
export class MutableSqliteDatabase {
  private readonly context: SqliteContext;
  private readonly state: SqliteStateStore;
  private readonly publication: SqlitePublicationStore;
  private readonly registry = new LexicalRunRegistry();
  private readonly lexicalBatch: SqliteLexicalBatchStore;
  private readonly lexicalStaging: SqliteLexicalStagingStore;
  private readonly lexicalRuns: SqliteLexicalRunStore;
  private readonly semantic: SqliteSemanticStore;
  private readonly retrieval: SqliteRetrieval;

  constructor(db: SqliteConnection) {
    this.context = new SqliteContext(db);
    this.state = new SqliteStateStore(this.context);
    this.publication = new SqlitePublicationStore(this.context, this.state);
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
    this.semantic = new SqliteSemanticStore(this.context, this.state);
    this.retrieval = new SqliteRetrieval(this.context);
  }

  hasActiveLexicalRuns(): boolean {
    return this.registry.runs.size > 0;
  }

  boot(
    corpusFingerprint: string,
    dimensions: number,
    embeddingFingerprint = "",
    buildIdentity: string = SQLITE_BUILD_IDENTITY
  ): SqliteState {
    return this.state.boot(corpusFingerprint, dimensions, embeddingFingerprint, buildIdentity);
  }

  getState(): SqliteState {
    return this.state.getState();
  }

  getCorpusFingerprint(): string {
    return this.state.getCorpusFingerprint();
  }

  validatePointerOwnership(): void {
    this.publication.validatePointerOwnership();
  }

  pruneForPublication(): void {
    this.publication.pruneForPublication();
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
    } = {}
  ): readonly SqliteHit[] {
    return this.retrieval.retrieve(query, vector, limit, currentPath, options);
  }

  findRelated(path: string, vector: Float32Array | undefined, limit: number): readonly SqliteHit[] {
    return this.retrieval.findRelated(path, vector, limit);
  }

  validateSnapshot(
    corpusFingerprint: string,
    dimensions: number,
    embeddingFingerprint = this.context.embeddingFingerprint,
    buildIdentity: string = SQLITE_BUILD_IDENTITY
  ): void {
    this.publication.validateSnapshot(
      corpusFingerprint,
      dimensions,
      embeddingFingerprint,
      buildIdentity
    );
  }

  finalizePublication(
    publicationId: string,
    expectedChangeCounter: number,
    expectedLexicalGeneration?: number,
    expectedSemanticGeneration?: number
  ): SqliteState | undefined {
    return this.publication.finalizePublication(
      publicationId,
      expectedChangeCounter,
      expectedLexicalGeneration,
      expectedSemanticGeneration
    );
  }

  setPublicationId(publicationId: string): SqliteState {
    return this.publication.setPublicationId(publicationId);
  }

  markSnapshotLoaded(): SqliteState {
    return this.publication.markSnapshotLoaded();
  }

  close(): void {
    if (this.context.closed) return;
    this.context.closed = true;
    this.registry.runs.clear();
    this.context.db.close();
  }
}
