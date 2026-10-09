import { FakeToolCallingModel } from "langchain";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
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
      readNote: async (path) => ({ path, content: "private note body", startLine: 4, endLine: 7 }),
    });
    const first = await session.send({ content: "first question", attachmentPaths: ["source.md"] });
    expect(first.turns[0]).toMatchObject({
      attachments: [{ path: "source.md", startLine: 4, endLine: 7 }],
    });
    expect(first.turns[1]).toMatchObject({
      provenance: [{ path: "source.md", startLine: 4, endLine: 7 }],
    });

    await session.send({ content: "second question", attachmentPaths: [] });
    expect(model.inputs[0].join("\n")).toContain("private note body");
    const secondTurn = model.inputs.at(-1)?.join("\n") ?? "";
    expect(secondTurn).toContain("first question");
    expect(secondTurn).not.toContain("private note body");

    session.reset();
    expect(session.getState().turns).toEqual([]);
    await session.send({ content: "fresh question", attachmentPaths: [] });
    expect(model.inputs.at(-1)).toEqual(["fresh question"]);
  });

  it("projects a cancelled stream as stopped and rejects concurrent sends", async () => {
    let release!: () => void;
    class PendingModel extends FakeToolCallingModel {
      override bindTools() {
        return this;
      }
      override _generate(_messages: BaseMessage[]) {
        return new Promise<Awaited<ReturnType<FakeToolCallingModel["_generate"]>>>((resolve) => {
          release = () =>
            resolve({
              generations: [{ text: "partial", message: { content: "partial" } as never }],
            });
        });
      }
    }
    const session = new ChatSession(new PendingModel({ toolCalls: [[]] }), tools, {
      readNote: async (path) => ({ path, content: "" }),
    });
    const pending = session.send({ content: "cancel me", attachmentPaths: [] });
    await Promise.resolve();
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
});
