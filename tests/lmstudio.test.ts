import { describe, expect, it, vi } from "vitest";
import { StructuredError } from "@/domain/contracts";
import { LmStudioChatModel } from "@/providers/lmStudio/LmStudioChatModel";
import { LmStudioEmbeddingModel } from "@/providers/lmStudio/LmStudioEmbeddingModel";
import { LmStudioTransport } from "@/providers/lmStudio/LmStudioTransport";

const response = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
const streamResponse = (...chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );

describe("LM Studio adapters module", () => {
  describe("LmStudioChatModel", () => {
    describe("complete()", () => {
      it("maps tool definitions and tool calls into the domain response", async () => {
        const fetcher = vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            streamResponse(
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"path\\":"}}]}}]}\n\n',
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
              "data: [DONE]\n\n"
            )
          );
        const model = new LmStudioChatModel({
          endpoint: "http://127.0.0.1:1234/v1",
          modelId: "local",
          tools: [{ name: "read", description: "read", parameters: { type: "object" } }],
          transport: new LmStudioTransport({ fetcher }),
        });
        const result = await model.complete(
          [{ role: "user", content: "go" }],
          new AbortController().signal
        );
        expect(result.finishReason).toBe("tool_calls");
        expect(result.message.toolCalls?.[0].arguments).toEqual({ path: "a.md" });
        expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).tools[0].function.name).toBe(
          "read"
        );
        expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).stream).toBe(true);
      });

      it("emits text as fragmented server-sent event chunks arrive", async () => {
        const fetcher = vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            streamResponse(
              'data: {"choices":[{"delta":{"content":"Hel',
              'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n',
              "data: [DONE]\n\n"
            )
          );
        const model = new LmStudioChatModel({
          endpoint: "http://127.0.0.1:1234/v1",
          modelId: "local",
          transport: new LmStudioTransport({ fetcher }),
        });
        const deltas: string[] = [];
        const result = await model.complete(
          [{ role: "user", content: "go" }],
          new AbortController().signal,
          undefined,
          (text) => deltas.push(text)
        );
        expect(deltas).toEqual(["Hello", " world"]);
        expect(result.message.content).toBe("Hello world");
      });
    });
  });
  describe("LmStudioEmbeddingModel", () => {
    describe("embed()", () => {
      it("batches inputs, restores response order, and validates dimensions", async () => {
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
          const input = JSON.parse(String(init?.body)).input as string[];
          return response({
            data: input.map((_, index) => ({
              index: input.length - index - 1,
              embedding: [input.length - index, 0],
            })),
          });
        });
        const model = new LmStudioEmbeddingModel({
          endpoint: "http://127.0.0.1:1234/v1",
          modelId: "embed",
          dimensions: 2,
          batchSize: 2,
          transport: new LmStudioTransport({ fetcher }),
        });
        expect(await model.embed(["a", "b", "c"], new AbortController().signal)).toEqual([
          [1, 0],
          [2, 0],
          [1, 0],
        ]);
        expect(fetcher).toHaveBeenCalledTimes(2);
      });
      it("rejects an embedding with the wrong dimensions", async () => {
        const fetcher = vi
          .fn<typeof fetch>()
          .mockResolvedValue(response({ data: [{ index: 0, embedding: [1] }] }));
        const model = new LmStudioEmbeddingModel({
          endpoint: "http://127.0.0.1:1234",
          modelId: "embed",
          dimensions: 2,
          transport: new LmStudioTransport({ fetcher }),
        });
        await expect(model.embed(["a"], new AbortController().signal)).rejects.toMatchObject({
          code: "internal",
        });
      });
    });
  });
  describe("LmStudioTransport", () => {
    describe("request()", () => {
      it("surfaces HTTP errors and cancellation as structured errors and refuses redirects", async () => {
        const httpError = new LmStudioTransport({
          fetcher: vi
            .fn<typeof fetch>()
            .mockResolvedValue(response({ error: "bad" }, { status: 400 })),
        });
        await expect(
          httpError.request("http://127.0.0.1:1234", "/models", {}, new AbortController().signal)
        ).rejects.toMatchObject({ code: "unavailable" });
        const redirect = new LmStudioTransport({
          fetcher: vi
            .fn<typeof fetch>()
            .mockResolvedValue(
              new Response("", { status: 302, headers: { location: "https://example.com" } })
            ),
        });
        await expect(
          redirect.request("http://127.0.0.1:1234", "/models", {}, new AbortController().signal)
        ).rejects.toMatchObject({ code: "unavailable" });
        const controller = new AbortController();
        controller.abort();
        const cancelled = new LmStudioTransport({
          fetcher: vi
            .fn<typeof fetch>()
            .mockRejectedValue(new DOMException("aborted", "AbortError")),
        });
        await expect(
          cancelled.request("http://127.0.0.1:1234", "/models", {}, controller.signal)
        ).rejects.toBeInstanceOf(StructuredError);
      });

      it("invokes fetch with the browser global receiver and preserves connection details", async () => {
        const fetcher = vi.fn(function (this: unknown) {
          if (this !== globalThis) throw new TypeError("Illegal invocation");
          return Promise.reject(new TypeError("Failed to fetch"));
        }) as unknown as typeof fetch;
        const transport = new LmStudioTransport({ fetcher });
        await expect(
          transport.get("http://127.0.0.1:1234", "/models", new AbortController().signal)
        ).rejects.toMatchObject({
          code: "unavailable",
          message: "LM Studio could not be reached. Failed to fetch",
        });
      });
    });
  });
});
