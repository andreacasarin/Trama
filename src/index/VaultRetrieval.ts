import type { Callbacks } from "@langchain/core/callbacks/manager";
import { LocalTraceHandler } from "@/plugin/LocalTracing";
import { SqlCandidateRetriever } from "./SqlCandidateRetriever";
import { Document } from "@langchain/core/documents";
import { _HashedDocument } from "@langchain/core/indexing";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { StructuredError, checkAbort, isCancelled } from "@/domain/errors";
import { EmbeddingProviderError } from "@/model/LocalModels";
import type { ConsoleDebug } from "@/plugin/ConsoleDebug";
import { DEFAULT_STORAGE_FOLDER } from "@/settings/StorageFolder";
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
}

export interface VaultRetrievalStatus {
  readonly mode: "hybrid" | "lexical";
  readonly degraded: boolean;
  readonly degradationReason?: "semantic-unavailable" | "query-embedding-failed";
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
    private readonly consoleDebug?: ConsoleDebug,
    private readonly storageFolder = DEFAULT_STORAGE_FOLDER
  ) {}

  async related(
    sourcePath: string,
    signal: AbortSignal,
    limit = 20
  ): Promise<NoteStoreRelatedResult> {
    checkAbort(signal);
    const finish = this.consoleDebug?.start("Filo related-note lookup");
    try {
      const result = await this.relatedHits(sourcePath, signal, limit);
      finish?.("completed", { resultCount: result.hits.length, available: result.available });
      return result;
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
    signal?: AbortSignal,
    evidence = false,
    callbacks?: Callbacks
  ): Promise<VaultSearchCandidates> {
    signal = signal
      ? AbortSignal.any([signal, this.searchController.signal])
      : this.searchController.signal;
    let batch: VaultSearchCandidates | undefined;
    const retriever = new SqlCandidateRetriever(async () => {
      batch = await this.searchCandidatesSql(input, signal, evidence);
      return batch;
    });
    const documents = await retriever.invoke(input.query, {
      callbacks: callbacks ?? [new LocalTraceHandler(this.consoleDebug, signal)],
      runName: "SQL candidate retrieval",
    });
    return { ...batch!, hits: documents.map((document) => document.metadata.hit as NoteStoreHit) };
  }

  private async searchCandidatesSql(
    input: VaultRetrievalInput,
    signal: AbortSignal,
    evidence = false
  ): Promise<VaultSearchCandidates> {
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
        ...(evidence ? { evidence: true } : {}),
      },
      signal
    )) as NoteStoreHybridResult;
    checkAbort(signal);
    if (!degradationReason && result.degraded) degradationReason = result.degradationReason;
    const degraded = Boolean(degradationReason) || result.degraded;
    return {
      hits: result.hits.filter((hit) => !this.isStoragePath(hit.path)),
      status: {
        mode: result.mode,
        degraded,
        ...(degradationReason ? { degradationReason } : {}),
      },
      signal,
    };
  }

  private async verifiedEvidenceSource(
    hit: NoteStoreHit,
    signal?: AbortSignal
  ): Promise<LiveMarkdown | null> {
    if (!hit.evidence?.profile || this.isStoragePath(hit.path)) return null;
    const note = await this.readNote(hit.path, signal);
    checkAbort(signal);
    if (!note || note.path !== hit.path) return null;
    const uid = _HashedDocument.fromDocument(
      new Document({
        pageContent: note.content,
        metadata: { path: hit.path, embeddingProfile: hit.evidence.profile },
      })
    ).uid;
    if (uid !== hit.evidence.uid) return null;
    const exists = (await this.call("recordManagerExists", { keys: [uid] }, signal)) as boolean[];
    checkAbort(signal);
    return exists[0] ? note : null;
  }

  async searchEvidence(hit: NoteStoreHit, signal?: AbortSignal) {
    const note = await this.verifiedEvidenceSource(hit, signal);
    if (!note || !hit.evidence) return { kind: "changed" as const };
    const { startOffset, endOffset, sectionPath } = hit.evidence;
    if (
      startOffset === undefined ||
      endOffset === undefined ||
      startOffset < 0 ||
      endOffset > note.content.length ||
      endOffset <= startOffset
    )
      return { kind: "unavailable" as const };
    return {
      kind: "passage" as const,
      text: note.content.slice(startOffset, endOffset),
      sectionPath,
    };
  }

  async readSearchCandidate(
    hit: NoteStoreHit,
    signal?: AbortSignal
  ): Promise<Document | undefined> {
    checkAbort(signal);
    if (this.isStoragePath(hit.path)) return undefined;
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
    if (this.isStoragePath(sourcePath)) return { hits: [], available: false };
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
    const result = await waitForConsumer(request.promise, signal);
    return { ...result, hits: result.hits.filter((hit) => !this.isStoragePath(hit.path)) };
  }

  private isStoragePath(path: string): boolean {
    return path === this.storageFolder || path.startsWith(`${this.storageFolder}/`);
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
