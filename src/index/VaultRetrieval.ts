import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { RunnableLambda, type RunnableConfig } from "@langchain/core/runnables";
import { StructuredError } from "@/domain/errors";
import { EmbeddingProviderError } from "@/model/LocalModels";
import type {
  NoteStoreCall,
  NoteStoreHybridResult,
  NoteStoreRelatedResult,
} from "./note-sqlite/protocol";

export interface VaultRetrievalInput {
  readonly query: string;
  readonly mode: "hybrid" | "lexical";
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

  constructor(
    private readonly call: NoteStoreCall,
    private readonly embeddings:
      | (EmbeddingsInterface<number[]> & {
          withSignal?(signal?: AbortSignal): EmbeddingsInterface<number[]>;
        })
      | undefined,
    private readonly profile: string | undefined,
    private readonly readNote: LiveMarkdownReader
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
    if (!this.profile) return { documents: [], available: false };
    const result = (await this.call(
      "noteStoreRelated",
      { sourcePath, profile: this.profile, k: Math.max(0, Math.min(20, Math.floor(limit))) },
      signal
    )) as NoteStoreRelatedResult;
    const documents = await this.hydrate(result.hits, signal);
    return { documents, available: result.available };
  }

  private async search(
    input: VaultRetrievalInput,
    signal?: AbortSignal
  ): Promise<VaultRetrievalOutput> {
    checkAbort(signal);
    const query = input.query.trim();
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
        k: 20,
      },
      signal
    )) as NoteStoreHybridResult;
    if (!degradationReason && result.degraded) degradationReason = result.degradationReason;
    const documents = await this.hydrate(result.hits, signal);
    const degraded = Boolean(degradationReason) || result.degraded;
    return {
      documents,
      status: {
        mode: result.mode,
        degraded,
        ...(degradationReason ? { degradationReason } : {}),
      },
    };
  }

  private async hydrate(
    hits: readonly {
      readonly path: string;
      readonly score: number;
      readonly lexicalScore?: number;
      readonly semanticScore?: number;
    }[],
    signal?: AbortSignal
  ): Promise<Document[]> {
    const documents: Document[] = [];
    for (const hit of hits) {
      checkAbort(signal);
      const note = await this.readNote(hit.path, signal);
      if (!note) continue;
      documents.push(
        new Document({
          id: hit.path,
          pageContent: note.content,
          metadata: {
            path: hit.path,
            score: hit.score,
            ...(hit.lexicalScore === undefined ? {} : { lexicalScore: hit.lexicalScore }),
            ...(hit.semanticScore === undefined ? {} : { semanticScore: hit.semanticScore }),
          },
        })
      );
    }
    return documents;
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StructuredError("cancelled", "Search cancelled.", false);
}

function isCancelled(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === "cancelled"
  );
}
