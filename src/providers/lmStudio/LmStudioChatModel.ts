import {
  ChatMessage,
  ChatModel,
  ChatResponse,
  ChatToolDefinition,
  StructuredError,
  ToolCall,
} from "@/domain/contracts";
import { LmStudioTransport } from "@/providers/lmStudio/LmStudioTransport";
export interface LmStudioChatOptions {
  readonly endpoint: string;
  readonly modelId: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly context?: number;
  readonly reasoning?: boolean;
  readonly tools?: readonly ChatToolDefinition[];
  readonly transport?: LmStudioTransport;
}
interface ChatApiResponse {
  choices?: readonly {
    message?: {
      content?: string | null;
      tool_calls?: readonly { id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string;
  }[];
}
export interface LmStudioModelInfo {
  readonly id?: string;
}
function serializeMessages(messages: readonly ChatMessage[]): readonly Record<string, unknown>[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCalls
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        }
      : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
  }));
}
/** Adapts LM Studio's OpenAI-compatible chat completion API to the domain model. */
export class LmStudioChatModel implements ChatModel {
  private readonly options: LmStudioChatOptions;
  private readonly transport: LmStudioTransport;
  constructor(options: LmStudioChatOptions) {
    this.options = options;
    this.transport = options.transport ?? new LmStudioTransport();
  }
  /** Lists models only when explicitly requested by the settings UI. */
  async discoverModels(signal: AbortSignal): Promise<readonly string[]> {
    const response = await this.transport.get<{ data?: readonly LmStudioModelInfo[] }>(
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
    requestTools?: readonly ChatToolDefinition[]
  ): Promise<ChatResponse> {
    if (!this.options.modelId.trim())
      throw new StructuredError("invalid_request", "Chat model ID is required.", false);
    const body: Record<string, unknown> = {
      model: this.options.modelId,
      messages: serializeMessages(messages),
    };
    if (this.options.temperature !== undefined) body.temperature = this.options.temperature;
    if (this.options.maxTokens !== undefined) body.max_tokens = this.options.maxTokens;
    if (this.options.context !== undefined) body.context = this.options.context;
    if (this.options.reasoning !== undefined) body.reasoning = this.options.reasoning;
    const tools = requestTools ?? this.options.tools;
    if (tools?.length) body.tools = tools.map((tool) => ({ type: "function", function: tool }));
    const choice = (
      await this.transport.request<ChatApiResponse>(
        this.options.endpoint,
        "/chat/completions",
        body,
        signal
      )
    ).choices?.[0];
    if (!choice?.message)
      throw new StructuredError("internal", "LM Studio returned an invalid chat response.", false);
    const toolCalls: ToolCall[] = [];
    for (const call of choice.message.tool_calls ?? []) {
      if (!call.id || !call.function?.name)
        throw new StructuredError("internal", "LM Studio returned an invalid tool call.", false);
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments ?? "{}");
      } catch {
        throw new StructuredError(
          "internal",
          "LM Studio returned malformed tool arguments.",
          false
        );
      }
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new StructuredError("internal", "LM Studio returned invalid tool arguments.", false);
      toolCalls.push({
        id: call.id,
        name: call.function.name,
        arguments: args as Readonly<Record<string, unknown>>,
      });
    }
    return {
      message: {
        role: "assistant",
        content: choice.message.content ?? "",
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      finishReason: toolCalls.length
        ? "tool_calls"
        : choice.finish_reason === "length"
          ? "length"
          : "stop",
    };
  }
}
