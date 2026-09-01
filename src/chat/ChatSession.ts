import {
  ChatMessage,
  ChatModel,
  ChatToolDefinition,
  ProvenanceRecord,
  StructuredError,
  ToolCall,
} from "@/domain/contracts";
import { ToolRegistry, ToolResult } from "@/tools/ToolRegistry";

export const CHAT_LIMITS = Object.freeze({
  maxRounds: 4,
  maxToolCalls: 8,
  maxConcurrentTools: 4,
  maxToolContent: 32_000,
});

export interface ToolActivity {
  readonly call: ToolCall;
  readonly result?: ToolResult;
  readonly status: "running" | "success" | "error";
}
export interface ChatState {
  readonly messages: readonly ChatMessage[];
  readonly activities: readonly ToolActivity[];
  readonly accessedNotes: readonly ProvenanceRecord[];
  readonly running: boolean;
  readonly error?: { readonly code: string; readonly message: string };
}

/** Removes duplicate source/range records while preserving first-seen order. */
export function dedupeProvenance(records: readonly ProvenanceRecord[]): ProvenanceRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.path}\n${record.startLine ?? ""}\n${record.endLine ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const EMPTY_STATE: ChatState = Object.freeze({
  messages: Object.freeze([]),
  activities: Object.freeze([]),
  accessedNotes: Object.freeze([]),
  running: false,
});

/** Runs one bounded, cancellable model turn and retains its in-memory activity state. */
export class ChatSession {
  private state: ChatState = EMPTY_STATE;
  private active: AbortController | undefined;
  private generation = 0;
  private readonly listeners = new Set<(state: ChatState) => void>();

  constructor(
    private readonly model: ChatModel,
    private readonly registry: ToolRegistry
  ) {}

  getState(): ChatState {
    return this.state;
  }

  subscribe(listener: (state: ChatState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Starts a turn; a second concurrent turn is rejected deterministically. */
  async send(content: string): Promise<ChatState> {
    if (this.active) throw new StructuredError("busy", "A chat turn is already running.", true);
    if (!content.trim())
      throw new StructuredError("invalid_request", "Message cannot be empty.", false);
    const controller = new AbortController();
    const identity = ++this.generation;
    this.active = controller;
    const messages: ChatMessage[] = [...this.state.messages, { role: "user", content }];
    const activities: ToolActivity[] = [];
    const provenance: ProvenanceRecord[] = [];
    this.publish(identity, {
      ...this.state,
      messages: Object.freeze([...messages]),
      activities: Object.freeze([]),
      running: true,
      error: undefined,
    });
    try {
      const definitions: readonly ChatToolDefinition[] = Object.freeze(
        this.registry.definitions.map((d) =>
          Object.freeze({
            name: d.name,
            description: d.description,
            parameters: d.inputSchema as unknown as Readonly<Record<string, unknown>>,
          })
        )
      );
      let toolCalls = 0;
      let contentSize = 0;
      for (let round = 0; round < CHAT_LIMITS.maxRounds; round++) {
        let streamedText = "";
        const response = await this.model.complete(
          Object.freeze([...messages]),
          controller.signal,
          definitions,
          (text) => {
            if (!this.isCurrent(identity)) return;
            streamedText += text;
            this.publish(identity, {
              ...this.state,
              messages: Object.freeze([
                ...messages,
                Object.freeze({ role: "assistant" as const, content: streamedText }),
              ]),
            });
          }
        );
        if (!this.isCurrent(identity)) return this.state;
        messages.push(Object.freeze(response.message));
        if (response.finishReason !== "tool_calls" || !response.message.toolCalls?.length) {
          return this.finish(identity, messages, activities, provenance);
        }
        const calls = response.message.toolCalls;
        if (toolCalls + calls.length > CHAT_LIMITS.maxToolCalls) {
          return this.limit(
            identity,
            messages,
            activities,
            provenance,
            "The tool-call limit was reached; the answer may be incomplete."
          );
        }
        toolCalls += calls.length;
        for (let offset = 0; offset < calls.length; offset += CHAT_LIMITS.maxConcurrentTools) {
          const batch = calls.slice(offset, offset + CHAT_LIMITS.maxConcurrentTools);
          const results = await this.executeBatch(batch, activities, controller.signal, identity);
          for (let i = 0; i < results.length; i++) {
            const result = results[i];
            provenance.push(...result.provenance);
            const serialized = JSON.stringify(result.ok ? result.data : result.error) ?? "";
            contentSize += serialized.length;
            if (contentSize > CHAT_LIMITS.maxToolContent) {
              return this.limit(
                identity,
                messages,
                activities,
                provenance,
                "The tool-result content limit was reached; remaining evidence was not included."
              );
            }
            messages.push({ role: "tool", content: serialized, toolCallId: batch[i].id });
          }
        }
      }
      return this.limit(
        identity,
        messages,
        activities,
        provenance,
        "The model round limit was reached; the answer may be incomplete."
      );
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof Error && /abort|cancel/i.test(error.message))
      )
        return this.cancelled(identity);
      const message = error instanceof Error ? error.message : "Chat turn failed.";
      const code = error instanceof StructuredError ? error.code : "internal";
      return this.fail(identity, messages, activities, provenance, { code, message });
    } finally {
      if (this.active === controller) this.active = undefined;
    }
  }

  cancel(): void {
    if (this.active) {
      this.generation++;
      this.active.abort();
      this.active = undefined;
      this.state = Object.freeze({
        ...this.state,
        running: false,
        error: { code: "cancelled", message: "Chat turn cancelled." },
      });
      for (const listener of this.listeners) listener(this.state);
    }
  }

  private async executeBatch(
    calls: readonly ToolCall[],
    activities: ToolActivity[],
    signal: AbortSignal,
    identity: number
  ): Promise<ToolResult[]> {
    const cache = new Map<string, Promise<ToolResult>>();
    const pending = calls.map(async (call) => {
      const key = `${call.name}\n${JSON.stringify(call.arguments)}`;
      const running: ToolActivity = { call, status: "running" };
      activities.push(running);
      this.publish(identity, { ...this.state, activities: Object.freeze([...activities]) });
      let resultPromise = cache.get(key);
      if (!resultPromise) {
        resultPromise = this.registry.execute(call.name, call.arguments, signal);
        cache.set(key, resultPromise);
      }
      const result = await resultPromise;
      const index = activities.indexOf(running);
      if (index >= 0)
        activities[index] = Object.freeze({
          call,
          result,
          status: result.ok ? "success" : "error",
        });
      this.publish(identity, { ...this.state, activities: Object.freeze([...activities]) });
      return result;
    });
    return Promise.all(pending);
  }

  private isCurrent(identity: number): boolean {
    return identity === this.generation;
  }
  private publish(identity: number, state: ChatState): void {
    if (this.isCurrent(identity)) {
      this.state = Object.freeze(state);
      for (const listener of this.listeners) listener(this.state);
    }
  }
  private finish(
    identity: number,
    messages: ChatMessage[],
    activities: ToolActivity[],
    provenance: ProvenanceRecord[]
  ): ChatState {
    const retained = dedupeProvenance(provenance);
    const finalIndex = messages.length - 1;
    if (messages[finalIndex]?.role === "assistant" && !messages[finalIndex].toolCalls?.length) {
      messages[finalIndex] = Object.freeze({
        ...messages[finalIndex],
        provenance: Object.freeze(retained),
      });
    }
    const state = {
      ...this.state,
      messages: Object.freeze([...messages]),
      activities: Object.freeze([...activities]),
      accessedNotes: Object.freeze(retained),
      running: false,
      error: undefined,
    };
    this.publish(identity, state);
    return this.state;
  }
  private limit(
    identity: number,
    messages: ChatMessage[],
    activities: ToolActivity[],
    provenance: ProvenanceRecord[],
    message: string
  ): ChatState {
    messages.push({ role: "assistant", content: message });
    return this.finish(identity, messages, activities, provenance);
  }
  private fail(
    identity: number,
    messages: ChatMessage[],
    activities: ToolActivity[],
    provenance: ProvenanceRecord[],
    error: { code: string; message: string }
  ): ChatState {
    this.publish(identity, {
      ...this.state,
      messages: Object.freeze([...messages]),
      activities: Object.freeze([...activities]),
      accessedNotes: Object.freeze(dedupeProvenance(provenance)),
      running: false,
      error,
    });
    return this.state;
  }
  private cancelled(identity: number): ChatState {
    if (this.isCurrent(identity))
      this.state = Object.freeze({
        ...this.state,
        running: false,
        error: { code: "cancelled", message: "Chat turn cancelled." },
      });
    return this.state;
  }
}
