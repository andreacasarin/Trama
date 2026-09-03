import { describe, expect, it, vi } from "vitest";
import { ChatModel, ChatResponse } from "@/domain/contracts";
import { CHAT_LIMITS, ChatSession } from "@/chat/ChatSession";
import { ReadonlyTool, ToolRegistry, ToolResult } from "@/tools/ToolRegistry";

const tool = (
  name: string,
  run: ReadonlyTool["execute"],
  properties: Readonly<Record<string, unknown>> = {}
): ReadonlyTool => ({
  definition: {
    name,
    description: name,
    inputSchema: { type: "object", properties, additionalProperties: false },
  },
  execute: run,
});
const response = (
  message: ChatResponse["message"],
  finishReason: ChatResponse["finishReason"]
): ChatResponse => ({ message, finishReason });

describe("ChatSession module", () => {
  describe("ChatSession", () => {
    describe("send()", () => {
      it("returns a normal assistant response without tools", async () => {
        const model: ChatModel = {
          complete: vi
            .fn()
            .mockResolvedValue(response({ role: "assistant", content: "Hi" }, "stop")),
        };
        const state = await new ChatSession(model, new ToolRegistry([])).send("Hello");
        expect(state.messages.map((m) => m.content)).toEqual(["Hello", "Hi"]);
      });

      it("publishes incremental assistant text while the model is running", async () => {
        let release!: () => void;
        const model: ChatModel = {
          complete: vi.fn(async (_messages, _signal, _tools, onText) => {
            onText?.("Hello");
            await new Promise<void>((resolve) => (release = resolve));
            onText?.(" world");
            return response({ role: "assistant", content: "Hello world" }, "stop");
          }),
        };
        const session = new ChatSession(model, new ToolRegistry([]));
        const states: string[][] = [];
        session.subscribe((state) => states.push(state.messages.map((message) => message.content)));
        const pending = session.send("go");
        await vi.waitFor(() => expect(states).toContainEqual(["go", "Hello"]));
        release();
        const state = await pending;
        expect(state.messages.map((message) => message.content)).toEqual(["go", "Hello world"]);
        expect(states).toContainEqual(["go", "Hello world"]);
      });

      it("executes tool calls across rounds and aggregates provenance", async () => {
        const model: ChatModel = {
          complete: vi
            .fn()
            .mockResolvedValueOnce(
              response(
                {
                  role: "assistant",
                  content: "",
                  toolCalls: [{ id: "1", name: "read", arguments: {} }],
                },
                "tool_calls"
              )
            )
            .mockResolvedValueOnce(response({ role: "assistant", content: "Done" }, "stop")),
        };
        const state = await new ChatSession(
          model,
          new ToolRegistry([
            tool("read", async () => ({ ok: true, data: "note", provenance: [{ path: "a.md" }] })),
          ])
        ).send("Read it");
        expect(state.messages.map((m) => m.role)).toEqual([
          "user",
          "assistant",
          "tool",
          "assistant",
        ]);
        expect(state.accessedNotes).toEqual([{ path: "a.md" }]);
      });

      it("turns unknown calls into recoverable structured tool errors", async () => {
        const model: ChatModel = {
          complete: vi
            .fn()
            .mockResolvedValueOnce(
              response(
                {
                  role: "assistant",
                  content: "",
                  toolCalls: [{ id: "x", name: "missing", arguments: {} }],
                },
                "tool_calls"
              )
            )
            .mockResolvedValueOnce(response({ role: "assistant", content: "Recovered" }, "stop")),
        };
        const state = await new ChatSession(model, new ToolRegistry([])).send("Try");
        expect(state.messages[2].content).toContain("Unknown tool");
        expect(state.messages[3].content).toBe("Recovered");
      });

      it("ends after four model/tool rounds with an explicit explanation", async () => {
        const model: ChatModel = {
          complete: vi.fn().mockResolvedValue(
            response(
              {
                role: "assistant",
                content: "",
                toolCalls: [{ id: "x", name: "missing", arguments: {} }],
              },
              "tool_calls"
            )
          ),
        };
        const state = await new ChatSession(model, new ToolRegistry([])).send("loop");
        expect(model.complete).toHaveBeenCalledTimes(CHAT_LIMITS.maxRounds);
        expect(state.messages.at(-1)?.content).toContain("round limit");
      });

      it("ends when eight calls are exhausted", async () => {
        const calls = Array.from({ length: 3 }, (_, i) => ({
          id: String(i),
          name: "missing",
          arguments: {},
        }));
        const model: ChatModel = {
          complete: vi
            .fn()
            .mockResolvedValue(
              response({ role: "assistant", content: "", toolCalls: calls }, "tool_calls")
            ),
        };
        const state = await new ChatSession(model, new ToolRegistry([])).send("many");
        expect(state.messages.at(-1)?.content).toContain("tool-call limit");
      });

      it("reports malformed arguments and preserves failed-tool provenance", async () => {
        const model: ChatModel = {
          complete: vi
            .fn()
            .mockResolvedValueOnce(
              response(
                {
                  role: "assistant",
                  content: "",
                  toolCalls: [{ id: "x", name: "read", arguments: { extra: true } }],
                },
                "tool_calls"
              )
            )
            .mockResolvedValueOnce(response({ role: "assistant", content: "recovered" }, "stop")),
        };
        const state = await new ChatSession(
          model,
          new ToolRegistry([
            tool("read", async () => ({
              ok: false,
              error: { code: "unavailable", message: "nope", retryable: true },
              provenance: [{ path: "failed.md" }],
            })),
          ])
        ).send("bad");
        expect(state.messages[2].content).toContain("Unknown argument");
        expect(state.accessedNotes).toEqual([]);
      });

      it("limits concurrent tools, preserves result order, and records duplicates", async () => {
        let active = 0;
        let maximum = 0;
        let executions = 0;
        const read = tool(
          "read",
          async (input) => {
            active++;
            maximum = Math.max(maximum, active);
            executions++;
            await Promise.resolve();
            active--;
            return { ok: true, data: input, provenance: [{ path: `${executions}.md` }] };
          },
          { n: { type: "number" } }
        );
        const calls = Array.from({ length: 8 }, (_, i) => ({
          id: String(i),
          name: "read",
          arguments: i < 2 ? { n: 1 } : { n: i },
        }));
        const model: ChatModel = {
          complete: vi
            .fn()
            .mockResolvedValueOnce(
              response({ role: "assistant", content: "", toolCalls: calls }, "tool_calls")
            )
            .mockResolvedValueOnce(response({ role: "assistant", content: "done" }, "stop")),
        };
        const state = await new ChatSession(model, new ToolRegistry([read])).send("batch");
        expect(maximum).toBeLessThanOrEqual(CHAT_LIMITS.maxConcurrentTools);
        expect(state.activities).toHaveLength(8);
        expect(state.messages.slice(2, 10).map((m) => m.toolCallId)).toEqual(
          calls.map((c) => c.id)
        );
        expect(executions).toBe(7);
      });

      it("passes immutable definitions to the model", async () => {
        let definitions!: readonly unknown[];
        const model: ChatModel = {
          complete: vi.fn(async (_messages, _signal, tools) => {
            definitions = tools!;
            return response({ role: "assistant", content: "ok" }, "stop");
          }),
        };
        await new ChatSession(
          model,
          new ToolRegistry([tool("read", async () => ({ ok: true, provenance: [] }))])
        ).send("defs");
        expect(Object.isFrozen(definitions)).toBe(true);
        expect(Object.isFrozen(definitions[0])).toBe(true);
      });

      it("ends with an explicit explanation when accumulated tool content is too large", async () => {
        const model: ChatModel = {
          complete: vi.fn().mockResolvedValueOnce(
            response(
              {
                role: "assistant",
                content: "",
                toolCalls: [{ id: "large", name: "read", arguments: {} }],
              },
              "tool_calls"
            )
          ),
        };
        const state = await new ChatSession(
          model,
          new ToolRegistry([
            tool("read", async () => ({
              ok: true,
              data: "x".repeat(33_000),
              provenance: [{ path: "large.md" }],
            })),
          ])
        ).send("large");
        expect(state.messages.at(-1)?.content).toContain("tool-result content limit");
        expect(state.accessedNotes).toEqual([{ path: "large.md" }]);
      });

      it("aggregates provenance from both successful and failed tools", async () => {
        const model: ChatModel = {
          complete: vi
            .fn()
            .mockResolvedValueOnce(
              response(
                {
                  role: "assistant",
                  content: "",
                  toolCalls: [
                    { id: "ok", name: "read", arguments: {} },
                    { id: "failed", name: "fail", arguments: {} },
                  ],
                },
                "tool_calls"
              )
            )
            .mockResolvedValueOnce(response({ role: "assistant", content: "done" }, "stop")),
        };
        const state = await new ChatSession(
          model,
          new ToolRegistry([
            tool("read", async () => ({ ok: true, data: "ok", provenance: [{ path: "ok.md" }] })),
            tool("fail", async () => ({
              ok: false,
              error: { code: "unavailable", message: "failed", retryable: true },
              provenance: [{ path: "failed.md" }],
            })),
          ])
        ).send("sources");
        expect(state.accessedNotes).toEqual([{ path: "ok.md" }, { path: "failed.md" }]);
        expect(state.activities.map((activity) => activity.status)).toEqual(["success", "error"]);
      });

      it("keeps each completed answer's sources separate from later tool turns", async () => {
        const model: ChatModel = {
          complete: vi
            .fn()
            .mockResolvedValueOnce(
              response(
                {
                  role: "assistant",
                  content: "",
                  toolCalls: [{ id: "a", name: "read", arguments: { path: "a.md" } }],
                },
                "tool_calls"
              )
            )
            .mockResolvedValueOnce(response({ role: "assistant", content: "Answer A" }, "stop"))
            .mockResolvedValueOnce(
              response(
                {
                  role: "assistant",
                  content: "",
                  toolCalls: [{ id: "b", name: "read", arguments: { path: "b.md" } }],
                },
                "tool_calls"
              )
            )
            .mockResolvedValueOnce(response({ role: "assistant", content: "Answer B" }, "stop")),
        };
        const session = new ChatSession(
          model,
          new ToolRegistry([
            tool(
              "read",
              async (input) => {
                const path = (input as { readonly path: string }).path;
                return {
                  ok: true,
                  provenance: [{ path, startLine: 2, endLine: 3 }],
                };
              },
              { path: { type: "string" } }
            ),
          ])
        );

        await session.send("first");
        const state = await session.send("second");
        const assistantMessages = state.messages.filter(
          (message) => message.role === "assistant" && !message.toolCalls
        );
        expect(assistantMessages[0].provenance).toEqual([
          { path: "a.md", startLine: 2, endLine: 3 },
        ]);
        expect(assistantMessages[1].provenance).toEqual([
          { path: "b.md", startLine: 2, endLine: 3 },
        ]);
        expect(
          state.messages
            .filter((message) => message.role === "assistant" && message.toolCalls)
            .every((message) => !message.provenance)
        ).toBe(true);
      });

      it("deduplicates ranges and leaves a no-tool answer without newly accessed sources", async () => {
        const model: ChatModel = {
          complete: vi
            .fn()
            .mockResolvedValueOnce(
              response(
                {
                  role: "assistant",
                  content: "",
                  toolCalls: [{ id: "read", name: "read", arguments: {} }],
                },
                "tool_calls"
              )
            )
            .mockResolvedValueOnce(response({ role: "assistant", content: "first" }, "stop"))
            .mockResolvedValueOnce(response({ role: "assistant", content: "second" }, "stop")),
        };
        const session = new ChatSession(
          model,
          new ToolRegistry([
            tool("read", async () => ({
              ok: true,
              provenance: [
                { path: "a.md", startLine: 1, endLine: 2 },
                { path: "a.md", startLine: 1, endLine: 2 },
                { path: "a.md", startLine: 3, endLine: 4 },
              ],
            })),
          ])
        );
        expect((await session.send("sources")).accessedNotes).toEqual([
          { path: "a.md", startLine: 1, endLine: 2 },
          { path: "a.md", startLine: 3, endLine: 4 },
        ]);
        const followUp = await session.send("follow up");
        expect(followUp.accessedNotes).toEqual([]);
        expect(followUp.messages.at(-1)?.provenance).toEqual([]);
      });
    });

    describe("cancel()", () => {
      it("cancels an in-flight model request", async () => {
        let reject!: (error: Error) => void;
        let signal!: AbortSignal;
        const model: ChatModel = {
          complete: vi.fn((_messages, requestSignal) => {
            signal = requestSignal;
            return new Promise<ChatResponse>((_, r) => (reject = r));
          }),
        };
        const session = new ChatSession(model, new ToolRegistry([]));
        const pending = session.send("wait");
        session.cancel();
        expect(signal.aborted).toBe(true);
        reject(new Error("aborted"));
        expect((await pending).error?.code).toBe("cancelled");
      });

      it("returns a deterministic busy error for overlapping turns and suppresses late tool completion", async () => {
        let finishTool!: (result: ToolResult) => void;
        const model: ChatModel = {
          complete: vi.fn().mockResolvedValue(
            response(
              {
                role: "assistant",
                content: "",
                toolCalls: [{ id: "1", name: "read", arguments: {} }],
              },
              "tool_calls"
            )
          ),
        };
        const session = new ChatSession(
          model,
          new ToolRegistry([
            tool(
              "read",
              () =>
                new Promise((resolve) => {
                  finishTool = resolve as typeof finishTool;
                })
            ),
          ])
        );
        const pending = session.send("wait");
        await expect(session.send("busy")).rejects.toMatchObject({ code: "busy" });
        session.cancel();
        finishTool({ ok: true, data: "late", provenance: [] });
        expect((await pending).error?.code).toBe("cancelled");
        expect(session.getState().messages.some((m) => m.content === "late")).toBe(false);
      });
    });

    describe("replaceModel()", () => {
      it("retains conversation history and the tool registry for the next model", async () => {
        const first: ChatModel = {
          complete: vi
            .fn()
            .mockResolvedValue(response({ role: "assistant", content: "first answer" }, "stop")),
        };
        const replacement: ChatModel = {
          complete: vi
            .fn()
            .mockResolvedValue(response({ role: "assistant", content: "second answer" }, "stop")),
        };
        const session = new ChatSession(
          first,
          new ToolRegistry([tool("read", async () => ({ ok: true, provenance: [] }))])
        );
        await session.send("first question");

        session.replaceModel(replacement);
        const state = await session.send("second question");

        expect(state.messages.map((message) => message.content)).toEqual([
          "first question",
          "first answer",
          "second question",
          "second answer",
        ]);
        expect(replacement.complete).toHaveBeenCalledWith(
          expect.arrayContaining([
            { role: "user", content: "first question" },
            { role: "assistant", content: "first answer", provenance: [] },
            { role: "user", content: "second question" },
          ]),
          expect.any(AbortSignal),
          expect.arrayContaining([expect.objectContaining({ name: "read" })]),
          expect.any(Function)
        );
      });

      it("cancels the old request and suppresses its late output", async () => {
        let release!: (value: ChatResponse) => void;
        let signal!: AbortSignal;
        const oldModel: ChatModel = {
          complete: vi.fn((_messages, requestSignal) => {
            signal = requestSignal;
            return new Promise<ChatResponse>((resolve) => (release = resolve));
          }),
        };
        const newModel: ChatModel = {
          complete: vi
            .fn()
            .mockResolvedValue(response({ role: "assistant", content: "new output" }, "stop")),
        };
        const session = new ChatSession(oldModel, new ToolRegistry([]));
        const pending = session.send("in flight");
        await vi.waitFor(() => expect(oldModel.complete).toHaveBeenCalled());

        session.replaceModel(newModel);
        expect(signal.aborted).toBe(true);
        release(response({ role: "assistant", content: "late old output" }, "stop"));
        await pending;

        expect(session.getState().messages.map((message) => message.content)).toEqual([
          "in flight",
        ]);
        const state = await session.send("continue");
        expect(state.messages.at(-1)?.content).toBe("new output");
        expect(state.messages.some((message) => message.content === "late old output")).toBe(false);
      });
    });
  });
});
