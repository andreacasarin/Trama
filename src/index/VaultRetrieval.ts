import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { RunnableLambda, type RunnableConfig } from "@langchain/core/runnables";
import { StructuredError, checkAbort, isCancelled } from "@/domain/errors";
import { EmbeddingProviderError } from "@/model/LocalModels";
import type { ConsoleDebug } from "@/plugin/ConsoleDebug";
import type {
  NoteStoreCall,
  NoteStoreHybridResult,
  NoteStoreHit,
  NoteStoreRelatedResult,
} from "./note-sqlite/protocol";

export interface VaultRetrievalInput {
  readonly query: string;
  readonly mode: "hybrid" | "lexical";
  readonly limit?: number;
  readonly content?: "full" | "metadata";
}

export interface VaultRetrievalStatus {
  readonly mode: "hybrid" | "lexical";
  readonly degraded: boolean;
  readonly degradationReason?: "semantic-unavailable" | "query-embedding-failed";
}

export interface VaultRetrievalOutput {
  readonly documents: readonly Document[];
  readonly status: VaultRetrievalStatus;
}

export interface VaultSearchCandidates {
  readonly hits: readonly NoteStoreHit[];
  readonly status: VaultRetrievalStatus;
  readonly signal: AbortSignal;
}

export interface LiveMarkdown {
  readonly path: string;
  readonly content: string;
}

export type LiveMarkdownReader = (
  path: string,
  signal?: AbortSignal
) => Promise<LiveMarkdown | null>;

export class VaultRetrieval {
  readonly runnable: RunnableLambda<VaultRetrievalInput, VaultRetrievalOutput, RunnableConfig>;
  private searchController = new AbortController();
  private relatedGeneration = 0;
  private relatedRequest?: {
    readonly sourcePath: string;
    readonly profile: string;
    readonly limit: number;
    readonly generation: number;
    readonly controller: AbortController;
    readonly promise: Promise<NoteStoreRelatedResult>;
  };

  constructor(
    private readonly call: NoteStoreCall,
    private readonly embeddings:
      | (EmbeddingsInterface<number[]> & {
          withSignal?(signal?: AbortSignal): EmbeddingsInterface<number[]>;
        })
      | undefined,
    private readonly profile: string | undefined,
    private readonly readNote: LiveMarkdownReader,
    private readonly consoleDebug?: ConsoleDebug
  ) {
    this.runnable = RunnableLambda.from<VaultRetrievalInput, VaultRetrievalOutput, RunnableConfig>(
      (input, config) => this.search(input, config.signal)
    );
  }

  async related(
    sourcePath: string,
    signal: AbortSignal,
    limit = 20
  ): Promise<{ readonly documents: readonly Document[]; readonly available: boolean }> {
    checkAbort(signal);
    const finish = this.consoleDebug?.start("Filo related-note lookup");
    try {
      const result = await this.relatedHits(sourcePath, signal, limit);
      const documents = result.hits.map(metadataDocument);
      finish?.("completed", { resultCount: documents.length, available: result.available });
      return { documents, available: result.available };
    } catch (error) {
      finish?.(signal.aborted || isCancelled(error) ? "cancelled" : "failed");
      throw error;
    }
  }

  async relatedPaths(
    sourcePath: string,
    signal: AbortSignal,
    limit = 7
  ): Promise<{ readonly paths: readonly string[]; readonly available: boolean }> {
    checkAbort(signal);
    const result = await this.relatedHits(sourcePath, signal, limit);
    return { paths: result.hits.map((hit) => hit.path), available: result.available };
  }

  cancelSearches(): void {
    this.searchController.abort();
    this.searchController = new AbortController();
  }

  async searchCandidates(
    input: VaultRetrievalInput,
    signal?: AbortSignal
  ): Promise<VaultSearchCandidates> {
    signal = signal
      ? AbortSignal.any([signal, this.searchController.signal])
      : this.searchController.signal;
    checkAbort(signal);
    const query = input.query.trim();
    if (
      query.length > 4096 ||
      (input.limit !== undefined &&
        (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000))
    )
      throw new StructuredError(
        "invalid_request",
        "Search query or result limit exceeds its bounds.",
        false
      );
    if (!query)
      throw new StructuredError("invalid_request", "Search query must not be empty.", false);
    if (input.mode !== "hybrid" && input.mode !== "lexical")
      throw new StructuredError("invalid_request", "Search mode is invalid.", false);
    let vector: number[] | undefined;
    let degradationReason: VaultRetrievalStatus["degradationReason"];
    if (input.mode === "hybrid" && this.embeddings && this.profile) {
      try {
        vector = await (this.embeddings.withSignal?.(signal) ?? this.embeddings).embedQuery(query);
      } catch (error) {
        if (signal?.aborted || isCancelled(error)) throw error;
        if (!(error instanceof EmbeddingProviderError)) throw error;
        degradationReason = "query-embedding-failed";
        this.consoleDebug?.warn("Query embedding failed; using lexical search", error);
      }
    } else if (input.mode === "hybrid") {
      degradationReason = "semantic-unavailable";
    }
    checkAbort(signal);
    const result = (await this.call(
      "noteStoreHybrid",
      {
        query,
        ...(vector && this.profile ? { vector, profile: this.profile } : {}),
        k: Math.max(20, input.limit ?? 10),
      },
      signal
    )) as NoteStoreHybridResult;
    checkAbort(signal);
    if (!degradationReason && result.degraded) degradationReason = result.degradationReason;
    const degraded = Boolean(degradationReason) || result.degraded;
    return {
      hits: result.hits,
      status: {
        mode: result.mode,
        degraded,
        ...(degradationReason ? { degradationReason } : {}),
      },
      signal,
    };
  }

  async readSearchCandidate(
    hit: NoteStoreHit,
    signal?: AbortSignal
  ): Promise<Document | undefined> {
    checkAbort(signal);
    const note = await this.readNote(hit.path, signal);
    checkAbort(signal);
    if (!note) return undefined;
    return new Document({
      id: hit.path,
      pageContent: note.content,
      metadata: {
        path: hit.path,
        score: hit.score,
        ...(hit.lexicalScore === undefined ? {} : { lexicalScore: hit.lexicalScore }),
        ...(hit.semanticScore === undefined ? {} : { semanticScore: hit.semanticScore }),
      },
    });
  }

  invalidateRelated(): void {
    this.relatedGeneration++;
    this.relatedRequest?.controller.abort();
    this.relatedRequest = undefined;
  }

  private async relatedHits(
    sourcePath: string,
    signal: AbortSignal,
    limit: number
  ): Promise<NoteStoreRelatedResult> {
    checkAbort(signal);
    if (!this.profile) return { hits: [], available: false };
    const k = Math.max(0, Math.min(20, Math.floor(limit)));
    let request = this.relatedRequest;
    if (
      !request ||
      request.sourcePath !== sourcePath ||
      request.profile !== this.profile ||
      request.limit !== k ||
      request.generation !== this.relatedGeneration
    ) {
      const controller = new AbortController();
      const generation = this.relatedGeneration;
      const finish = this.consoleDebug?.start("Filo related-note lookup");
      const pending = this.call(
        "noteStoreRelated",
        { sourcePath, profile: this.profile, k },
        controller.signal
      ) as Promise<NoteStoreRelatedResult>;
      const promise = pending.then(
        (result) => {
          finish?.("completed", { resultCount: result.hits.length, available: result.available });
          return result;
        },
        (error) => {
          const cancelled = controller.signal.aborted || isCancelled(error);
          finish?.(
            cancelled ? "cancelled" : "failed",
            undefined,
            cancelled ? undefined : error,
            cancelled ? "info" : "error"
          );
          throw error;
        }
      );
      request = {
        sourcePath,
        profile: this.profile,
        limit: k,
        generation,
        controller,
        promise,
      };
      this.relatedRequest = request;
      void promise.catch(() => {
        if (this.relatedRequest === request) this.relatedRequest = undefined;
      });
    }
    return waitForConsumer(request.promise, signal);
  }

  private async search(
    input: VaultRetrievalInput,
    signal?: AbortSignal
  ): Promise<VaultRetrievalOutput> {
    const finish = this.consoleDebug?.start("Vault search", { mode: input.mode });

    try {
      const candidates = await this.searchCandidates(input, signal);
      const documents =
        input.content === "metadata"
          ? candidates.hits.slice(0, input.limit).map(metadataDocument)
          : await this.hydrate(candidates.hits, candidates.signal, input.limit);
      checkAbort(candidates.signal);
      finish?.("completed", {
        resultCount: documents.length,
        degraded: candidates.status.degraded,
      });
      return {
        documents,
        status: candidates.status,
      };
    } catch (error) {
      finish?.(isCancelled(error) ? "cancelled" : "failed");
      throw error;
    }
  }

  private async hydrate(
    hits: readonly {
      readonly path: string;
      readonly score: number;
      readonly lexicalScore?: number;
      readonly semanticScore?: number;
    }[],
    signal?: AbortSignal,
    limit?: number
  ): Promise<Document[]> {
    const documents: Document[] = [];
    for (const hit of hits) {
      if (limit !== undefined && documents.length >= limit) break;
      checkAbort(signal);
      const document = await this.readSearchCandidate(hit, signal);
      if (document) documents.push(document);
    }
    return documents;
  }
}

function waitForConsumer<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function metadataDocument(hit: NoteStoreHit): Document {
  return new Document({ id: hit.path, pageContent: "", metadata: { ...hit } });
}
