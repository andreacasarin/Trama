import { OpenAIEmbeddings } from "@langchain/openai";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import OpenAI from "openai";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { StructuredError } from "@/domain/errors";
import { normalizeReasoningEffort, type ChatSettings } from "@/settings/Settings";

export function createLocalChatModel(
  settings: ChatSettings,
  fetcher: typeof fetch = globalThis.fetch
): BaseChatModel {
  const baseURL = settings.endpoint.trim();
  const reasoningEffort = normalizeReasoningEffort(settings.reasoningEffort);
  return new ChatOpenAI({
    model: settings.modelId || "local-model-not-configured",
    apiKey: "local-endpoint",
    useResponsesApi: true,
    zdrEnabled: true,
    supportsStrictToolCalling: false,
    maxRetries: 0,
    temperature: settings.temperature,
    ...(settings.maxOutputTokens ? { maxTokens: settings.maxOutputTokens } : {}),
    modelKwargs: {
      text: { format: { type: "text" } },
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    },
    configuration: {
      baseURL,
      fetch: fetcher,
    },
  });
}

export async function discoverLocalModels(
  endpoint: string,
  fetcher: typeof fetch = globalThis.fetch
): Promise<readonly string[]> {
  const baseURL = endpoint.trim();
  const client = new OpenAI({
    apiKey: "local-endpoint",
    baseURL,
    maxRetries: 0,
    dangerouslyAllowBrowser: true,
    fetch: fetcher,
  });
  const result = await client.models.list();
  return result.data.map(({ id }) => id);
}

export class EmbeddingProviderError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "EmbeddingProviderError";
    this.cause = cause;
  }
}

export interface LocalEmbeddingOptions {
  readonly endpoint: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly fetcher?: typeof fetch;
}

class GuardedOpenAIEmbeddings extends OpenAIEmbeddings {
  private readonly expectedDimensions: number;

  constructor(
    options: LocalEmbeddingOptions,
    baseURL: string,
    signal: AbortSignal | undefined,
    fetcher: typeof fetch
  ) {
    super({
      model: options.modelId,
      dimensions: options.dimensions,
      encodingFormat: "float",
      stripNewLines: false,
      batchSize: 512,
      maxRetries: 0,
      apiKey: "local-endpoint",
      configuration: {
        baseURL,
        fetch: signalFetch(fetcher, signal),
      },
    });
    this.expectedDimensions = options.dimensions;
  }

  protected override async embeddingWithRetry(
    request: OpenAI.EmbeddingCreateParams
  ): Promise<OpenAI.CreateEmbeddingResponse & { _request_id?: string | null }> {
    let response: OpenAI.CreateEmbeddingResponse & { _request_id?: string | null };
    try {
      response = await super.embeddingWithRetry(request);
    } catch (error) {
      const guarded = structuredCause(error);
      if (guarded?.code === "cancelled") throw guarded;
      if (error instanceof DOMException && error.name === "AbortError")
        throw new StructuredError("cancelled", "The request was cancelled.", false);
      throw new EmbeddingProviderError("The embedding provider request failed.", error);
    }
    const inputCount = Array.isArray(request.input) ? request.input.length : 1;
    if (!Array.isArray(response.data) || response.data.length !== inputCount)
      throw new EmbeddingProviderError("The embedding provider returned an incomplete batch.");
    const ordered = new Array<(typeof response.data)[number]>(inputCount);
    for (const item of response.data) {
      if (
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= inputCount ||
        ordered[item.index]
      )
        throw new EmbeddingProviderError("The embedding provider returned invalid indexes.");
      if (
        item.embedding.length !== this.expectedDimensions ||
        item.embedding.some((value) => !Number.isFinite(value))
      )
        throw new EmbeddingProviderError("The embedding provider returned an invalid vector.");
      ordered[item.index] = item;
    }
    return { ...response, data: ordered };
  }
}

function structuredCause(error: unknown): StructuredError | undefined {
  let current: unknown = error;
  while (current && typeof current === "object") {
    if (current instanceof StructuredError) return current;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

export function createLocalEmbeddings(options: LocalEmbeddingOptions): EmbeddingsInterface<
  number[]
> & {
  withSignal(signal?: AbortSignal): EmbeddingsInterface<number[]>;
} {
  if (
    !options.modelId.trim() ||
    !Number.isSafeInteger(options.dimensions) ||
    options.dimensions < 1
  )
    throw new StructuredError(
      "invalid_request",
      "A model ID and positive embedding dimensions are required.",
      false
    );
  const baseURL = options.endpoint.trim();
  const fetcher = (options.fetcher ?? globalThis.fetch).bind(globalThis);
  const make = (signal?: AbortSignal) =>
    new GuardedOpenAIEmbeddings(options, baseURL, signal, fetcher);
  const embeddings = make() as GuardedOpenAIEmbeddings & {
    withSignal(signal?: AbortSignal): EmbeddingsInterface<number[]>;
  };
  embeddings.withSignal = (signal) => make(signal);
  return embeddings;
}

function signalFetch(fetcher: typeof fetch, scopedSignal?: AbortSignal): typeof fetch {
  return async (input, init = {}) => {
    const requestSignal = input instanceof Request ? input.signal : undefined;
    const signals = [init.signal, requestSignal, scopedSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined
    );
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    try {
      const response = await fetcher(input, {
        ...init,
        ...(signal ? { signal } : {}),
      });
      return response;
    } catch (error) {
      if (error instanceof StructuredError) throw error;
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError"))
        throw new StructuredError("cancelled", "The request was cancelled.", false);
      throw new EmbeddingProviderError(
        "The configured embedding endpoint could not be reached.",
        error
      );
    }
  };
}
