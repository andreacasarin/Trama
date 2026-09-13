export const WORKLOAD_SEED = 0x5eed_768;
export const WORKLOAD_DIMENSIONS = 768;
export const WORKLOAD_FINGERPRINT = "a".repeat(64);

export interface WorkloadProfile {
  readonly id: "trama-10k";
  readonly noteCount: number;
  readonly targetChunks: number;
}

export const WORKLOAD_PROFILE: WorkloadProfile = {
  id: "trama-10k",
  noteCount: 1_100,
  targetChunks: 10_000,
};

export function workloadProfile(id: WorkloadProfile["id"]): WorkloadProfile {
  if (id !== WORKLOAD_PROFILE.id) throw new Error(`Unknown workload profile: ${id}`);
  return WORKLOAD_PROFILE;
}
