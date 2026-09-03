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

  async request<T>(endpoint: string, path: string, body: unknown, signal: AbortSignal): Promise<T> {
    return this.send<T>(endpoint, path, signal, "POST", body);
  }

  async get<T>(endpoint: string, path: string, signal: AbortSignal): Promise<T> {
    return this.send<T>(endpoint, path, signal, "GET");
  }

  /** Streams parsed server-sent event data from an LM Studio Responses request. */
  async *stream<T>(
    endpoint: string,
    path: string,
    body: unknown,
    signal: AbortSignal
  ): AsyncGenerator<T> {
    const response = await this.fetch(endpoint, path, signal, "POST", body);
    await this.ensureOk(response, path);
    if (!response.body) {
      throw new StructuredError("unavailable", "LM Studio returned an empty stream.", true);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const records = buffer.split(/\r?\n\r?\n/);
        buffer = records.pop() ?? "";
        for (const record of records) yield* this.parseRecord<T>(record);
        if (done) {
          if (buffer.trim()) yield* this.parseRecord<T>(buffer);
          break;
        }
      }
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new StructuredError("cancelled", "The request was cancelled.", false);
      }
      throw error;
    } finally {
      if (signal.aborted) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private *parseRecord<T>(record: string): Generator<T> {
    const data = record
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      yield JSON.parse(data) as T;
    } catch {
      throw new StructuredError("internal", "LM Studio returned malformed stream data.", false);
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
    await this.ensureOk(response, path);
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
    if (path.startsWith("/v1")) {
      throw new StructuredError("invalid_request", "Request path must be relative to /v1.", false);
    }
    try {
      return await this.fetcher(`${base}${path.startsWith("/") ? path : `/${path}`}`, {
        method,
        ...(method === "POST"
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
          : {}),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new StructuredError("cancelled", "The request was cancelled.", false);
      }
      const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
      throw new StructuredError("unavailable", `LM Studio could not be reached.${detail}`, true);
    }
  }

  private async ensureOk(response: Response, path: string): Promise<void> {
    if (response.ok) return;
    const text = await response.text();
    if (path === "/responses" && (response.status === 404 || response.status === 405)) {
      throw new StructuredError(
        "unavailable",
        "LM Studio Responses API requires LM Studio 0.3.29 or newer.",
        false
      );
    }
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
