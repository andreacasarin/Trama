export const WORKLOAD_SEED = 0x5eed_768;
export const WORKLOAD_DIMENSIONS = 768;
export const WORKLOAD_FINGERPRINT = "a".repeat(64);
export const SIMPLE_BENCHMARK_NOTE_COUNT = 3000;
export const SIMPLE_BENCHMARK_NOTE_CHARACTERS = 400;
export const SIMPLE_BENCHMARK_CORPUS_SHA256 =
  "66d061b6c61c157587bf1dace04c6e72e7b0c5d3f8dd44393699d3b50f7b1c8a";

export interface WorkloadProfile {
  readonly id: "trama-small" | "trama-10k" | "trama-large";
  readonly noteCount: number;
  readonly targetChunks: number;
}

export const WORKLOAD_PROFILES: Readonly<Record<WorkloadProfile["id"], WorkloadProfile>> = {
  "trama-small": {
    id: "trama-small",
    noteCount: 24,
    targetChunks: 128,
  },
  "trama-10k": {
    id: "trama-10k",
    noteCount: 1_100,
    targetChunks: 10_000,
  },
  "trama-large": {
    id: "trama-large",
    noteCount: 2_750,
    targetChunks: 25_000,
  },
};

export const WORKLOAD_PROFILE = WORKLOAD_PROFILES["trama-10k"];

export function workloadProfile(id: WorkloadProfile["id"]): WorkloadProfile {
  const profile = WORKLOAD_PROFILES[id];
  if (!profile) throw new Error(`Unknown workload profile: ${id}`);
  return profile;
}
