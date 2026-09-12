export * from "./config";
export * from "./oracle";
export * from "./report";
export * from "./workload";

export interface HarnessRunOptions {
  readonly signal?: AbortSignal;
}

/** Adapter boundary shared by a current baseline and any future TalaDB runner. */
export interface HarnessRunner<Workload = unknown, Output = unknown> {
  readonly name: string;
  run(workload: Workload, options?: HarnessRunOptions): Promise<Output>;
}

export type WorkloadRunner<Output = unknown> = HarnessRunner<
  import("./workload").GeneratedWorkload,
  Output
>;

export function runHarness<Workload, Output>(
  runner: HarnessRunner<Workload, Output>,
  workload: Workload,
  options?: HarnessRunOptions
): Promise<Output> {
  return runner.run(workload, options);
}
