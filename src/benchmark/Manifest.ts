export const BENCHMARK_MARKER = ".trama-benchmark-vault";
export const BENCHMARK_REPORT = ".trama-benchmark-report.json";
export const BENCHMARK_MARKER_VERSION = "trama-simple-benchmark-v1" as const;
export const BENCHMARK_VAULT_NAME = "Trama Benchmark Vault";
export const BENCHMARK_NOTE_COUNT = 3000;
export const BENCHMARK_CORPUS_SHA256 =
  "66d061b6c61c157587bf1dace04c6e72e7b0c5d3f8dd44393699d3b50f7b1c8a";
export const BENCHMARK_EXPECTED_PATH =
  "/Users/andreacasarin/Documents/Code/trama/.artifacts/test-vaults/benchmark/Trama Benchmark Vault";

export interface BenchmarkManifest {
  readonly version: typeof BENCHMARK_MARKER_VERSION;
  readonly corpusSha256: string;
  readonly vaultName: typeof BENCHMARK_VAULT_NAME;
  readonly expectedPath: typeof BENCHMARK_EXPECTED_PATH;
  readonly noteCount: typeof BENCHMARK_NOTE_COUNT;
}

export interface BenchmarkReport {
  readonly version: "trama-simple-benchmark-report-v1";
  readonly status: "completed" | "error";
  readonly runId: string;
  readonly corpusSha256: string;
  readonly noteCount: typeof BENCHMARK_NOTE_COUNT;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly correctness: Readonly<Record<string, boolean>>;
  readonly relatedLookup?: {
    readonly results: readonly { readonly path: string; readonly score: number }[];
    readonly unavailableReason?: "semantic-unavailable" | "incomplete-vectors";
    readonly semanticPartial: boolean;
    readonly maintenanceBefore: boolean;
    readonly maintenanceAfter: boolean;
  };
  readonly performanceCapture?: {
    readonly complete: boolean;
    readonly records: readonly import("@/diagnostics/TramaDiagnostics").TramaPerformanceRecord[];
  };
  readonly error?: string;
}

export function parseBenchmarkManifest(raw: string, vaultName: string): BenchmarkManifest | null {
  try {
    const value = JSON.parse(raw) as Partial<BenchmarkManifest>;
    if (
      !value ||
      value.version !== BENCHMARK_MARKER_VERSION ||
      value.vaultName !== BENCHMARK_VAULT_NAME ||
      vaultName !== BENCHMARK_VAULT_NAME ||
      value.expectedPath !== BENCHMARK_EXPECTED_PATH ||
      value.noteCount !== BENCHMARK_NOTE_COUNT ||
      value.corpusSha256 !== BENCHMARK_CORPUS_SHA256
    )
      return null;
    return value as BenchmarkManifest;
  } catch {
    return null;
  }
}

export async function readBenchmarkManifest(
  adapter: { read(path: string): Promise<string> },
  vaultName: string
): Promise<BenchmarkManifest | null> {
  try {
    return parseBenchmarkManifest(await adapter.read(BENCHMARK_MARKER), vaultName);
  } catch {
    return null;
  }
}
