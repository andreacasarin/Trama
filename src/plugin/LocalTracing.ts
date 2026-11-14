import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { isCancelled } from "@/domain/errors";
import type { ConsoleDebug } from "./ConsoleDebug";

export class LocalTraceHandler extends BaseCallbackHandler {
  name = "trama-local";
  private readonly runs = new Map<string, { started: number; type: string; parent?: string }>();

  constructor(
    private readonly debug?: ConsoleDebug,
    private readonly signal?: AbortSignal
  ) {
    super({ _awaitHandler: true });
  }

  private start(type: string, id: string, parent?: string): void {
    try {
      if (!this.debug?.isEnabled()) return;
      this.runs.set(id, { started: performance.now(), type, parent });
    } catch {
      /* Diagnostics must never affect the operation. */
    }
  }

  private finish(id: string, outcome: string, count?: number): void {
    const run = this.runs.get(id);
    this.runs.delete(id);
    if (!run) return;
    try {
      this.debug?.info("Local trace", {
        type: run.type,
        runId: id,
        ...(run.parent ? { parentRunId: run.parent } : {}),
        outcome,
        elapsedMs: Math.round(performance.now() - run.started),
        ...(count === undefined ? {} : { count }),
      });
    } catch {
      /* Diagnostics must never affect the operation. */
    }
  }

  // CallbackManager supplies parentRunId fourth at runtime, despite its published handler type.
  handleChainStart(_serialized: unknown, _inputs: unknown, id: string, parent?: string) {
    this.start("chain", id, parent);
  }
  handleChainEnd(_outputs: unknown, id: string) {
    this.finish(id, "completed");
  }
  handleChainError(error: unknown, id: string) {
    this.finish(id, this.signal?.aborted || isCancelled(error) ? "cancelled" : "failed");
  }
  handleRetrieverStart(_serialized: unknown, _query: string, id: string, parent?: string) {
    this.start("retriever", id, parent);
  }
  handleRetrieverEnd(documents: unknown[], id: string) {
    this.finish(id, "completed", documents.length);
  }
  handleRetrieverError(error: unknown, id: string) {
    this.finish(id, this.signal?.aborted || isCancelled(error) ? "cancelled" : "failed");
  }
  handleToolStart(_serialized: unknown, _input: string, id: string, parent?: string) {
    this.start("tool", id, parent);
  }
  handleToolEnd(_output: unknown, id: string) {
    this.finish(id, "completed");
  }
  handleToolError(error: unknown, id: string) {
    this.finish(id, this.signal?.aborted || isCancelled(error) ? "cancelled" : "failed");
  }
  handleChatModelStart(_serialized: unknown, _messages: unknown, id: string, parent?: string) {
    this.start("model", id, parent);
  }
  handleLLMEnd(_output: unknown, id: string) {
    this.finish(id, "completed");
  }
  handleLLMError(error: unknown, id: string) {
    this.finish(id, this.signal?.aborted || isCancelled(error) ? "cancelled" : "failed");
  }
}
