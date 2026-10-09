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
