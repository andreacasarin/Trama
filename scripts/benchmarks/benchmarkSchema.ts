export interface BenchmarkTiming {
  readonly p50Ms?: number;
  readonly p95Ms?: number;
  readonly maxMs?: number;
}

export interface SanitizedBenchmarkScaleResult {
  readonly scale: number;
  readonly noteCount: number;
  readonly chunkCount: number;
  readonly buildMs?: number;
  readonly restartMs?: number;
  readonly search?: BenchmarkTiming;
  readonly eventLoop?: BenchmarkTiming;
  readonly storageBytes?: number;
  readonly memory?: { readonly rssDeltaBytes?: number; readonly heapDeltaBytes?: number };
  readonly updates?: {
    readonly unchangedEmbedCalls?: number;
    readonly unchangedPublished?: boolean;
    readonly modifyEmbedCalls?: number;
    readonly deleteEmbedCalls?: number;
    readonly renameEmbedCalls?: number;
  };
  readonly unsupported?: readonly string[];
}

export interface SanitizedBenchmarkReport {
  readonly schemaVersion: 1;
  readonly harness: "unified-orama";
  readonly backend: "baseline-current-source" | "candidate-unified-orama";
  readonly generatedAt: string;
  readonly config: {
    readonly dimensions: number;
    readonly chunkSize: number;
    readonly overlap: number;
    readonly scales: readonly number[];
  };
  readonly scales: readonly SanitizedBenchmarkScaleResult[];
  readonly unsupported: readonly string[];
}
