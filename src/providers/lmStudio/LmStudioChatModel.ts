import {
  ChatMessage,
  ChatModel,
  ChatResponse,
  ChatToolDefinition,
  ChatUsage,
  ReasoningEffort,
  StructuredError,
  ToolCall,
} from "@/domain/contracts";
import {
  emitTramaDiagnostic,
  NOOP_TRAMA_DIAGNOSTICS,
  TramaDiagnostics,
} from "@/diagnostics/TramaDiagnostics";
import { LmStudioTransport } from "@/providers/lmStudio/LmStudioTransport";

export interface LmStudioChatOptions {
  readonly endpoint: string;
  readonly modelId: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly tools?: readonly ChatToolDefinition[];
  readonly transport?: LmStudioTransport;
  readonly diagnostics?: TramaDiagnostics;
}

interface ResponseEvent {
  readonly type?: unknown;
  readonly delta?: unknown;
  readonly text?: unknown;
  readonly refusal?: unknown;
  readonly item?: unknown;
  readonly response?: unknown;
  readonly error?: unknown;
  readonly call_id?: unknown;
  readonly item_id?: unknown;
  readonly arguments?: unknown;
  readonly incomplete_details?: unknown;
}

interface ResponseItem {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly call_id?: unknown;
  readonly name?: unknown;
  readonly arguments?: unknown;
  readonly role?: unknown;
  readonly content?: unknown;
  readonly summary?: unknown;
}

interface ToolAccumulator {
  readonly id: string;
  readonly itemId?: string;
  name?: string;
  arguments: string;
  finalArguments?: string;
}

interface ResponsesCompletion {
  readonly status?: unknown;
  readonly output?: unknown;
  readonly usage?: unknown;
  readonly incomplete_details?: unknown;
  readonly error?: unknown;
}

function invalid(message: string): StructuredError {
  return new StructuredError("internal", message, false);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function serializeMessages(messages: readonly ChatMessage[]): readonly Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  const callIds = new Set<string>();
  const outputIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (
        !message.toolCallId ||
        outputIds.has(message.toolCallId) ||
        !callIds.has(message.toolCallId)
      )
        throw invalid("LM Studio received a tool output without a matching tool call.");
      outputIds.add(message.toolCallId);
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      });
      continue;
    }
    if (message.toolCallId)
      throw invalid("LM Studio received a tool call ID on a non-tool message.");
    if (message.reasoningContext !== undefined) {
      if (message.role !== "assistant")
        throw invalid("LM Studio reasoning context must be assistant context.");
      input.push({
        type: "reasoning",
        summary: [{ type: "summary_text", text: message.reasoningContext }],
      });
    }
    if (message.content || !message.toolCalls?.length) {
      input.push({ type: "message", role: message.role, content: message.content });
    }
    for (const call of message.toolCalls ?? []) {
      if (!call.id || callIds.has(call.id) || !call.name || !asRecord(call.arguments))
        throw invalid("LM Studio received a malformed or duplicate tool call.");
      callIds.add(call.id);
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      });
    }
  }
  return input;
}

function usageFrom(value: unknown): ChatUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
  return inputTokens === undefined && outputTokens === undefined && totalTokens === undefined
    ? undefined
    : { inputTokens, outputTokens, totalTokens };
}

/** Adapts LM Studio's stateless Responses API to the provider-neutral chat model. */
export class LmStudioChatModel implements ChatModel {
  private readonly options: LmStudioChatOptions;
  private readonly transport: LmStudioTransport;
  private readonly diagnostics: TramaDiagnostics;

  constructor(options: LmStudioChatOptions) {
    this.options = options;
    this.transport = options.transport ?? new LmStudioTransport();
    const diagnostics = options.diagnostics ?? NOOP_TRAMA_DIAGNOSTICS;
    this.diagnostics = { emit: (record) => emitTramaDiagnostic(diagnostics, record) };
  }

  /** Lists models only when explicitly requested by the settings UI. */
  async discoverModels(signal: AbortSignal): Promise<readonly string[]> {
    const response = await this.transport.get<{ data?: readonly { id?: string }[] }>(
      this.options.endpoint,
      "/models",
      signal
    );
    if (!Array.isArray(response.data))
      throw new StructuredError("internal", "LM Studio returned an invalid model list.", false);
    return response.data.filter((model) => typeof model.id === "string").map((model) => model.id!);
  }

  async complete(
    messages: readonly ChatMessage[],
    signal: AbortSignal,
    requestTools?: readonly ChatToolDefinition[],
    onText?: (text: string) => void
  ): Promise<ChatResponse> {
    try {
      if (!this.options.modelId.trim())
        throw new StructuredError("invalid_request", "Chat model ID is required.", false);
      const body: Record<string, unknown> = {
        model: this.options.modelId,
        input: serializeMessages(messages),
        stream: true,
        store: false,
      };
      if (this.options.temperature !== undefined) body.temperature = this.options.temperature;
      if (this.options.maxOutputTokens !== undefined)
        body.max_output_tokens = this.options.maxOutputTokens;
      if (this.options.reasoningEffort !== undefined)
        body.reasoning = { effort: this.options.reasoningEffort };
      const tools = requestTools ?? this.options.tools;
      if (tools?.length) {
        body.tools = tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }));
      }

      this.diagnostics.emit({ area: "chat", event: "responses_request", body });
      const accumulator = new ResponsesAccumulator(onText);
      for await (const event of this.transport.stream<ResponseEvent>(
        this.options.endpoint,
        "/responses",
        body,
        signal
      )) {
        this.diagnostics.emit({ area: "chat", event: "responses_sse_event", eventData: event });
        accumulator.accept(event);
      }
      if (signal.aborted)
        throw new StructuredError("cancelled", "The request was cancelled.", false);
      const response = accumulator.finish();
      this.diagnostics.emit({ area: "chat", event: "model_response", response });
      return response;
    } catch (error) {
      this.diagnostics.emit({ area: "chat", event: "model_error", error });
      throw error;
    }
  }
}

class ResponsesAccumulator {
  private readonly tools = new Map<string, ToolAccumulator>();
  private readonly orderedToolIds: string[] = [];
  private visibleText = "";
  private reasoning = "";
  private terminal?: "completed" | "incomplete" | "failed" | "error";
  private completion?: ResponsesCompletion;
  private usage?: ChatUsage;

  constructor(private readonly onText?: (text: string) => void) {}

  accept(event: ResponseEvent): void {
    if (!event || typeof event.type !== "string")
      throw invalid("LM Studio returned a malformed event.");
    if (
      this.terminal &&
      ["response.completed", "response.incomplete", "response.failed", "error"].includes(event.type)
    )
      throw invalid("LM Studio returned conflicting terminal events.");
    switch (event.type) {
      case "response.output_text.delta":
      case "response.refusal.delta":
        this.appendVisible(event.delta);
        return;
      case "response.output_text.done":
      case "response.refusal.done":
        this.appendVisibleOnce(event.text ?? event.refusal);
        return;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
      case "response.reasoning_content.delta":
        this.appendReasoning(event.delta);
        return;
      case "response.output_item.added":
        this.acceptOutputItem(event.item, false);
        return;
      case "response.output_item.done":
        this.acceptOutputItem(event.item, true);
        return;
      case "response.function_call_arguments.delta":
        this.appendArguments(event.call_id, event.item_id, event.delta);
        return;
      case "response.function_call_arguments.done":
        this.finishArguments(event.call_id, event.item_id, event.arguments);
        return;
      case "response.completed":
        this.setTerminal("completed", event.response);
        return;
      case "response.incomplete":
        this.setTerminal(
          "incomplete",
          event.response ?? { incomplete_details: event.incomplete_details }
        );
        return;
      case "response.failed":
        this.setTerminal("failed", event.response ?? event.error);
        return;
      case "error":
        this.setTerminal("error", event.error ?? event.response);
        return;
      default:
        return;
    }
  }

  finish(): ChatResponse {
    if (!this.terminal) throw invalid("LM Studio ended the stream without a terminal response.");
    if (this.terminal === "failed" || this.terminal === "error")
      throw this.responseError("LM Studio failed to complete the response.");
    if (this.terminal === "incomplete") {
      const reason = asRecord(asRecord(this.completion?.incomplete_details))?.reason;
      if (reason !== "max_output_tokens" && reason !== "max_tokens" && reason !== "length")
        throw invalid("LM Studio returned an unsupported incomplete response.");
    }
    const toolCalls = this.orderedToolIds.map((id) => this.parseTool(this.tools.get(id)!));
    return {
      message: {
        role: "assistant",
        content: this.visibleText,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(this.reasoning ? { reasoningContext: this.reasoning } : {}),
      },
      finishReason: toolCalls.length
        ? "tool_calls"
        : this.terminal === "incomplete"
          ? "length"
          : "stop",
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }

  private appendVisible(value: unknown): void {
    if (typeof value !== "string") throw invalid("LM Studio returned a malformed text delta.");
    this.visibleText += value;
    this.onText?.(value);
  }

  private appendVisibleOnce(value: unknown): void {
    if (typeof value !== "string") throw invalid("LM Studio returned malformed completed text.");
    if (value === this.visibleText) return;
    if (value.startsWith(this.visibleText)) {
      const suffix = value.slice(this.visibleText.length);
      if (suffix) this.appendVisible(suffix);
      return;
    }
    if (this.visibleText.endsWith(value)) return;
    if (!this.visibleText) this.appendVisible(value);
    else throw invalid("LM Studio returned conflicting completed text.");
  }

  private appendReasoning(value: unknown): void {
    if (typeof value !== "string") throw invalid("LM Studio returned a malformed reasoning delta.");
    this.reasoning += value;
  }

  private acceptOutputItem(value: unknown, final: boolean): void {
    const item = asRecord(value) as ResponseItem | undefined;
    if (!item || item.type !== "function_call") {
      if (item?.type === "message") {
        if ("content" in item && !Array.isArray(item.content) && typeof item.content !== "string")
          throw invalid("LM Studio returned malformed message content.");
        const content = Array.isArray(item.content) ? item.content : [];
        for (const part of content) {
          const text = asRecord(part)?.text;
          if (typeof text === "string") this.appendVisibleOnce(text);
        }
        return;
      }
      if (item?.type === "reasoning") {
        if ("summary" in item && !Array.isArray(item.summary))
          throw invalid("LM Studio returned malformed reasoning summary.");
        const summary = Array.isArray(item.summary) ? item.summary : [];
        for (const part of summary) {
          const text = asRecord(part)?.text;
          if (typeof text === "string") this.appendReasoning(text);
        }
        return;
      }
      throw invalid("LM Studio returned an unexpected hosted or malformed output item.");
    }
    const id = typeof item.call_id === "string" ? item.call_id : undefined;
    const itemId = typeof item.id === "string" ? item.id : undefined;
    if (!id) throw invalid("LM Studio returned a malformed function call.");
    const existing = this.tools.get(id);
    if (existing) {
      if (!final) throw invalid("LM Studio returned a malformed or duplicate function call.");
      if (typeof item.name === "string" && existing.name && item.name !== existing.name)
        throw invalid("LM Studio returned conflicting function names.");
      if (typeof item.name === "string") existing.name = item.name;
      if (typeof item.arguments === "string") this.finishArguments(id, itemId, item.arguments);
      return;
    }
    const call: ToolAccumulator = { id, itemId, arguments: "" };
    if (typeof item.name === "string") call.name = item.name;
    if (typeof item.arguments === "string") call.arguments = item.arguments;
    this.tools.set(id, call);
    this.orderedToolIds.push(id);
  }

  private findTool(callId: unknown, itemId: unknown): ToolAccumulator {
    const id = typeof callId === "string" ? callId : undefined;
    const item = typeof itemId === "string" ? itemId : undefined;
    if (!id && !item) throw invalid("LM Studio returned function arguments without a call ID.");
    const call = [...this.tools.values()].find(
      (candidate) => candidate.id === id || candidate.itemId === item
    );
    if (!call) throw invalid("LM Studio returned function arguments without a matching call.");
    return call;
  }

  private appendArguments(callId: unknown, itemId: unknown, value: unknown): void {
    if (typeof value !== "string")
      throw invalid("LM Studio returned malformed function arguments.");
    this.findTool(callId, itemId).arguments += value;
  }

  private finishArguments(callId: unknown, itemId: unknown, value: unknown): void {
    if (typeof value !== "string")
      throw invalid("LM Studio returned malformed final function arguments.");
    const call = this.findTool(callId, itemId);
    if (call.finalArguments && call.finalArguments !== value)
      throw invalid("LM Studio returned conflicting function arguments.");
    call.finalArguments = value;
  }

  private parseTool(call: ToolAccumulator): ToolCall {
    if (!call.name) throw invalid("LM Studio returned a function call without a name.");
    const raw = call.finalArguments ?? call.arguments;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      throw invalid("LM Studio returned malformed function arguments.");
    }
    if (!asRecord(parsed)) throw invalid("LM Studio returned invalid function arguments.");
    return { id: call.id, name: call.name, arguments: parsed as Readonly<Record<string, unknown>> };
  }

  private setTerminal(kind: "completed" | "incomplete" | "failed" | "error", value: unknown): void {
    if (this.terminal) throw invalid("LM Studio returned conflicting terminal events.");
    if ((kind === "completed" || kind === "incomplete") && !asRecord(value))
      throw invalid("LM Studio returned a malformed terminal response.");
    this.terminal = kind;
    const raw = asRecord(value);
    if (kind === "completed" && raw?.status !== undefined && raw.status !== "completed")
      throw invalid("LM Studio returned a conflicting completed status.");
    if (kind === "incomplete" && raw?.status !== undefined && raw.status !== "incomplete")
      throw invalid("LM Studio returned a conflicting incomplete status.");
    const response =
      (kind === "failed" || kind === "error") && raw && "message" in raw && !("error" in raw)
        ? ({ error: raw } as ResponsesCompletion)
        : (raw as ResponsesCompletion | undefined);
    this.completion = response;
    this.usage = usageFrom(response?.usage);
    if (kind === "completed" && response && "output" in response && !Array.isArray(response.output))
      throw invalid("LM Studio returned malformed response output.");
    if (kind === "completed" && response?.output) {
      for (const item of response.output as unknown[]) {
        const record = asRecord(item);
        if (record?.type === "function_call") this.acceptOutputItem(record, true);
        else if (record?.type === "message") {
          if (typeof record.content === "string") this.appendVisibleOnce(record.content);
          else {
            const content = Array.isArray(record.content) ? record.content : [];
            for (const part of content) {
              const text = asRecord(part)?.text;
              if (typeof text === "string") this.appendVisibleOnce(text);
            }
          }
        } else if (record?.type === "reasoning") {
          const summary = Array.isArray(record.summary) ? record.summary : [];
          for (const part of summary) {
            const text = asRecord(part)?.text;
            if (typeof text === "string") this.appendReasoning(text);
          }
        } else if (record) throw invalid("LM Studio returned an unexpected hosted output item.");
      }
    }
  }

  private responseError(fallback: string): StructuredError {
    const error = asRecord(this.completion?.error);
    const message = typeof error?.message === "string" ? error.message : fallback;
    return new StructuredError("unavailable", message, false);
  }
}
