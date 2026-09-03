import { describe, expect, it } from "vitest";
import { StructuredError, type ChatMessage, type ChatResponse } from "@/domain/contracts";

describe("contracts module", () => {
  describe("StructuredError", () => {
    describe("constructor()", () => {
      it("retains a stable code and retryability alongside the message", () => {
        const error = new StructuredError("unavailable", "LM Studio is unavailable", true);

        expect(error).toMatchObject({
          code: "unavailable",
          message: "LM Studio is unavailable",
          retryable: true,
        });
      });
    });
  });

  describe("ChatMessage and ChatResponse", () => {
    it("supports provider-neutral reasoning context and optional usage", () => {
      const message: ChatMessage = {
        role: "assistant",
        content: "answer",
        reasoningContext: "brief rationale",
      };
      const response: ChatResponse = {
        message,
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      };

      expect(response.usage?.totalTokens).toBe(5);
      expect(response.message.reasoningContext).toBe("brief rationale");
    });
  });
});
