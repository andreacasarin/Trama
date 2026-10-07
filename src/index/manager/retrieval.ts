import {
  StructuredError,
  type IndexCapabilities,
  type IndexFreshness,
  type ProvenanceRecord,
} from "@/domain/contracts";
import { diagnosticsEnabled, projectDiagnosticError } from "@/diagnostics/TramaDiagnostics";
import { indexIdentity, normalizeVaultPath as normalizePath } from "@/index/Identity";
import { searchVault, type VaultRetrievalPort } from "@/index/VaultSearch";
import type { SqliteHit } from "@/index/sqlite/protocol";
import type { RetrievalResult } from "@/index/retrieval/contracts";
import { QueryEmbeddingError } from "@/index/retrieval/QueryEmbeddingError";
import type { RelatedIndexHit, RelatedIndexState } from "./contracts";
import { EmbeddingResolver } from "./embedding-resolver";
import { check, IndexRuntime } from "./runtime";

export class RetrievalService implements VaultRetrievalPort {
  constructor(
    private readonly runtime: IndexRuntime,
    private readonly embedding: EmbeddingResolver
  ) {}
  async search(
    query: string,
    signal: AbortSignal,
    limit: number,
    mode: "lexical" | "hybrid" = "hybrid"
  ): Promise<readonly ProvenanceRecord[]> {
    const batch = await searchVault(this, query, {
      signal,
      searchMethod: mode === "lexical" ? "keyword" : "hybrid",
    });
    return batch.hits.slice(0, Math.min(20, Math.max(0, limit))).map((hit) => ({
      path: hit.path,
      startLine: hit.startLine,
      endLine: hit.endLine,
      excerpt: hit.excerpt,
      score: hit.fusedScore,
    }));
  }
  vaultSearchState(): {
    readonly changeCounter: number;
    readonly generationId: string;
    readonly semantic: IndexCapabilities["semantic"];
    readonly freshness: IndexFreshness;
  } | null {
    if (!this.runtime.hasUsableIndex()) return null;
    const changeCounter = this.runtime.changeCounter();
    const capabilities = this.runtime.capabilities();
    return {
      changeCounter,
      generationId: indexIdentity(changeCounter),
      semantic: capabilities.semantic,
      freshness: this.runtime.freshness,
    };
  }
  retrieveVaultCandidates(
    query: string,
    mode: "hybrid" | "lexical",
    signal?: AbortSignal
  ): Promise<readonly RetrievalResult[]> {
    return this.retrieve(query, mode, signal, 160, undefined, undefined, "lente");
  }
  private async retrieve(
    query: string,
    mode: "hybrid" | "lexical" | "semantic" | "related",
    signal: AbortSignal | undefined,
    limit: number,
    currentPath?: string,
    vector?: readonly number[],
    lexicalProfile: "voce" | "lente" = "voce"
  ): Promise<readonly RetrievalResult[]> {
    const started = diagnosticsEnabled(this.runtime.diagnostics, "detailed")
      ? Date.now()
      : undefined;
    const overallTimer = this.runtime.performanceTimer();
    let retrievalOperationId: string | undefined;
    const requestSignal = signal ?? new AbortController().signal;
    try {
      check(requestSignal);
      if (this.runtime.isInMaintenance())
        throw new StructuredError("busy", "Index maintenance is in progress.", true);
      if (!this.runtime.hasUsableIndex())
        throw new StructuredError("unavailable", "Lexical index is unavailable.", true);
      if (overallTimer) retrievalOperationId = this.runtime.ensureClient().diagnosticOperationId();
      let effectiveMode = mode;
      const semanticReady = this.runtime.capabilities().semantic.searchable;
      if (mode === "hybrid" && !semanticReady) effectiveMode = "lexical";
      if ((mode === "semantic" || mode === "related") && !semanticReady)
        throw new StructuredError(
          "unavailable",
          "Semantic vectors are not ready. Update the semantic index first.",
          true
        );
      let queryVector: Float32Array | undefined = vector ? new Float32Array(vector) : undefined;
      const queryProfile = this.runtime.state?.embeddingFingerprint;
      if (effectiveMode !== "lexical" && !queryVector) {
        const embeddingTimer = this.runtime.performanceTimer();
        queryVector = await this.embedding.resolveQuery(query, requestSignal);
        this.runtime.emitPhase(
          "retrieve",
          "queryEmbedding",
          embeddingTimer,
          1,
          undefined,
          retrievalOperationId
        );
      }
      if (effectiveMode !== "lexical" && this.runtime.state?.embeddingFingerprint !== queryProfile)
        throw new QueryEmbeddingError();
      const candidateLimit = mode === "related" ? 128 : 80;
      const resultLimit = Math.max(0, Math.min(256, Math.floor(limit)));
      const retrievalTimer = this.runtime.performanceTimer();
      const retrievalClient = this.runtime.ensureClient();
      const hits = (await retrievalClient.call(
        "retrieve",
        {
          ...(effectiveMode === "semantic" ? {} : { query }),
          ...(queryVector ? { vector: queryVector } : {}),
          ...(queryVector && queryProfile ? { expectedEmbeddingFingerprint: queryProfile } : {}),
          limit: resultLimit,
          semanticCandidateLimit: candidateLimit,
          lexicalCandidateLimit: candidateLimit,
          lexicalProfile,
          ...(lexicalProfile === "lente" ? { resultShape: "notes" as const } : {}),
          ...(currentPath ? { currentPath } : {}),
        },
        requestSignal,
        { diagnosticOperationId: retrievalOperationId }
      )) as readonly SqliteHit[];
      this.runtime.emitPhase(
        mode === "related" ? "related" : "retrieve",
        effectiveMode,
        retrievalTimer,
        hits.length,
        undefined,
        retrievalOperationId
      );
      const changeCounter = this.runtime.changeCounter();
      if (diagnosticsEnabled(this.runtime.diagnostics, "detailed"))
        this.runtime.emit({
          area: "index",
          event: "index_operation",
          operation: "search",
          stage: "completed",
          phase: mode,
          durationMs: started === undefined ? 0 : Date.now() - started,
          generation: indexIdentity(changeCounter),
          counts: { results: hits.length },
        });
      const shapingTimer = this.runtime.performanceTimer();
      const shaped = hits.map((hit) => ({
        path: hit.path,
        startLine: hit.startLine,
        endLine: hit.endLine,
        excerpt: hit.text,
        generationId: indexIdentity(changeCounter),
        changeCounter,
        chunkId: hit.id,
        ordinal: hit.ordinal,
        ...(hit.semanticScore === undefined ? {} : { semanticScore: hit.semanticScore }),
        ...(hit.lexicalScore === undefined ? {} : { lexicalScore: hit.lexicalScore }),
        fusedScore: hit.fusedScore ?? hit.score,
      }));
      this.runtime.emitPhase(
        "retrieve",
        "resultShaping",
        shapingTimer,
        shaped.length,
        undefined,
        retrievalOperationId
      );
      this.runtime.emitPhase(
        mode === "related" ? "related" : "retrieve",
        "overall",
        overallTimer,
        shaped.length,
        undefined,
        retrievalOperationId
      );
      return shaped;
    } catch (error) {
      if (diagnosticsEnabled(this.runtime.diagnostics, "detailed"))
        this.runtime.emit({
          area: "index",
          event: "index_operation",
          operation: "search",
          stage: requestSignal.aborted ? "cancelled" : "failed",
          phase: mode,
          durationMs: started === undefined ? 0 : Date.now() - started,
          error: projectDiagnosticError(error),
        });
      throw error;
    }
  }
  relatedState(path: string): RelatedIndexState | null {
    const currentPath = normalizePath(path);
    if (
      !this.runtime.hasUsableIndex() ||
      !this.runtime.capabilities().semantic.searchable ||
      !this.runtime.isIndexEligible(currentPath)
    )
      return null;
    const counter = this.runtime.changeCounter();
    const identity = indexIdentity(counter);
    return {
      changeCounter: counter,
      generationId: identity,
      currentPath,
      contentHash: identity,
      semantic: this.runtime.capabilities().semantic,
      freshness: this.runtime.freshness,
    };
  }
  async findRelated(
    path: string,
    signal: AbortSignal,
    limit: number
  ): Promise<readonly RelatedIndexHit[]> {
    check(signal);
    if (!this.runtime.hasUsableIndex() || !this.runtime.capabilities().semantic.searchable)
      throw new StructuredError(
        "unavailable",
        "Semantic vectors are not ready. Update the semantic index first.",
        true
      );
    const timer = this.runtime.performanceTimer();
    const client = this.runtime.ensureClient();
    const operationId = timer ? client.diagnosticOperationId() : undefined;
    const hits = (await client.call(
      "findRelated",
      { path: normalizePath(path), limit: Math.min(128, limit) },
      signal,
      { diagnosticOperationId: operationId }
    )) as readonly SqliteHit[];
    this.runtime.emitPhase("related", "related", timer, hits.length, undefined, operationId);
    return hits.map((hit) => ({
      path: hit.path,
      score: hit.score,
      similarity: hit.score,
      excerpt: hit.text,
      startLine: hit.startLine,
      endLine: hit.endLine,
    }));
  }
}
