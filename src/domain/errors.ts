export type StructuredErrorCode =
  "cancelled" | "busy" | "invalid_request" | "unavailable" | "limit_exceeded" | "internal";
export interface StructuredErrorShape {
  readonly code: StructuredErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}
export class StructuredError extends Error implements StructuredErrorShape {
  readonly name = "StructuredError";
  constructor(
    readonly code: StructuredErrorCode,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
  }
}

export function checkAbort(signal?: AbortSignal, message = "Operation cancelled"): void {
  if (signal?.aborted) throw new DOMException(message, "AbortError");
}

export function isCancelled(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    (("name" in error && error.name === "AbortError") ||
      ("code" in error && error.code === "cancelled"))
  );
}
