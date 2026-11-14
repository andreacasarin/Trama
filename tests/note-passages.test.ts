import { describe, expect, it } from "vitest";
import { prepareNote } from "@/index/NotePassages";

describe("body passage preparation", () => {
  it("maps trimmed passages to exact non-overlapping source slices without losing content", async () => {
    for (const body of [
      "  repeated paragraph\r\n\r\nrepeated paragraph\r\n\r\n".repeat(50),
      `# Heading\n\n${"😀 words ".repeat(800)}`,
      "😀".repeat(800),
      "漢字".repeat(700),
      "x".repeat(1000) + " " + "y".repeat(1001),
      "  \n\t  ",
    ]) {
      const prefix = "---\r\naliases: [secret alias]\r\ntags: [topic]\r\n---\r\n";
      const markdown = prefix + body;
      const { passages, metadata } = await prepareNote(markdown, "folder/Title.md");
      expect(metadata).toEqual({ title: "Title", aliases: ["secret alias"], tags: ["#topic"] });
      let cursor = prefix.length;
      for (const [ordinal, passage] of passages.entries()) {
        expect(passage.ordinal).toBe(ordinal);
        expect(passage.startOffset).toBeGreaterThanOrEqual(cursor);
        expect(markdown.slice(cursor, passage.startOffset).trim()).toBe("");
        expect(markdown.slice(passage.startOffset, passage.endOffset)).toBe(passage.text);
        expect(new TextEncoder().encode(passage.text).length).toBeLessThanOrEqual(1000);
        expect(passage.text).not.toMatch(/[\uD800-\uDBFF]$/);
        expect(passage.text).not.toMatch(/^[\uDC00-\uDFFF]/);
        expect(passage.sectionStartOffset).toBeNull();
        expect(passage.sectionPath).toEqual([]);
        cursor = passage.endOffset;
      }
      expect(markdown.slice(cursor).trim()).toBe("");
    }
  });

  it("bounds encoding inputs for unbroken Unicode text", async () => {
    const body = "😀abcdefghijklmnopqrstuvwxyz".repeat(100);
    const encode = TextEncoder.prototype.encode;
    let largestInput = 0;
    TextEncoder.prototype.encode = function (input = "") {
      largestInput = Math.max(largestInput, input.length);
      return encode.call(this, input);
    };
    try {
      const { passages } = await prepareNote(body, "unbroken.md");
      expect(passages.map((passage) => passage.text).join("")).toBe(body);
      expect(largestInput).toBeLessThanOrEqual(1000);
    } finally {
      TextEncoder.prototype.encode = encode;
    }
  });

  it("excludes recognized malformed and frontmatter-only blocks", async () => {
    expect(
      (await prepareNote("---\ninvalid: [\n---\nbody", "a.md")).passages.map((p) => p.text)
    ).toEqual(["body"]);
    expect((await prepareNote("---\ntags: foo\n---\n", "a.md")).passages).toEqual([]);
  });
});
