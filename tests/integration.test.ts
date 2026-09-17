import { describe, expect, it, vi } from "vitest";
import { ChatSession } from "@/chat/ChatSession";
import { ChatModel, ChatResponse, ReadonlyVault } from "@/domain/contracts";
import { IndexManager } from "@/index/IndexManager";
import { createTestSqliteClient } from "./sqlite-test-client";
import { ToolRegistry, ReadNoteTool, FollowLinkTool, VaultSearchTool } from "@/tools/ToolRegistry";
import { LmStudioChatModel } from "@/providers/lmStudio/LmStudioChatModel";
import { LmStudioEmbeddingModel } from "@/providers/lmStudio/LmStudioEmbeddingModel";
import { LmStudioTransport } from "@/providers/lmStudio/LmStudioTransport";
import { EndpointPolicy } from "@/security/EndpointPolicy";

class FakeEmbedding {
  readonly dimensions = 2;
  async embed(texts: readonly string[]): Promise<readonly number[][]> {
    return texts.map((text) => [text.length, text.includes("alpha") ? 1 : 0]);
  }
}

const vault: ReadonlyVault = {
  async readNote(path) {
    return { path, content: `alpha from ${path}`, startLine: 1, endLine: 1 };
  },
  async currentNotePath() {
    return "A.md";
  },
  async resolveLink(link) {
    return link === "B" ? "B.md" : null;
  },
  async discoverLinks() {
    return [{ link: "B", sourcePath: "A.md", targetPath: "B.md" }];
  },
};

describe("integration composition seams", () => {
  it("surfaces SQLite as unavailable when the packaged mobile runtime cannot start", async () => {
    const index = new IndexManager(
      {
        listMarkdownPaths: async () => [],
        readMarkdown: async () => ({ path: "missing.md", content: "" }),
      },
      new FakeEmbedding(),
      "http://127.0.0.1:1234/v1",
      "embed-v1",
      {
        workerFactory: () => {
          throw new Error("WASM unavailable");
        },
      }
    );

    await expect(index.load()).resolves.toBe(false);
    expect(index.capabilities()).toMatchObject({
      availability: "unavailable",
      lexical: { state: "unavailable", activity: "idle", searchable: false },
      semantic: { state: "unavailable", activity: "idle", searchable: false },
    });
  });

  it("builds, persists, reloads, and searches a semantic index without network", async () => {
    const embedding = new FakeEmbedding();
    const storage = {};
    const port = {
      async listMarkdownPaths() {
        return ["A.md", "B.md"];
      },
      async readMarkdown(path: string) {
        return { path, content: `alpha ${path}` };
      },
    };
    const sqliteClient = createTestSqliteClient(storage);
    const first = new IndexManager(port, embedding, "http://127.0.0.1:1234/v1", "embed-v1", {
      sqliteClient,
    });
    await first.build(new AbortController().signal);
    expect(await first.search("alpha", new AbortController().signal, 10)).toHaveLength(2);
    const restarted = new IndexManager(port, embedding, "http://127.0.0.1:1234/v1", "embed-v1", {
      sqliteClient: createTestSqliteClient(storage),
    });
    expect(await restarted.load()).toBe(true);
  });

  it("runs a multi-round read/follow turn and exposes accessed-note provenance", async () => {
    const responses: ChatResponse[] = [
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "r", name: "read_note", arguments: { path: "A.md" } }],
        },
        finishReason: "tool_calls",
      },
      {
        message: {
          role: "assistant",
          content: "See B",
          toolCalls: [
            { id: "f", name: "follow_link", arguments: { link: "B", sourcePath: "A.md" } },
          ],
        },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant", content: "done" }, finishReason: "stop" },
    ];
    const model: ChatModel = { complete: vi.fn(async () => responses.shift()!) };
    const registry = new ToolRegistry([
      new ReadNoteTool(vault),
      new FollowLinkTool(vault),
      new VaultSearchTool({
        vaultSearchState: () => ({
          changeCounter: 1,
          generationId: "test",
          semantic: { state: "empty", activity: "idle", searchable: false },
        }),
        retrieveVaultCandidates: async () => [],
      }),
    ]);
    const state = await new ChatSession(model, registry, vault).send({
      content: "trace links",
      attachmentPaths: [],
    });
    expect(state.turns[1]).toMatchObject({
      provenance: [{ path: "A.md" }, { path: "A.md" }, { path: "B.md" }],
    });
  });

  it("propagates cancellation through an in-flight chat turn", async () => {
    let reject!: (error: Error) => void;
    const model: ChatModel = {
      complete: vi.fn(
        () =>
          new Promise<ChatResponse>((_, fail) => {
            reject = fail;
          })
      ),
    };
    const session = new ChatSession(model, new ToolRegistry([]), vault);
    const pending = session.send({ content: "cancel me", attachmentPaths: [] });
    await vi.waitFor(() => expect(model.complete).toHaveBeenCalled());
    session.cancel();
    reject(new Error("aborted"));
    expect((await pending).error?.code).toBe("cancelled");
  });

  it("keeps chat and embedding requests on the newly approved local origin", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL) => {
      urls.push(String(input));
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
          'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });
    const policy = new EndpointPolicy();
    const transport = new LmStudioTransport({ fetcher: fetcher as typeof fetch, policy });
    const chat = new LmStudioChatModel({
      endpoint: "http://127.0.0.1:2345/v1",
      modelId: "chat-new",
      transport,
    });
    await chat.complete([{ role: "user", content: "hello" }], new AbortController().signal);
    const embedding = new LmStudioEmbeddingModel({
      endpoint: "http://127.0.0.1:2345/v1",
      modelId: "embed-new",
      dimensions: 2,
      transport,
    });
    fetcher.mockImplementationOnce(async (input: string | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0], index: 0 }] }), {
        status: 200,
      });
    });
    await embedding.embed(["hello"], new AbortController().signal);
    expect(urls).toEqual([
      "http://127.0.0.1:2345/v1/responses",
      "http://127.0.0.1:2345/v1/embeddings",
    ]);
    expect(urls.every((url) => url.startsWith("http://127.0.0.1:2345/v1/"))).toBe(true);
  });

  it("replays a complete tool round with its matching function output", async () => {
    const sse = (type: string, value: Record<string, unknown> = {}) =>
      `data: ${JSON.stringify({ type, ...value })}\n\n`;
    const firstResponse =
      sse("response.output_item.added", {
        item: { type: "function_call", id: "item-1", call_id: "call-1", name: "read_note" },
      }) +
      sse("response.function_call_arguments.done", {
        call_id: "call-1",
        item_id: "item-1",
        arguments: '{"path":"A.md"}',
      }) +
      sse("response.completed", {
        response: {
          status: "completed",
          output: [
            {
              type: "function_call",
              id: "item-1",
              call_id: "call-1",
              name: "read_note",
              arguments: '{"path":"A.md"}',
            },
          ],
        },
      });
    const secondResponse =
      sse("response.output_text.delta", { delta: "done" }) +
      sse("response.completed", { response: { status: "completed" } });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(firstResponse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
      .mockResolvedValueOnce(
        new Response(secondResponse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      );
    const transport = new LmStudioTransport({ fetcher });
    const chat = new LmStudioChatModel({
      endpoint: "http://127.0.0.1:2345/v1",
      modelId: "chat-new",
      transport,
    });
    const session = new ChatSession(
      chat,
      new ToolRegistry([
        new ReadNoteTool(vault),
        new VaultSearchTool({
          vaultSearchState: () => ({
            changeCounter: 1,
            generationId: "test",
            semantic: { state: "empty", activity: "idle", searchable: false },
          }),
          retrieveVaultCandidates: async () => [],
        }),
      ]),
      vault
    );

    const state = await session.send({ content: "read A", attachmentPaths: [] });
    const secondInput = JSON.parse(String(fetcher.mock.calls[1][1]?.body)).input;
    expect(state.turns.at(-1)?.content).toBe("done");
    expect(secondInput).toContainEqual({
      type: "function_call",
      call_id: "call-1",
      name: "read_note",
      arguments: '{"path":"A.md"}',
    });
    expect(secondInput).toContainEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: expect.any(String),
    });
  });

  it("does not expose write capabilities through the projected vault", async () => {
    const writes = { create: 0, modify: 0, delete: 0, rename: 0, write: 0 };
    const projected = { ...vault };
    await projected.readNote("A.md", new AbortController().signal);
    await projected.currentNotePath(new AbortController().signal);
    expect(writes).toEqual({ create: 0, modify: 0, delete: 0, rename: 0, write: 0 });
    expect("create" in projected || "modify" in projected || "delete" in projected).toBe(false);
  });
});
