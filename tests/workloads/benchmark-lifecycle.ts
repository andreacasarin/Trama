export type BenchmarkFailureStatus = "timeout" | "error";

export interface BenchmarkErrorEvidence {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

interface ErrorRecord {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

function removeControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("");
}

function recordFor(error: unknown): ErrorRecord {
  if (error && typeof error === "object") return error as ErrorRecord;
  return {};
}

function errorParts(error: unknown): { name: string; message: string; code?: string } {
  const record = recordFor(error);
  const nested = record.error;
  const name = typeof record.name === "string" ? record.name : "Error";
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof nested?.message === "string"
        ? nested.message
        : String(error);
  const code =
    typeof record.code === "string"
      ? record.code
      : typeof nested?.code === "string"
        ? nested.code
        : undefined;
  return { name, message, ...(code ? { code } : {}) };
}

/** Recognizes cancellation raised by the benchmark's explicit abort signal. */
export function isExplicitBenchmarkTimeout(error: unknown): boolean {
  const { name, message, code } = errorParts(error);
  return (
    code === "cancelled" ||
    name === "AbortError" ||
    name === "TimeoutError" ||
    message === "Index operation cancelled." ||
    message === "Operation cancelled" ||
    message === "Request cancelled"
  );
}

export function benchmarkFailureStatus(error: unknown): BenchmarkFailureStatus {
  return isExplicitBenchmarkTimeout(error) ? "timeout" : "error";
}

export function benchmarkCorrectnessFailure(
  correctness: Readonly<Record<string, unknown>>
): Error | undefined {
  const failures = Object.entries(correctness)
    .filter(([, value]) => value !== true)
    .map(([key]) => key);
  return failures.length
    ? new Error(`Benchmark correctness failed: ${failures.join(", ")}`)
    : undefined;
}

/** Keeps only stable error identity and text; stacks, causes, and attached data are omitted. */
export function sanitizeBenchmarkError(
  error: unknown,
  redactions: readonly string[] = []
): BenchmarkErrorEvidence {
  const parts = errorParts(error);
  let message = removeControlCharacters(parts.message).replace(/\s+/g, " ").trim();
  for (const redaction of redactions) {
    if (redaction.length < 16) continue;
    message = message.split(redaction).join("[redacted note content]");
    message = message.split(redaction.slice(0, 64)).join("[redacted note content]");
  }
  message = message.slice(0, 500);
  const name = removeControlCharacters(parts.name).slice(0, 80) || "Error";
  const code = parts.code?.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 80);
  return { name, message, ...(code ? { code } : {}) };
}
