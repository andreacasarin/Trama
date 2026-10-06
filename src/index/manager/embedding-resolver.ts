import { StructuredError, type EmbeddingModel, type EmbeddingProgress } from "@/domain/contracts";
import type { SqliteRequestPayloads, SqliteSemanticWorkBatch } from "@/index/sqlite/protocol";
import type { SqliteWorkerClient } from "@/index/sqlite/client";
import { QueryEmbeddingError } from "@/index/retrieval/QueryEmbeddingError";
import { check, IndexRuntime } from "./runtime";

/** Resolves the vault's single embedding space. SQLite owns cache lookup and storage. */
export class EmbeddingResolver {
  constructor(
    private readonly runtime: IndexRuntime,
    private readonly provider: EmbeddingModel
  ) {}

  get dimensions(): number {
    return this.provider.dimensions;
  }
  get batchLimits() {
    return this.provider.batchLimits;
  }

  /** SQL promotes complete cache hits and packs unique misses across all current notes. */
  prepareDocuments(
    payload: SqliteRequestPayloads["prepareSemanticWork"],
    signal: AbortSignal,
    options?: Parameters<SqliteWorkerClient["call"]>[3]
  ): Promise<SqliteSemanticWorkBatch> {
    return this.runtime.ensureClient().call("prepareSemanticWork", payload, signal, options);
  }

  /** Document inputs have already passed the batched SQL cache lookup. */
  async resolveMissing(
    inputs: readonly string[],
    signal: AbortSignal,
    onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<readonly number[][]> {
    check(signal);
    if (!inputs.length) return [];
    const profile = this.runtime.state?.embeddingFingerprint;
    if (
      this.runtime.state?.semanticRebuildRequired ||
      !(await this.runtime.providerMatchesActiveProfile())
    )
      throw new StructuredError(
        "unavailable",
        "The configured embedding provider is unavailable for this index.",
        true
      );
    const unique = [...new Set(inputs)];
    const vectors = await this.provider.embed(unique, signal, onProgress);
    check(signal);
    if (
      this.runtime.state?.embeddingFingerprint !== profile ||
      this.runtime.state?.semanticRebuildRequired
    )
      throw new StructuredError("cancelled", "Embedding model changed during the request.", true);
    if (
      vectors.length !== unique.length ||
      vectors.some((vector) => vector.length !== this.dimensions)
    )
      throw new StructuredError(
        "internal",
        "Embedding dimensions changed during preparation.",
        false
      );
    const resolved = new Map(unique.map((input, index) => [input, vectors[index]]));
    return inputs.map((input) => resolved.get(input)!);
  }

  async resolveQuery(query: string, signal: AbortSignal): Promise<Float32Array> {
    check(signal);
    const profile = this.runtime.state?.embeddingFingerprint;
    if (!profile || this.runtime.state?.semanticRebuildRequired) throw new QueryEmbeddingError();
    const cached = (await this.runtime.ensureClient().call(
      "lookupQueryVector",
      {
        query,
        embeddingFingerprint: profile,
      },
      signal
    )) as Float32Array | undefined;
    if (cached) {
      if (
        this.runtime.state?.embeddingFingerprint !== profile ||
        this.runtime.state?.semanticRebuildRequired
      )
        throw new QueryEmbeddingError();
      return new Float32Array(cached);
    }
    let vector: Float32Array;
    try {
      const values = await this.resolveMissing([query], signal);
      vector = new Float32Array(values[0]);
    } catch {
      check(signal);
      throw new QueryEmbeddingError();
    }
    if (!vector.every(Number.isFinite) || !vector.some((value) => value !== 0))
      throw new QueryEmbeddingError();
    await this.runtime.ensureClient().call(
      "storeQueryVector",
      {
        query,
        embeddingFingerprint: profile,
        dimensions: vector.length,
        vector,
      },
      signal
    );
    return vector;
  }
}
