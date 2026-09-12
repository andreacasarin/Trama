/**
 * Frozen, repository-contained workload configuration shared by baseline and
 * candidate benchmark runs. Keep this file stable after baseline capture.
 */
export const UNIFIED_ORAMA_BENCHMARK_CONFIG = Object.freeze({
  seed: 0x51_7a_29_11,
  dimensions: 768,
  chunkSize: 384,
  overlap: 64,
  notesForScale: Object.freeze({
    1_000: 100,
    25_000: 2_740,
    50_000: 5_480,
    100_000: 10_960,
  }),
  scales: Object.freeze([1_000, 25_000, 50_000, 100_000]),
  queryCount: 7,
  warmupQueries: 1,
  schemaVersion: 1,
} as const);

export type UnifiedOramaBenchmarkScale = (typeof UNIFIED_ORAMA_BENCHMARK_CONFIG.scales)[number];
