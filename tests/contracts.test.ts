import { describe, expect, it } from "vitest";
import { StructuredError } from "@/domain/contracts";

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
});
