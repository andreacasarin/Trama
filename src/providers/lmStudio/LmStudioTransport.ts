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
    this.fetcher = (options.fetcher ?? globalThis.fetch).bind(globalThis);
    this.policy = options.policy ?? new EndpointPolicy();
  }
  /** Re-validates the endpoint immediately before making a request. */
  async request<T>(endpoint: string, path: string, body: unknown, signal: AbortSignal): Promise<T> {
    return this.send<T>(endpoint, path, signal, "POST", body);
  }
  async get<T>(endpoint: string, path: string, signal: AbortSignal): Promise<T> {
    return this.send<T>(endpoint, path, signal, "GET");
  }
  /** Streams parsed JSON values from an LM Studio server-sent event response. */
  async *stream<T>(
    endpoint: string,
    path: string,
    body: unknown,
    signal: AbortSignal
  ): AsyncGenerator<T> {
    const response = await this.fetch(endpoint, path, signal, "POST", body);
    await this.ensureOk(response);
    if (!response.body)
      throw new StructuredError("unavailable", "LM Studio returned an empty stream.", true);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data || data === "[DONE]") continue;
          try {
            yield JSON.parse(data) as T;
          } catch {
            throw new StructuredError(
              "internal",
              "LM Studio returned malformed stream data.",
              false
            );
          }
        }
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
  }
  private async send<T>(
    endpoint: string,
    path: string,
    signal: AbortSignal,
    method: "GET" | "POST",
    body?: unknown
  ): Promise<T> {
    const response = await this.fetch(endpoint, path, signal, method, body);
    await this.ensureOk(response);
    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new StructuredError("internal", "LM Studio returned malformed JSON.", false);
    }
  }
  private async fetch(
    endpoint: string,
    path: string,
    signal: AbortSignal,
    method: "GET" | "POST",
    body?: unknown
  ): Promise<Response> {
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
      const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
      throw new StructuredError("unavailable", `LM Studio could not be reached.${detail}`, true);
    }
    return response;
  }
  private async ensureOk(response: Response): Promise<void> {
    if (response.ok) return;
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const error =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? (parsed as { error: unknown }).error
        : undefined;
    const message =
      typeof error === "string"
        ? error
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : `LM Studio returned HTTP ${response.status}.`;
    throw new StructuredError("unavailable", message, response.status >= 500);
  }
}
