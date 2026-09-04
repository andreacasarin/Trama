import { describe, expect, it } from "vitest";
import { removeNoteReference, resolveNoteReferences } from "@/chat/NoteReferences";

describe("NoteReferences module", () => {
  describe("resolveNoteReferences()", () => {
    it("resolves full paths, aliases, headings, and unique note names in prompt order", () => {
      expect(
        resolveNoteReferences(
          "Compare [[Daily/Today.md|today]] with [[Weekly#Plan]] and [[Daily/Today.md]].",
          ["Daily/Today.md", "Plans/Weekly.md"]
        )
      ).toEqual({ paths: ["Daily/Today.md", "Plans/Weekly.md"], issues: [] });
    });

    it("reports missing and ambiguous links instead of silently omitting cited notes", () => {
      expect(
        resolveNoteReferences("Use [[Today]] and [[Missing]].", ["A/Today.md", "B/Today.md"])
      ).toEqual({
        paths: [],
        issues: [
          { target: "Today", reason: "ambiguous" },
          { target: "Missing", reason: "not_found" },
        ],
      });
    });
  });

  describe("removeNoteReference()", () => {
    it("removes only the first wikilink resolving to the selected path", () => {
      expect(
        removeNoteReference("Use [[Today|today]] then [[Daily/Today.md]].", "Daily/Today.md", [
          "Daily/Today.md",
        ])
      ).toBe("Use then [[Daily/Today.md]].");
    });
  });
});
