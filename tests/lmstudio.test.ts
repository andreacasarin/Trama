import { describe, expect, it, vi } from "vitest";
import { StructuredError } from "@/domain/contracts";
import { LmStudioChatModel } from "@/providers/lmStudio/LmStudioChatModel";
import { LmStudioEmbeddingModel } from "@/providers/lmStudio/LmStudioEmbeddingModel";
import { LmStudioTransport } from "@/providers/lmStudio/LmStudioTransport";
import { VoceDiagnosticRecord } from "@/chat/VoceDiagnostics";

const ISSUE = "https://github.com/logancyang/obsidian-copilot/issues/3077";

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

const sse = (type: string, value: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ type, ...value })}\n\n`;

const completed = (extra: Record<string, unknown> = {}) =>
  sse("response.completed", {
    response: { status: "completed", ...extra },
  });

function model(fetcher: typeof fetch, options: Record<string, unknown> = {}) {
  return new LmStudioChatModel({
    endpoint: "http://127.0.0.1:1234/v1",
    modelId: "local",
    transport: new LmStudioTransport({ fetcher }),
    ...(options as object),
  });
}

describe("LM Studio adapters module", () => {
  describe("LmStudioChatModel", () => {
    describe("complete()", () => {
      it(`posts stateless Responses requests with the exact path and omission contract (${ISSUE})`, async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(completed()));
        await model(fetcher).complete(
          [{ role: "user", content: "hello" }],
          new AbortController().signal
        );
        const [url, init] = fetcher.mock.calls[0];
        const body = JSON.parse(String(init?.body));
        expect(url).toBe("http://127.0.0.1:1234/v1/responses");
        expect(body).toMatchObject({ model: "local", stream: true, store: false });
        expect(body).not.toHaveProperty("messages");
        expect(body).not.toHaveProperty("max_tokens");
        expect(body).not.toHaveProperty("context");
        expect(body).not.toHaveProperty("previous_response_id");
        expect(body).not.toHaveProperty("conversation");
      });

      it("emits the exact Responses payloads without instrumenting shared transport", async () => {
        const fetcher = vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            streamResponse(
              sse("response.output_text.delta", { delta: "ok" }),
              completed({ usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })
            )
          );
        const records: VoceDiagnosticRecord[] = [];
        const result = await model(fetcher, {
          diagnostics: { emit: (record: VoceDiagnosticRecord) => records.push(record) },
        }).complete([{ role: "user", content: "hello" }], new AbortController().signal);

        expect(records).toEqual([
          {
            event: "responses_request",
            body: {
              model: "local",
              input: [{ type: "message", role: "user", content: "hello" }],
              stream: true,
              store: false,
            },
          },
          {
            event: "responses_sse_event",
            eventData: { type: "response.output_text.delta", delta: "ok" },
          },
          {
            event: "responses_sse_event",
            eventData: {
              type: "response.completed",
              response: {
                status: "completed",
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          },
          { event: "model_response", response: result },
        ]);
      });

      it("emits model errors after malformed Responses events", async () => {
        const records: VoceDiagnosticRecord[] = [];
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse("data: {bad}\n\n"));

        await expect(
          model(fetcher, {
            diagnostics: { emit: (record: VoceDiagnosticRecord) => records.push(record) },
          }).complete([], new AbortController().signal)
        ).rejects.toMatchObject({ code: "internal" });

        expect(records.at(-1)).toMatchObject({ event: "model_error", error: { code: "internal" } });
      });

      it(`sends all explicit provider-neutral parameters under Responses wire names (${ISSUE})`, async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(completed()));
        await model(fetcher, {
          temperature: 0.4,
          maxOutputTokens: 2048,
          reasoningEffort: "high",
        }).complete([], new AbortController().signal);
        const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
        expect(body.temperature).toBe(0.4);
        expect(body.max_output_tokens).toBe(2048);
        expect(body.reasoning).toEqual({ effort: "high" });
      });

      it(`serializes explicit none reasoning separately from Auto omission (${ISSUE})`, async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(completed()));
        await model(fetcher, { reasoningEffort: "none" }).complete(
          [],
          new AbortController().signal
        );
        const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
        expect(body.reasoning).toEqual({ effort: "none" });

        const autoFetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(completed()));
        await model(autoFetcher).complete([], new AbortController().signal);
        const autoBody = JSON.parse(String(autoFetcher.mock.calls[0][1]?.body));
        expect(autoBody).not.toHaveProperty("reasoning");
      });

      it(`replays messages, reasoning, function calls, and outputs in local order (${ISSUE})`, async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(completed()));
        await model(fetcher).complete(
          [
            { role: "system", content: "rules" },
            { role: "user", content: "read" },
            {
              role: "assistant",
              content: "",
              reasoningContext: "thinking",
              toolCalls: [{ id: "call-1", name: "read", arguments: { path: "a.md" } }],
            },
            { role: "tool", content: "answer", toolCallId: "call-1" },
          ],
          new AbortController().signal
        );
        const input = JSON.parse(String(fetcher.mock.calls[0][1]?.body)).input;
        expect(input).toEqual([
          { type: "message", role: "system", content: "rules" },
          { type: "message", role: "user", content: "read" },
          { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] },
          { type: "function_call", call_id: "call-1", name: "read", arguments: '{"path":"a.md"}' },
          { type: "function_call_output", call_id: "call-1", output: "answer" },
        ]);
      });

      it(`uses flat function tools and rejects tool correlations before network I/O (${ISSUE})`, async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(completed()));
        await model(fetcher, {
          tools: [{ name: "read", description: "read note", parameters: { type: "object" } }],
        }).complete([{ role: "user", content: "read" }], new AbortController().signal);
        const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
        expect(body.tools).toEqual([
          {
            type: "function",
            name: "read",
            description: "read note",
            parameters: { type: "object" },
          },
        ]);

        const invalidFetcher = vi.fn<typeof fetch>();
        await expect(
          model(invalidFetcher).complete(
            [{ role: "tool", content: "orphan", toolCallId: "missing" }],
            new AbortController().signal
          )
        ).rejects.toMatchObject({ code: "internal" });
        expect(invalidFetcher).not.toHaveBeenCalled();
      });

      it(`handles fragmented SSE, EOF records, and deduplicates text/refusal callbacks (${ISSUE})`, async () => {
        const helloDelta = sse("response.output_text.delta", { delta: "Hel" });
        const fetcher = vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            streamResponse(
              helloDelta.slice(0, 19),
              helloDelta.slice(19),
              sse("response.output_text.delta", { delta: "lo" }),
              sse("response.output_text.done", { text: "Hello" }),
              sse("response.refusal.delta", { delta: " no" }),
              sse("response.refusal.done", { refusal: " no" }),
              completed().trimEnd()
            )
          );
        const deltas: string[] = [];
        const result = await model(fetcher).complete(
          [{ role: "user", content: "go" }],
          new AbortController().signal,
          undefined,
          (text) => deltas.push(text)
        );
        expect(deltas).toEqual(["Hel", "lo", " no"]);
        expect(result.message.content).toBe("Hello no");
      });

      it(`captures reasoning separately and finalizes interleaved tool calls in item order (${ISSUE})`, async () => {
        const responseChunks = [
          sse("response.reasoning_summary_text.delta", { delta: "think" }),
          sse("response.output_item.added", {
            item: { type: "function_call", id: "item-1", call_id: "call-1", name: "read" },
          }),
          sse("response.output_item.added", {
            item: { type: "function_call", id: "item-2", call_id: "call-2", name: "search" },
          }),
          sse("response.function_call_arguments.delta", { item_id: "item-2", delta: '{"q":' }),
          sse("response.function_call_arguments.delta", {
            call_id: "call-1",
            delta: '{"path":"a.md"}',
          }),
          sse("response.function_call_arguments.done", {
            item_id: "item-2",
            arguments: '{"q":"x"}',
          }),
          completed({ usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } }),
        ];
        const fetcher = vi
          .fn<typeof fetch>()
          .mockImplementation(async () => streamResponse(...responseChunks));
        const result = await model(fetcher).complete([], new AbortController().signal);
        expect(result.message.reasoningContext).toBe("think");
        expect(result.message.toolCalls).toEqual([
          { id: "call-1", name: "read", arguments: { path: "a.md" } },
          { id: "call-2", name: "search", arguments: { q: "x" } },
        ]);
        expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
        expect(result.finishReason).toBe("tool_calls");
        await model(fetcher).complete([result.message], new AbortController().signal);
        expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).input).toContainEqual({
          type: "reasoning",
          summary: [{ type: "summary_text", text: "think" }],
        });
      });

      it(`returns length for token exhaustion and rejects other terminal failures (${ISSUE})`, async () => {
        const lengthFetcher = vi.fn<typeof fetch>().mockResolvedValue(
          streamResponse(
            sse("response.incomplete", {
              response: { incomplete_details: { reason: "max_output_tokens" } },
            })
          )
        );
        await expect(
          model(lengthFetcher).complete([], new AbortController().signal)
        ).resolves.toMatchObject({
          finishReason: "length",
        });
        for (const event of [
          sse("response.incomplete", {
            response: { incomplete_details: { reason: "content_filter" } },
          }),
          sse("response.failed", { response: { error: { message: "failed" } } }),
          sse("error", { error: { message: "broken" } }),
        ]) {
          const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(event));
          await expect(
            model(fetcher).complete([], new AbortController().signal)
          ).rejects.toBeInstanceOf(StructuredError);
        }
      });

      it(`rejects malformed, missing, conflicting, and hosted-tool terminal streams while ignoring unknown events (${ISSUE})`, async () => {
        const cases = [
          sse("response.output_text.delta"),
          "data: {not-json}\n\n",
          sse("response.output_text.delta", { delta: "unfinished" }),
          sse("response.completed") + sse("response.failed", { response: {} }),
          sse("response.output_item.added", { item: { type: "computer_call" } }) + completed(),
          sse("response.output_item.added", { item: { type: "function_call", call_id: "c" } }) +
            completed(),
        ];
        for (const stream of cases) {
          const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(stream));
          await expect(
            model(fetcher).complete([], new AbortController().signal)
          ).rejects.toBeInstanceOf(StructuredError);
        }
        const fetcher = vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            streamResponse(sse("response.future_event", { value: 1 }) + completed())
          );
        await expect(
          model(fetcher).complete([], new AbortController().signal)
        ).resolves.toMatchObject({
          finishReason: "stop",
        });
      });

      it(`rejects non-array response output values on completed events (${ISSUE})`, async () => {
        for (const output of [{ malformed: true }, "malformed"]) {
          const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(streamResponse(sse("response.completed", { response: { output } })));
          await expect(
            model(fetcher).complete([], new AbortController().signal)
          ).rejects.toMatchObject({ code: "internal" });
        }
      });

      it(`maps cancellation to a structured error and cleans up interrupted streams (${ISSUE})`, async () => {
        const controller = new AbortController();
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
          controller.abort();
          return streamResponse(sse("response.output_text.delta", { delta: "late" }));
        });
        await expect(model(fetcher).complete([], controller.signal)).rejects.toMatchObject({
          code: "cancelled",
        });
      });
    });
  });

  describe("LmStudioEmbeddingModel", () => {
    describe("embed()", () => {
      it("keeps embeddings on /embeddings with their existing batching and dimension checks", async () => {
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
          expect(input).toBe("http://127.0.0.1:1234/v1/embeddings");
          const values = JSON.parse(String(init?.body)).input as string[];
          return response({
            data: values.map((_, index) => ({ index, embedding: [1, 0] })),
          });
        });
        const embedding = new LmStudioEmbeddingModel({
          endpoint: "http://127.0.0.1:1234/v1",
          modelId: "embed",
          dimensions: 2,
          transport: new LmStudioTransport({ fetcher }),
        });
        await expect(embedding.embed(["a", "b"], new AbortController().signal)).resolves.toEqual([
          [1, 0],
          [1, 0],
        ]);
      });

      it("batches embeddings and restores each response index order", async () => {
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
          const values = JSON.parse(String(init?.body)).input as string[];
          return response({
            data: values.map((_, index) => ({
              index: values.length - index - 1,
              embedding: [values.length - index, 0],
            })),
          });
        });
        const embedding = new LmStudioEmbeddingModel({
          endpoint: "http://127.0.0.1:1234/v1",
          modelId: "embed",
          dimensions: 2,
          batchSize: 2,
          transport: new LmStudioTransport({ fetcher }),
        });
        await expect(
          embedding.embed(["a", "b", "c"], new AbortController().signal)
        ).resolves.toEqual([
          [1, 0],
          [2, 0],
          [1, 0],
        ]);
        expect(fetcher).toHaveBeenCalledTimes(2);
      });

      it("rejects embeddings with the wrong dimensions", async () => {
        const fetcher = vi
          .fn<typeof fetch>()
          .mockResolvedValue(response({ data: [{ index: 0, embedding: [1] }] }));
        const embedding = new LmStudioEmbeddingModel({
          endpoint: "http://127.0.0.1:1234/v1",
          modelId: "embed",
          dimensions: 2,
          transport: new LmStudioTransport({ fetcher }),
        });
        await expect(embedding.embed(["a"], new AbortController().signal)).rejects.toMatchObject({
          code: "internal",
        });
      });
    });
  });

  describe("LmStudioTransport", () => {
    describe("request()", () => {
      it(`reports the minimum LM Studio version for Responses endpoint failures (${ISSUE})`, async () => {
        for (const status of [404, 405]) {
          const transport = new LmStudioTransport({
            fetcher: vi.fn<typeof fetch>().mockResolvedValue(response({}, { status })),
          });
          await expect(
            transport.request(
              "http://127.0.0.1:1234/v1",
              "/responses",
              {},
              new AbortController().signal
            )
          ).rejects.toMatchObject({
            code: "unavailable",
            message: "LM Studio Responses API requires LM Studio 0.3.29 or newer.",
          });
        }
      });
    });
  });
});
