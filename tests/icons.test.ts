import { describe, expect, it } from "vitest";
import { TRAMA_ICONS } from "@/ui/icons";

describe("TRAMA_ICONS", () => {
  it("defines the shared native Obsidian vocabulary", () => {
    expect(TRAMA_ICONS).toEqual({
      trama: "network",
      filo: "route",
      voce: "message-circle",
      lente: "search",
    });
  });
});
