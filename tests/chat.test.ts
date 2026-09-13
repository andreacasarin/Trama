import { describe, expect, it, vi } from "vitest";
import { ChatMessage, ChatModel, ChatResponse, ReadonlyNote } from "@/domain/contracts";
import { CHAT_LIMITS, ChatSession, dedupeProvenance, SendTurnInput } from "@/chat/ChatSession";
import { TramaDiagnosticRecord } from "@/diagnostics/TramaDiagnostics";
import { ReadonlyTool, ToolRegistry } from "@/tools/ToolRegistry";

const input = (content: string, attachmentPaths: readonly string[] = []): SendTurnInput => ({
  content,
  attachmentPaths,
});
const response = (
  message: ChatResponse["message"],
  finishReason: ChatResponse["finishReason"]
): ChatResponse => ({ message, finishReason });
const vault = (readNote: (path: string, signal: AbortSignal) => Promise<ReadonlyNote>) => ({
  readNote,
});
const tool = (name: string, execute: ReadonlyTool["execute"]): ReadonlyTool => ({
  definition: { name, description: name, inputSchema: { type: "object", properties: {} } },
  execute,
});

describe("ChatSession module", () => {
  describe("dedupeProvenance()", () => {
    it("preserves the first occurrence of each source range", () => {
      expect(
        dedupeProvenance([
          { path: "A.md", startLine: 1, endLine: 2 },
          { path: "A.md", startLine: 1, endLine: 2 },
          { path: "A.md", startLine: 3, endLine: 4 },
        ])
      ).toEqual([
        { path: "A.md", startLine: 1, endLine: 2 },
        { path: "A.md", startLine: 3, endLine: 4 },
      ]);
    });
  });

  describe("ChatSession", () => {
    describe("send()", () => {
      it("sends selected-note contents only with their active user turn", async () => {
        const requests: (readonly ChatMessage[])[] = [];
        const model: ChatModel = {
          complete: vi.fn(async (messages) => {
            requests.push(messages);
            return response({ role: "assistant", content: "answer" }, "stop");
          }),
        };
        const session = new ChatSession(
          model,
          new ToolRegistry([]),
          vault(async (path) => ({
            path,
            content: "secret note contents",
            startLine: 3,
            endLine: 4,
          }))
        );

        const first = await session.send(input("question", ["A.md"]));
        const state = await session.send(input("follow up"));

        expect(first.turns).toEqual([
          {
            id: "turn-1",
            role: "user",
            content: "question",
            attachments: [{ path: "A.md", startLine: 3, endLine: 4 }],
          },
          {
            id: "turn-2",
            role: "assistant",
            content: "answer",
            provenance: [{ path: "A.md", startLine: 3, endLine: 4 }],
            status: "complete",
          },
        ]);
        expect(Object.isFrozen(first.turns)).toBe(true);
        expect(JSON.stringify(state.turns)).not.toContain("secret note contents");
        expect(requests[0][0]).toMatchObject({
          role: "user",
          content: expect.stringContaining("secret note contents"),
        });
        expect(requests[1]).toEqual([
          { role: "user", content: "question" },
          { role: "assistant", content: "answer" },
          { role: "user", content: "follow up" },
        ]);
        expect(JSON.stringify(requests[1])).not.toContain("secret note contents");
      });

      it("deduplicates selected paths in order and restores concurrently read notes to that order", async () => {
        const model: ChatModel = {
          complete: vi
            .fn()
            .mockResolvedValue(response({ role: "assistant", content: "done" }, "stop")),
        };
        const state = await new ChatSession(
          model,
          new ToolRegistry([]),
          vault(async (path) => {
            await Promise.resolve();
            return { path, content: `contents ${path}` };
          })
        ).send(input("question", ["B.md", "A.md", "B.md", "C.md"]));

        expect(state.turns[0]).toMatchObject({
          attachments: [{ path: "B.md" }, { path: "A.md" }, { path: "C.md" }],
        });
        expect((model.complete as ReturnType<typeof vi.fn>).mock.calls[0][0][0].content).toMatch(
          /B\.md[\s\S]*A\.md[\s\S]*C\.md/
        );
      });

      it("reads no more than four selected notes at a time", async () => {
        let active = 0;
        let maximum = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const session = new ChatSession(
          {
            complete: vi
              .fn()
              .mockResolvedValue(response({ role: "assistant", content: "done" }, "stop")),
          },
          new ToolRegistry([]),
          vault(async (path) => {
            active++;
            maximum = Math.max(maximum, active);
            await gate;
            active--;
            return { path, content: path };
          })
        );
        const pending = session.send(input("question", ["1.md", "2.md", "3.md", "4.md", "5.md"]));
        await vi.waitFor(() => expect(active).toBe(CHAT_LIMITS.maxConcurrentAttachmentReads));
        release();
        await pending;

        expect(maximum).toBe(CHAT_LIMITS.maxConcurrentAttachmentReads);
      });

      it("rejects excessive selections and attachment context before adding a turn or calling the model", async () => {
        const complete = vi.fn();
        const records: TramaDiagnosticRecord[] = [];
        const session = new ChatSession(
          { complete },
          new ToolRegistry([]),
          vault(async (path) => ({ path, content: "x".repeat(CHAT_LIMITS.maxAttachmentContent) })),
          { emit: (record) => records.push(record) }
        );

        await expect(
          session.send(
            input(
              "question",
              Array.from({ length: 9 }, (_, index) => `${index}.md`)
            )
          )
        ).rejects.toMatchObject({ code: "limit_exceeded" });
        const state = await session.send(input("question", ["large.md"]));

        expect(state.turns).toEqual([]);
        expect(state.error).toMatchObject({ code: "limit_exceeded" });
        expect(complete).not.toHaveBeenCalled();
        expect(records).toContainEqual({
          area: "chat",
          event: "limit_reached",
          generation: 1,
          message: "Attached notes exceed the 32,000-character context limit.",
        });
      });

      it("does not add a turn or call the model when one selected note cannot be read", async () => {
        const complete = vi.fn();
        const session = new ChatSession(
          { complete },
          new ToolRegistry([]),
          vault(async (path) => {
            if (path === "missing.md") throw new Error("Note not found");
            return { path, content: "available" };
          })
        );

        const state = await session.send(input("question", ["A.md", "missing.md"]));

        expect(state.turns).toEqual([]);
        expect(state.error).toMatchObject({ code: "internal", message: "Note not found" });
        expect(complete).not.toHaveBeenCalled();
      });

      it("removes the provisional assistant and keeps the user turn when the model fails", async () => {
        const session = new ChatSession(
          { complete: vi.fn(async () => Promise.reject(new Error("Model failed"))) },
          new ToolRegistry([]),
          vault(async (path) => ({ path, content: "note" }))
        );

        const state = await session.send(input("question"));

        expect(state).toMatchObject({
          turns: [{ role: "user", content: "question" }],
          running: false,
          error: { code: "internal", message: "Model failed" },
        });
      });

      it("uses one assistant turn through streaming and tool rounds, with combined provenance", async () => {
        const requests: (readonly ChatMessage[])[] = [];
        const model: ChatModel = {
          complete: vi
            .fn()
            .mockImplementationOnce(async (messages, _signal, _tools, onText) => {
              requests.push(messages);
              onText?.("intermediate tool text");
              return response(
                {
                  role: "assistant",
                  content: "intermediate tool text",
                  toolCalls: [{ id: "read", name: "read", arguments: {} }],
                },
                "tool_calls"
              );
            })
            .mockImplementationOnce(async (messages, _signal, _tools, onText) => {
              requests.push(messages);
              onText?.("final");
              return response({ role: "assistant", content: "final" }, "stop");
            })
            .mockImplementationOnce(async (messages) => {
              requests.push(messages);
              return response({ role: "assistant", content: "follow-up" }, "stop");
            }),
        };
        const states: string[] = [];
        const session = new ChatSession(
          model,
          new ToolRegistry([
            tool("read", async () => ({
              ok: true,
              data: "tool data",
              provenance: [{ path: "A.md", startLine: 1, endLine: 2 }, { path: "tool.md" }],
            })),
          ]),
          vault(async (path) => ({ path, content: "attached", startLine: 1, endLine: 2 }))
        );
        session.subscribe((state) => states.push(state.turns.at(-1)?.id ?? ""));

        const state = await session.send(input("question", ["A.md"]));
        const assistant = state.turns[1];
        await session.send(input("follow up"));

        expect(state.turns).toHaveLength(2);
        expect(assistant).toMatchObject({
          id: "turn-2",
          role: "assistant",
          content: "final",
          status: "complete",
          provenance: [{ path: "A.md", startLine: 1, endLine: 2 }, { path: "tool.md" }],
        });
        expect(states.filter((id) => id === "turn-2").length).toBeGreaterThan(1);
        expect(requests[0][0].content).toContain("attached");
        expect(requests[1][0].content).toContain("attached");
        expect(requests[2][0]).toEqual({ role: "user", content: "question" });
        expect(JSON.stringify(requests[2])).not.toContain("attached");
      });

      it("retains tool and round limits without exposing tool protocol messages", async () => {
        const model: ChatModel = {
          complete: vi.fn().mockResolvedValue(
            response(
              {
                role: "assistant",
                content: "",
                toolCalls: [{ id: "read", name: "read", arguments: {} }],
              },
              "tool_calls"
            )
          ),
        };
        const state = await new ChatSession(
          model,
          new ToolRegistry([tool("read", async () => ({ ok: true, data: "x", provenance: [] }))]),
          vault(async (path) => ({ path, content: path }))
        ).send(input("question"));

        expect(model.complete).toHaveBeenCalledTimes(CHAT_LIMITS.maxRounds);
        expect(state.turns).toHaveLength(2);
        expect(state.turns[1]).toMatchObject({ content: expect.stringContaining("round limit") });
      });
    });

    describe("cancel()", () => {
      it("publishes a cancellable running state during attachment preflight and suppresses late results", async () => {
        let resolve!: (note: ReadonlyNote) => void;
        let signal!: AbortSignal;
        const complete = vi.fn();
        const session = new ChatSession(
          { complete },
          new ToolRegistry([]),
          vault(
            (path, requestSignal) =>
              new Promise((done) => {
                signal = requestSignal;
                resolve = done;
              })
          )
        );

        const pending = session.send(input("question", ["A.md"]));
        await vi.waitFor(() => expect(signal).toBeDefined());
        expect(session.getState()).toEqual({ turns: [], running: true });
        session.cancel();
        resolve({ path: "A.md", content: "late" });
        const state = await pending;

        expect(signal.aborted).toBe(true);
        expect(state.error).toMatchObject({ code: "cancelled" });
        expect(state.turns).toEqual([]);
        expect(complete).not.toHaveBeenCalled();
      });

      it("removes a provisional assistant when a visible model request is cancelled", async () => {
        let signal!: AbortSignal;
        const session = new ChatSession(
          {
            complete: vi.fn(
              (_messages, requestSignal) =>
                new Promise<ChatResponse>((_, reject) => {
                  signal = requestSignal;
                  requestSignal.addEventListener("abort", () => reject(new Error("aborted")));
                })
            ),
          },
          new ToolRegistry([]),
          vault(async (path) => ({ path, content: "note" }))
        );

        const pending = session.send(input("question"));
        await vi.waitFor(() => expect(signal).toBeDefined());
        session.cancel();
        const state = await pending;

        expect(state).toMatchObject({
          turns: [{ role: "user", content: "question" }],
          running: false,
          error: { code: "cancelled" },
        });
      });
    });

    describe("replaceModel()", () => {
      it("replays private protocol history to the replacement model", async () => {
        const replacement: ChatModel = {
          complete: vi
            .fn()
            .mockResolvedValue(response({ role: "assistant", content: "second" }, "stop")),
        };
        const session = new ChatSession(
          {
            complete: vi
              .fn()
              .mockResolvedValue(response({ role: "assistant", content: "first" }, "stop")),
          },
          new ToolRegistry([]),
          vault(async (path) => ({ path, content: "note" }))
        );
        await session.send(input("first"));
        session.replaceModel(replacement);
        await session.send(input("second"));

        expect(replacement.complete).toHaveBeenCalledWith(
          [
            { role: "user", content: "first" },
            { role: "assistant", content: "first" },
            { role: "user", content: "second" },
          ],
          expect.any(AbortSignal),
          expect.any(Array),
          expect.any(Function)
        );
      });
    });

    describe("diagnostics", () => {
      it("emits typed session lifecycle records without retaining them", async () => {
        const records: TramaDiagnosticRecord[] = [];
        await new ChatSession(
          {
            complete: vi
              .fn()
              .mockResolvedValue(response({ role: "assistant", content: "done" }, "stop")),
          },
          new ToolRegistry([]),
          vault(async (path) => ({ path, content: "note" })),
          { emit: (record) => records.push(record) }
        ).send(input("question", ["A.md"]));

        expect(records.map((record) => record.event)).toEqual([
          "session_started",
          "attachment_preflight_started",
          "attachment_preflight_completed",
          "model_round_started",
          "model_round_completed",
          "session_completed",
        ]);
        expect(records.at(-1)).toMatchObject({
          area: "chat",
          event: "session_completed",
          generation: 1,
          durationMs: expect.any(Number),
        });
        expect(records.find((record) => record.event === "attachment_preflight_completed")).toEqual(
          expect.objectContaining({ durationMs: expect.any(Number) })
        );
        expect(records.find((record) => record.event === "model_round_completed")).toEqual(
          expect.objectContaining({ durationMs: expect.any(Number) })
        );
      });

      it("emits exact tool and session-error payloads", async () => {
        const records: TramaDiagnosticRecord[] = [];
        const call = { id: "read", name: "read", arguments: { path: "A.md" } };
        const result = {
          ok: true,
          data: { content: "full tool result" },
          provenance: [{ path: "A.md", startLine: 1, endLine: 2 }],
        };
        const toolSession = new ChatSession(
          {
            complete: vi
              .fn()
              .mockResolvedValueOnce(
                response({ role: "assistant", content: "", toolCalls: [call] }, "tool_calls")
              )
              .mockResolvedValueOnce(response({ role: "assistant", content: "done" }, "stop")),
          },
          new ToolRegistry([tool("read", async () => result)]),
          vault(async (path) => ({ path, content: "note" })),
          { emit: (record) => records.push(record) }
        );

        await toolSession.send(input("question"));

        expect(records.find((record) => record.event === "tool_completed")).toMatchObject({
          call,
          result,
          durationMs: expect.any(Number),
        });

        const error = new Error("full session error");
        await new ChatSession(
          { complete: vi.fn(async () => Promise.reject(error)) },
          new ToolRegistry([]),
          vault(async (path) => ({ path, content: "note" })),
          { emit: (record) => records.push(record) }
        ).send(input("question"));

        expect(records.find((record) => record.event === "error")).toMatchObject({ error });
      });

      it("keeps a successful turn intact when the diagnostic sink throws", async () => {
        const session = new ChatSession(
          {
            complete: vi
              .fn()
              .mockResolvedValue(response({ role: "assistant", content: "done" }, "stop")),
          },
          new ToolRegistry([]),
          vault(async (path) => ({ path, content: "note" })),
          {
            emit: () => {
              throw new Error("diagnostics unavailable");
            },
          }
        );

        const state = await session.send(input("question"));
        expect(state.running).toBe(false);
        expect(state.turns.find((turn) => turn.role === "assistant")).toMatchObject({
          content: "done",
          status: "complete",
        });
      });
    });
  });
});
