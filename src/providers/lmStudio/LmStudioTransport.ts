import { StructuredError } from "@/domain/contracts";
import { EndpointPolicy } from "@/security/EndpointPolicy";

export interface LmStudioTransportOptions {
  readonly fetcher?: typeof fetch;
  readonly policy?: EndpointPolicy;
}
/** Performs guarded LM Studio HTTP requests with redirects disabled. */
export class LmStudioTransport {
  private readonly fetcher: typeof fetch;
  private readonly policy: EndpointPolicy;
  constructor(options: LmStudioTransportOptions = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.policy = options.policy ?? new EndpointPolicy();
  }
  /** Re-validates the endpoint immediately before making a request. */
  async request<T>(endpoint: string, path: string, body: unknown, signal: AbortSignal): Promise<T> {
    return this.send<T>(endpoint, path, signal, "POST", body);
  }
  async get<T>(endpoint: string, path: string, signal: AbortSignal): Promise<T> {
    return this.send<T>(endpoint, path, signal, "GET");
  }
  private async send<T>(
    endpoint: string,
    path: string,
    signal: AbortSignal,
    method: "GET" | "POST",
    body?: unknown
  ): Promise<T> {
    const base = this.policy.normalize(endpoint);
    if (path.startsWith("/v1"))
      throw new StructuredError("invalid_request", "Request path must be relative to /v1.", false);
    let response: Response;
    try {
      response = await this.fetcher(`${base}${path.startsWith("/") ? path : `/${path}`}`, {
        method,
        ...(method === "POST"
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
          : {}),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError"))
        throw new StructuredError("cancelled", "The request was cancelled.", false);
      throw new StructuredError("unavailable", "LM Studio could not be reached.", true);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const message =
        typeof parsed === "object" && parsed !== null && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : `LM Studio returned HTTP ${response.status}.`;
      throw new StructuredError("unavailable", message, response.status >= 500);
    }
    return parsed as T;
  }
}
