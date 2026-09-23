import {
  StructuredError,
  type EmbeddingModel,
  type IndexCapabilities,
  type IndexFreshness,
  type ProvenanceRecord,
} from "@/domain/contracts";
import { projectDiagnosticError } from "@/diagnostics/TramaDiagnostics";
import { indexIdentity, normalizeVaultPath as normalizePath } from "@/index/Identity";
import { searchVault, type VaultRetrievalPort } from "@/index/VaultSearch";
import type { SqliteHit } from "@/index/sqlite/protocol";
import type { RetrievalResult } from "@/index/retrieval/contracts";
import { QueryEmbeddingError } from "@/index/retrieval/QueryEmbeddingError";
import type { RelatedIndexHit, RelatedIndexState } from "./contracts";
import { check, IndexRuntime } from "./runtime";

export class RetrievalService implements VaultRetrievalPort {
  constructor(
    private readonly runtime: IndexRuntime,
    private readonly embedding: EmbeddingModel
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
    readonly publicationId?: string;
  } | null {
    if (!this.runtime.hasUsableIndex()) return null;
    const changeCounter = this.runtime.changeCounter();
    const state = this.runtime.state!;
    const capabilities = this.runtime.capabilities();
    return {
      changeCounter,
      generationId: indexIdentity(changeCounter),
      semantic: capabilities.semantic,
      freshness: this.runtime.freshness,
      ...(state.publicationId ? { publicationId: state.publicationId } : {}),
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
    const started = Date.now();
    const requestSignal = signal ?? new AbortController().signal;
    try {
      check(requestSignal);
      if (this.runtime.isInMaintenance())
        throw new StructuredError("busy", "Index maintenance is in progress.", true);
      if (!this.runtime.hasUsableIndex())
        throw new StructuredError("unavailable", "Lexical index is unavailable.", true);
      let effectiveMode = mode;
      const semanticReady = this.runtime.capabilities().semantic.searchable;
      if (mode === "hybrid" && !semanticReady) effectiveMode = "lexical";
      if ((mode === "semantic" || mode === "related") && !semanticReady)
        throw new StructuredError(
          "unavailable",
          "Semantic vectors are not ready. Update the semantic index first.",
          true
        );
      let queryVector = vector ? new Float32Array(vector) : undefined;
      if (effectiveMode !== "lexical" && !queryVector) {
        try {
          const values = await this.embedding.embed([query], requestSignal);
          queryVector = new Float32Array(values[0] ?? []);
        } catch {
          if (requestSignal.aborted)
            throw new StructuredError("cancelled", "Search cancelled.", true);
          throw new QueryEmbeddingError();
        }
        if (
          queryVector &&
          (queryVector.length !== this.embedding.dimensions ||
            !queryVector.some((value) => value !== 0))
        ) {
          throw new QueryEmbeddingError();
        }
      }
      const candidateLimit = lexicalProfile === "lente" ? 160 : mode === "related" ? 128 : 80;
      const resultLimit = Math.max(0, Math.min(256, Math.floor(limit)));
      const hits = (await this.runtime.ensureClient().call(
        "retrieve",
        {
          ...(effectiveMode === "semantic" ? {} : { query }),
          ...(queryVector ? { vector: queryVector } : {}),
          limit: resultLimit,
          semanticCandidateLimit: candidateLimit,
          lexicalCandidateLimit: candidateLimit,
          lexicalProfile,
          ...(lexicalProfile === "lente" ? { resultShape: "notes" as const } : {}),
          ...(currentPath ? { currentPath } : {}),
        },
        requestSignal
      )) as readonly SqliteHit[];
      const changeCounter = this.runtime.changeCounter();
      this.runtime.emit({
        area: "index",
        event: "index_operation",
        operation: "search",
        stage: "completed",
        phase: mode,
        durationMs: Date.now() - started,
        generation: indexIdentity(changeCounter),
        counts: { results: hits.length },
      });
      return hits.map((hit) => ({
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
    } catch (error) {
      this.runtime.emit({
        area: "index",
        event: "index_operation",
        operation: "search",
        stage: requestSignal.aborted ? "cancelled" : "failed",
        phase: mode,
        durationMs: Date.now() - started,
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
    const visibleHead = this.runtime.state?.semanticHeadKey || identity;
    return {
      changeCounter: counter,
      generationId: identity,
      currentPath,
      contentHash: visibleHead,
      semantic: this.runtime.capabilities().semantic,
      freshness: this.runtime.freshness,
      ...(this.runtime.state?.publicationId
        ? { publicationId: this.runtime.state.publicationId }
        : {}),
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
    const hits = (await this.runtime
      .ensureClient()
      .call(
        "findRelated",
        { path: normalizePath(path), limit: Math.min(128, limit) },
        signal
      )) as readonly SqliteHit[];
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
