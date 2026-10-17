import { describe, expect, it, vi } from "vitest";
import {
  createLocalChatModel,
  createLocalEmbeddings,
  discoverLocalModels,
} from "@/model/LocalModels";
import { DEFAULT_SETTINGS } from "@/settings/Settings";

const endpoint = "http://127.0.0.1:1234/v1";

describe("guarded local OpenAI chat", () => {
  it("uses the Responses API without storing requests and preserves explicit reasoning none", async () => {
    let body: Record<string, unknown> | undefined;
    let requestURL = "";
    const model = createLocalChatModel(
      { ...DEFAULT_SETTINGS.chat, modelId: "local-chat", reasoningEffort: "none" },
      undefined,
      async (input, init) => {
        requestURL = input instanceof Request ? input.url : String(input);
        body = JSON.parse(String(init?.body));
        return Response.json({
          id: "resp_test",
          object: "response",
          status: "completed",
          output: [
            {
              id: "msg_test",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "ready", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }
    );
    const result = await model.invoke("hello");
    expect(result.text).toBe("ready");
    expect(requestURL).toBe(`${endpoint}/responses`);
    expect(body).toMatchObject({
      store: false,
      model: "local-chat",
      text: { format: { type: "text" } },
      reasoning: { effort: "none" },
    });
  });

  it.each(["none", "minimal", "low", "medium", "high", "xhigh"] as const)(
    "sends supported reasoning effort %s through model kwargs",
    async (effort) => {
      let body: Record<string, unknown> | undefined;
      const modelId = "local-chat";
      const model = createLocalChatModel(
        { ...DEFAULT_SETTINGS.chat, modelId, reasoningEffort: effort },
        undefined,
        async (_input, init) => {
          body = JSON.parse(String(init?.body));
          return Response.json({
            id: "resp_effort",
            object: "response",
            status: "completed",
            output: [
              {
                id: "msg_effort",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "ready", annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          });
        }
      );
      await model.invoke("hello");
      expect(body).toMatchObject({
        model: modelId,
        reasoning: { effort },
      });
      expect(body).not.toHaveProperty("reasoning_effort");
    }
  );

  it("omits automatic reasoning", async () => {
    let body: Record<string, unknown> | undefined;
    const model = createLocalChatModel(
      { ...DEFAULT_SETTINGS.chat, modelId: "local-chat" },
      undefined,
      async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({
          id: "resp_auto",
          object: "response",
          status: "completed",
          output: [
            {
              id: "msg_auto",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "ready", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }
    );
    await model.invoke("hello");
    expect(body).not.toHaveProperty("reasoning");
  });

  it("rejects redirects from the local chat endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:1234/v1/other" },
        })
    );
    const model = createLocalChatModel(
      { ...DEFAULT_SETTINGS.chat, modelId: "local-chat" },
      undefined,
      fetcher
    );
    await expect(model.invoke("hello")).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
  });

  it("discovers model IDs only on explicit request through the guarded endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ id: "chat-local" }, { id: "embed-local" }] })
    );
    const pending = discoverLocalModels(endpoint, undefined, fetcher);
    await expect(pending).resolves.toEqual(["chat-local", "embed-local"]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0])).toContain("/v1/models");
  });

  it("allows explicit model discovery in the browser-like Obsidian renderer", async () => {
    vi.stubGlobal("window", { document: {} });
    vi.stubGlobal("navigator", { userAgent: "Obsidian" });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "local" }] }));
    try {
      await expect(discoverLocalModels(endpoint, undefined, fetcher)).resolves.toEqual(["local"]);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("guarded local OpenAI embeddings", () => {
  it("makes no startup requests and preserves raw newlines and response indexes", async () => {
    const requests: { input: string[]; stripNewLines?: boolean; encoding_format?: string }[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const body = JSON.parse(
        input instanceof Request ? await input.clone().text() : String(init?.body)
      );
      requests.push(body);
      const inputs = body.input as string[];
      return Response.json({
        object: "list",
        data: inputs
          .map((_, index) => ({ object: "embedding", index, embedding: [index + 1, 1] }))
          .reverse(),
        model: "test-model",
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      });
    });
    const embeddings = createLocalEmbeddings({
      endpoint,
      modelId: "test-model",
      dimensions: 2,
      fetcher,
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(embeddings.embedDocuments(["line one\nline two", "second"])).resolves.toEqual([
      [1, 1],
      [2, 1],
    ]);
    expect(requests[0]).toMatchObject({
      input: ["line one\nline two", "second"],
      encoding_format: "float",
      model: "test-model",
      dimensions: 2,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects unapproved endpoints and redirects without following them", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:1234/v1/elsewhere" },
        })
    );
    expect(() =>
      createLocalEmbeddings({
        endpoint: "https://example.com/v1",
        modelId: "m",
        dimensions: 2,
        fetcher,
      })
    ).toThrow(/loopback|approved/i);
    const embeddings = createLocalEmbeddings({ endpoint, modelId: "m", dimensions: 2, fetcher });
    await expect(embeddings.embedDocuments(["x"])).rejects.toThrow(/redirect/i);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("composes the run cancellation signal with the SDK signal", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
          if (init?.signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
        })
    );
    const embeddings = createLocalEmbeddings({ endpoint, modelId: "m", dimensions: 2, fetcher });
    const controller = new AbortController();
    const pending = embeddings.withSignal(controller.signal).embedDocuments(["x"]);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps concurrent operation cancellation signals independent", async () => {
    let requestCount = 0;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      requestCount++;
      if (requestCount === 1)
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        });
      return Response.json({
        data: [{ index: 0, embedding: [1, 0] }],
        model: "m",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    });
    const provider = createLocalEmbeddings({ endpoint, modelId: "m", dimensions: 2, fetcher });
    const indexing = new AbortController();
    const querying = new AbortController();
    const indexRequest = provider.withSignal(indexing.signal).embedDocuments(["index"]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const queryRequest = provider.withSignal(querying.signal).embedQuery("query");
    indexing.abort();
    await expect(indexRequest).rejects.toBeDefined();
    await expect(queryRequest).resolves.toEqual([1, 0]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid response indexes and dimensions", async () => {
    for (const data of [
      [
        { index: 0, embedding: [1, 0] },
        { index: 0, embedding: [0, 1] },
      ],
      [{ index: 0, embedding: [1] }],
    ]) {
      const embeddings = createLocalEmbeddings({
        endpoint,
        modelId: "m",
        dimensions: 2,
        fetcher: async () =>
          Response.json({ data, model: "m", usage: { prompt_tokens: 1, total_tokens: 1 } }),
      });
      await expect(embeddings.embedDocuments(["a", "b"])).rejects.toThrow(/embedding/i);
    }
  });
});
