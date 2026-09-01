import { EmbeddingModel, StructuredError } from "@/domain/contracts";
import { LmStudioTransport } from "@/providers/lmStudio/LmStudioTransport";
export interface LmStudioEmbeddingOptions {
  readonly endpoint: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly batchSize?: number;
  readonly transport?: LmStudioTransport;
}
interface EmbeddingResponse {
  data?: readonly { embedding?: readonly number[]; index?: number }[];
}
interface ModelListResponse {
  data?: readonly { id?: string }[];
}
/** Adapts LM Studio's OpenAI-compatible embeddings API with bounded batches and dimension checks. */
export class LmStudioEmbeddingModel implements EmbeddingModel {
  readonly dimensions: number;
  private readonly options: LmStudioEmbeddingOptions;
  private readonly transport: LmStudioTransport;
  constructor(options: LmStudioEmbeddingOptions) {
    if (!Number.isInteger(options.dimensions) || options.dimensions <= 0)
      throw new StructuredError(
        "invalid_request",
        "Embedding dimensions must be a positive integer.",
        false
      );
    this.options = options;
    this.dimensions = options.dimensions;
    this.transport = options.transport ?? new LmStudioTransport();
  }
  async discoverModels(signal: AbortSignal): Promise<readonly string[]> {
    const response = await this.transport.get<ModelListResponse>(
      this.options.endpoint,
      "/models",
      signal
    );
    if (!Array.isArray(response.data))
      throw new StructuredError("internal", "LM Studio returned an invalid model list.", false);
    return response.data.filter((model) => typeof model.id === "string").map((model) => model.id!);
  }
  async embed(texts: readonly string[], signal: AbortSignal): Promise<readonly number[][]> {
    if (!this.options.modelId.trim())
      throw new StructuredError("invalid_request", "Embedding model ID is required.", false);
    const batchSize = this.options.batchSize ?? 32;
    if (!Number.isInteger(batchSize) || batchSize <= 0)
      throw new StructuredError("invalid_request", "Embedding batch size must be positive.", false);
    const result: number[][] = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      const expected = Math.min(batchSize, texts.length - start);
      const response = await this.transport.request<EmbeddingResponse>(
        this.options.endpoint,
        "/embeddings",
        { model: this.options.modelId, input: texts.slice(start, start + batchSize) },
        signal
      );
      if (!response.data || response.data.length !== expected)
        throw new StructuredError(
          "internal",
          "LM Studio returned an invalid embedding response.",
          false
        );
      for (const item of [...response.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
        if (
          !item.embedding ||
          item.embedding.length !== this.dimensions ||
          item.embedding.some((value) => !Number.isFinite(value))
        )
          throw new StructuredError(
            "internal",
            "LM Studio returned an embedding with the wrong dimensions.",
            false
          );
        result.push([...item.embedding]);
      }
    }
    return result;
  }
}
