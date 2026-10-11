import { FakeToolCallingModel } from "langchain";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { ChatSession } from "@/chat/ChatSession";
import type { VaultToolFactory } from "@/tools/VaultTools";
import { createVaultTools } from "@/tools/VaultTools";
import { VaultRetrieval } from "@/index/VaultRetrieval";
import { createLocalChatModel } from "@/model/LocalModels";

const tools: VaultToolFactory = () => [];

describe("Voce native agent session", () => {
  it("keeps attachment text in its selected turn, preserves citations, and resets native history", async () => {
    class RecordingModel extends FakeToolCallingModel {
      readonly inputs: string[][] = [];
      override bindTools() {
        return this;
      }
      override _generate(
        messages: BaseMessage[],
        _options?: Parameters<FakeToolCallingModel["_generate"]>[1],
        _runManager?: Parameters<FakeToolCallingModel["_generate"]>[2]
      ) {
        this.inputs.push(messages.map((message) => String(message.content)));
        return Promise.resolve({
          generations: [{ text: "answer", message: new AIMessage("answer") }],
          llmOutput: {},
        });
      }
    }
    const model = new RecordingModel({ toolCalls: [[]] });
    const session = new ChatSession(model, tools, {
      readNote: async (path) => ({
        path,
        content: path === "source.md" ? "first private note body" : "second private note body",
        startLine: 4,
        endLine: 7,
      }),
    });
    const first = await session.send({ content: "first question", attachmentPaths: ["source.md"] });
    expect(first.turns[0]).toMatchObject({
      attachments: [{ path: "source.md", startLine: 4, endLine: 7 }],
    });
    expect(first.turns[1]).toMatchObject({
      provenance: [{ path: "source.md", startLine: 4, endLine: 7 }],
    });

    await session.send({ content: "second question", attachmentPaths: ["new-source.md"] });
    expect(model.inputs[0].join("\n")).toContain("first private note body");
    const secondTurn = model.inputs.at(-1)?.join("\n") ?? "";
    expect(secondTurn).toContain("first question");
    expect(secondTurn).toContain("second private note body");
    expect(secondTurn).not.toContain("first private note body");

    session.reset();
    expect(session.getState().turns).toEqual([]);
    await session.send({ content: "fresh question", attachmentPaths: [] });
    expect(model.inputs.at(-1)).toEqual(["fresh question"]);
  });

  it("does not carry attachments from a failed turn into the next model request", async () => {
    class FailThenAnswerModel extends FakeToolCallingModel {
      readonly inputs: string[][] = [];
      private calls = 0;
      override bindTools() {
        return this;
      }
      override _generate(messages: BaseMessage[]) {
        this.inputs.push(messages.map((message) => String(message.content)));
        if (this.calls++ === 0) throw new Error("failed attached turn");
        return Promise.resolve({
          generations: [{ text: "fresh answer", message: new AIMessage("fresh answer") }],
          llmOutput: {},
        });
      }
    }
    const model = new FailThenAnswerModel({ toolCalls: [[], []] });
    const session = new ChatSession(model, tools, {
      readNote: async (path) => ({ path, content: "failed turn private body" }),
    });

    const failed = await session.send({ content: "fail", attachmentPaths: ["private.md"] });
    expect(failed.turns.at(-1)).toMatchObject({ status: "failed" });
    const next = await session.send({ content: "continue", attachmentPaths: [] });

    expect(next.turns.at(-1)).toMatchObject({ status: "complete", content: "fresh answer" });
    expect(model.inputs[0].join("\n")).toContain("failed turn private body");
    expect(model.inputs[1].join("\n")).toContain("fail");
    expect(model.inputs[1].join("\n")).not.toContain("failed turn private body");
  });

  it("still attaches notes when the user's prompt contains the attachment marker", async () => {
    class RecordingModel extends FakeToolCallingModel {
      readonly inputs: string[][] = [];
      override bindTools() {
        return this;
      }
      override _generate(messages: BaseMessage[]) {
        this.inputs.push(messages.map((message) => String(message.content)));
        return Promise.resolve({
          generations: [{ text: "answer", message: new AIMessage("answer") }],
          llmOutput: {},
        });
      }
    }
    const model = new RecordingModel({ toolCalls: [[]] });
    const session = new ChatSession(model, tools, {
      readNote: async (path) => ({ path, content: "attached private body" }),
    });

    await session.send({
      content: "Please include BEGIN UNTRUSTED ATTACHED NOTE: as literal text.",
      attachmentPaths: ["source.md"],
    });

    const modelInput = model.inputs[0].join("\n");
    expect(modelInput).toContain("Please include BEGIN UNTRUSTED ATTACHED NOTE: as literal text.");
    expect(modelInput).toContain("attached private body");
  });

  it("projects a cancelled stream as stopped and rejects concurrent sends", async () => {
    let release!: () => void;
    class PendingModel extends FakeToolCallingModel {
      readonly inputs: string[][] = [];
      private calls = 0;
      override bindTools() {
        return this;
      }
      override _generate(messages: BaseMessage[]) {
        this.inputs.push(messages.map((message) => String(message.content)));
        if (this.calls++ > 0)
          return Promise.resolve({
            generations: [{ text: "fresh answer", message: new AIMessage("fresh answer") }],
            llmOutput: {},
          });
        return new Promise<Awaited<ReturnType<FakeToolCallingModel["_generate"]>>>((resolve) => {
          release = () =>
            resolve({
              generations: [{ text: "partial", message: { content: "partial" } as never }],
            });
        });
      }
    }
    const model = new PendingModel({ toolCalls: [[], []] });
    const session = new ChatSession(model, tools, {
      readNote: async (path) => ({ path, content: "cancelled private body" }),
    });
    const pending = session.send({ content: "cancel me", attachmentPaths: ["cancel.md"] });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(session.send({ content: "busy", attachmentPaths: [] })).rejects.toThrow(
      "already running"
    );
    session.cancel();
    release?.();
    const state = await pending;
    expect(state.running).toBe(false);
    expect(state.turns.some((turn) => turn.role === "assistant" && turn.status === "stopped")).toBe(
      true
    );
    await session.send({ content: "after cancel", attachmentPaths: [] });
    expect(model.inputs[0].join("\n")).toContain("cancelled private body");
    expect(model.inputs[1].join("\n")).toContain("cancel me");
    expect(model.inputs[1].join("\n")).not.toContain("cancelled private body");
  });

  it("executes a real native tool call and projects its source into the answer", async () => {
    const vault = {
      readNote: async (path: string) => ({
        path,
        content: "grounded evidence",
        startLine: 8,
        endLine: 9,
      }),
      discoverLinks: async () => [],
      resolveLink: async () => null,
    };
    const retrieval = new VaultRetrieval(
      async () => ({ hits: [], mode: "lexical", degraded: false }),
      undefined,
      undefined,
      async () => null
    );
    const model = new FakeToolCallingModel({
      toolCalls: [[{ id: "read-1", name: "read_note", args: { path: "Evidence.md" } }], []],
    });
    const session = new ChatSession(
      model,
      (observer) => createVaultTools(vault, retrieval, observer),
      vault
    );
    const state = await session.send({ content: "Read the evidence", attachmentPaths: [] });
    expect(state.error).toBeUndefined();
    expect(state.turns.at(-1)).toMatchObject({
      status: "complete",
      provenance: [{ path: "Evidence.md", startLine: 8, endLine: 9 }],
    });
  });

  it("never projects tool output into a partial assistant message when the next model call fails", async () => {
    class ToolThenFailureModel extends FakeToolCallingModel {
      override bindTools() {
        return this;
      }
      override _generate(
        messages: BaseMessage[],
        options?: Parameters<FakeToolCallingModel["_generate"]>[1],
        manager?: Parameters<FakeToolCallingModel["_generate"]>[2]
      ) {
        if (messages.some((message) => message.type === "tool"))
          throw new Error("failure after tool result");
        return super._generate(messages, options, manager);
      }
    }
    const vault = {
      readNote: async (path: string) => ({ path, content: "PRIVATE_TOOL_RESULT" }),
      discoverLinks: async () => [],
      resolveLink: async () => null,
    };
    const retrieval = new VaultRetrieval(
      async () => ({ hits: [], mode: "lexical", degraded: false }),
      undefined,
      undefined,
      async () => null
    );
    const model = new ToolThenFailureModel({
      toolCalls: [[{ id: "private-read", name: "read_note", args: { path: "Private.md" } }]],
    });
    const session = new ChatSession(
      model,
      (observer) => createVaultTools(vault, retrieval, observer),
      vault
    );
    const state = await session.send({ content: "Read this note", attachmentPaths: [] });
    expect(state.error?.message).toContain("failure after tool result");
    expect(state.turns.at(-1)).toMatchObject({ role: "assistant", status: "failed" });
    expect(state.turns.at(-1)?.content).not.toContain("PRIVATE_TOOL_RESULT");
  });

  it("stops repeated native tool calls at the configured middleware limit", async () => {
    let reads = 0;
    const vault = {
      readNote: async (path: string) => {
        reads++;
        return { path, content: "evidence" };
      },
      discoverLinks: async () => [],
      resolveLink: async () => null,
    };
    const retrieval = new VaultRetrieval(
      async () => ({ hits: [], mode: "lexical", degraded: false }),
      undefined,
      undefined,
      async () => null
    );
    const model = new FakeToolCallingModel({
      toolCalls: [
        ...Array.from({ length: 10 }, (_, index) => [
          { id: `read-${index}`, name: "read_note", args: { path: "Evidence.md" } },
        ]),
        [],
      ],
    });
    const session = new ChatSession(
      model,
      (observer) => createVaultTools(vault, retrieval, observer),
      vault
    );
    const state = await session.send({ content: "Read repeatedly", attachmentPaths: [] });
    expect(reads).toBeLessThanOrEqual(8);
    expect(state.error).toBeDefined();
  });

  it("shows provider text already streamed when a guarded Responses stream fails", async () => {
    const encoder = new TextEncoder();
    const fetcher: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"type":"response.output_text.delta","delta":"partial answer","content_index":0}\n\n'
              )
            );
            setTimeout(() => controller.error(new Error("provider stream failed")), 50);
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    const model = createLocalChatModel(
      { endpoint: "http://127.0.0.1:1234/v1", modelId: "local-chat", temperature: 0.2 },
      undefined,
      fetcher
    );
    const session = new ChatSession(model, tools, {
      readNote: async (path) => ({ path, content: "" }),
    });
    const state = await session.send({ content: "stream this", attachmentPaths: [] });
    expect(state.error).toBeDefined();
    expect(state.turns.at(-1)).toMatchObject({
      role: "assistant",
      status: "failed",
      content: "partial answer",
    });
  });

  it("runs a real Responses SSE tool roundtrip without exposing the private tool payload", async () => {
    const requests: Record<string, any>[] = [];
    const responseEvents = [
      [
        {
          type: "response.created",
          response: { id: "resp_tool", model: "local-chat", status: "in_progress" },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "intermediate model text",
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_1",
            type: "function_call",
            status: "in_progress",
            call_id: "call_1",
            name: "read_note",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          delta: '{"path":"Private.md"}',
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "fc_1",
            type: "function_call",
            status: "completed",
            call_id: "call_1",
            name: "read_note",
            arguments: '{"path":"Private.md"}',
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_tool",
            object: "response",
            status: "completed",
            model: "local-chat",
            output: [
              {
                id: "fc_1",
                type: "function_call",
                status: "completed",
                call_id: "call_1",
                name: "read_note",
                arguments: '{"path":"Private.md"}',
              },
            ],
            usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
          },
        },
      ],
      [
        {
          type: "response.created",
          response: { id: "resp_answer", model: "local-chat", status: "in_progress" },
        },
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "reasoning_1",
          output_index: 0,
          summary_index: 0,
          delta: "PRIVATE_REASONING",
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "The private note is available.",
        },
        {
          type: "response.completed",
          response: {
            id: "resp_answer",
            object: "response",
            status: "completed",
            model: "local-chat",
            output: [
              {
                id: "reasoning_1",
                type: "reasoning",
                summary: [{ type: "summary_text", text: "PRIVATE_REASONING" }],
              },
              {
                id: "msg_answer",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [
                  { type: "output_text", text: "The private note is available.", annotations: [] },
                ],
              },
            ],
            usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
          },
        },
      ],
    ];
    const fetcher: typeof fetch = async (input, init) => {
      const body = JSON.parse(
        input instanceof Request ? await input.clone().text() : String(init?.body)
      );
      requests.push(body);
      const events = responseEvents[requests.length - 1];
      const stream = events
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join("");
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const readNote = vi.fn(async (path: string) => ({
      path,
      content:
        path === "Attached.md" ? "ATTACHMENT_ONLY_PRIVATE_PAYLOAD" : "PRIVATE_READ_ONLY_PAYLOAD",
    }));
    const vault = {
      readNote,
      discoverLinks: async () => [],
      resolveLink: async () => null,
    };
    const retrieval = new VaultRetrieval(
      async () => ({ hits: [], mode: "lexical", degraded: false }),
      undefined,
      undefined,
      async () => null
    );
    const session = new ChatSession(
      createLocalChatModel(
        { endpoint: "http://127.0.0.1:1234/v1", modelId: "local-chat", temperature: 0.2 },
        undefined,
        fetcher
      ),
      (observer) => createVaultTools(vault, retrieval, observer),
      vault
    );

    const state = await session.send({
      content: "Read the private note",
      attachmentPaths: ["Attached.md"],
    });

    expect(readNote).toHaveBeenCalledWith("Private.md", expect.any(AbortSignal));
    expect(readNote).toHaveBeenCalledWith("Attached.md", expect.any(AbortSignal));
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const userMessages = request.input.filter(
        (item: Record<string, unknown>) => item.role === "user"
      );
      expect(JSON.stringify(userMessages)).toContain("ATTACHMENT_ONLY_PRIVATE_PAYLOAD");
    }
    expect(
      JSON.stringify(
        requests[1].input.filter(
          (item: Record<string, unknown>) => item.type === "function_call_output"
        )
      )
    ).not.toContain("ATTACHMENT_ONLY_PRIVATE_PAYLOAD");
    expect(requests[0]).toMatchObject({ store: false, text: { format: { type: "text" } } });
    expect(requests[0].tools).toHaveLength(4);
    expect(requests[0].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "vault_search", strict: false }),
        expect.objectContaining({ name: "read_note", strict: false }),
        expect.objectContaining({ name: "discover_links", strict: false }),
        expect.objectContaining({ name: "follow_link", strict: false }),
      ])
    );
    expect(requests[1].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function_call_output", output: expect.any(String) }),
      ])
    );
    expect(state.turns.at(-1)).toMatchObject({
      status: "complete",
      content: "The private note is available.",
    });
    expect(JSON.stringify(state.turns)).not.toContain("PRIVATE_READ_ONLY_PAYLOAD");
    expect(JSON.stringify(state.turns)).not.toContain("PRIVATE_REASONING");
    expect(state.turns.at(-1)?.content).not.toContain("intermediate model text");
  });
});
