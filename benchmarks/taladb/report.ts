const PROHIBITED_KEY = /(?:path|text|query|vector|hash|content|embedding|result|\bid\b)/i;

export type BenchmarkMetric =
  | {
      readonly kind: "measured";
      readonly value: number;
      readonly unit: string;
      readonly sampleCount: number;
    }
  | {
      readonly kind: "estimated";
      readonly value: number;
      readonly unit: string;
      readonly method: string;
    }
  | { readonly kind: "unsupported"; readonly reason: string };

export interface BenchmarkReport {
  readonly schemaVersion: 1;
  readonly profile: string;
  readonly runner: string;
  readonly metrics: Readonly<Record<string, BenchmarkMetric>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeString(
  value: unknown,
  label: string,
  maxLength: number
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength)
    throw new Error(`${label} must be a non-empty bounded string`);
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${label} must be finite`);
}

/** Runtime validator for reports safe to persist or publish as benchmark metadata. */
export function assertBenchmarkReport(value: unknown): asserts value is BenchmarkReport {
  if (!isRecord(value)) throw new Error("Benchmark report must be an object");
  for (const key of Object.keys(value))
    if (PROHIBITED_KEY.test(key)) throw new Error(`Prohibited report key: ${key}`);
  if (value.schemaVersion !== 1) throw new Error("Unsupported benchmark report schema");
  assertSafeString(value.profile, "profile", 128);
  assertSafeString(value.runner, "runner", 128);
  if (!isRecord(value.metrics)) throw new Error("metrics must be an object");
  for (const [name, metric] of Object.entries(value.metrics)) {
    if (PROHIBITED_KEY.test(name) || !isRecord(metric)) throw new Error(`Unsafe metric: ${name}`);
    for (const key of Object.keys(metric))
      if (PROHIBITED_KEY.test(key)) throw new Error(`Prohibited metric key: ${key}`);
    if (metric.kind === "measured") {
      if (
        Object.keys(metric).some((key) => !["kind", "value", "unit", "sampleCount"].includes(key))
      )
        throw new Error("Invalid measured metric fields");
      assertFiniteNumber(metric.value, `${name}.value`);
      assertSafeString(metric.unit, `${name}.unit`, 32);
      if (!Number.isSafeInteger(metric.sampleCount) || metric.sampleCount < 1)
        throw new Error(`${name}.sampleCount must be a positive integer`);
    } else if (metric.kind === "estimated") {
      if (Object.keys(metric).some((key) => !["kind", "value", "unit", "method"].includes(key)))
        throw new Error("Invalid estimated metric fields");
      assertFiniteNumber(metric.value, `${name}.value`);
      assertSafeString(metric.unit, `${name}.unit`, 32);
      assertSafeString(metric.method, `${name}.method`, 256);
    } else if (metric.kind === "unsupported") {
      if (Object.keys(metric).some((key) => !["kind", "reason"].includes(key)))
        throw new Error("Invalid unsupported metric fields");
      assertSafeString(metric.reason, `${name}.reason`, 256);
    } else throw new Error(`Unknown metric kind for ${name}`);
  }
}

export function isBenchmarkReport(value: unknown): value is BenchmarkReport {
  try {
    assertBenchmarkReport(value);
    return true;
  } catch {
    return false;
  }
}

export function createBenchmarkReport(
  profile: string,
  runner: string,
  metrics: Readonly<Record<string, BenchmarkMetric>>
): BenchmarkReport {
  const report: BenchmarkReport = { schemaVersion: 1, profile, runner, metrics };
  assertBenchmarkReport(report);
  return report;
}

/** The only supported report persistence boundary; workload payloads have no serializer. */
export function serializeBenchmarkReport(report: BenchmarkReport): string {
  assertBenchmarkReport(report);
  return JSON.stringify(report);
}
