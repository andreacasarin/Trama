import { describe, expect, it, vi } from "vitest";
import { chunkMarkdownBlocks, CHUNK_SIZE, type MarkdownBlockKind } from "@/index/chunking";
import {
  canonicalEmbeddingOptions,
  createEmbeddingActionKey,
  createInputDigest,
  createRevisionDigest,
  createSourceDigest,
  serializeEmbeddingInput,
  sha256Hex,
  utf8ByteLength,
} from "@/index/Identity";

describe("Markdown-aware chunking", () => {
  it("counts UTF-8 bytes without allocation for ASCII, BMP, pairs, and lone surrogates", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("😀é")).toBe(6);
    expect(utf8ByteLength("\ud800")).toBe(3);
  });
  it("matches SHA-256 when WebCrypto is unavailable", async () => {
    const original = globalThis.crypto;
    vi.stubGlobal("crypto", undefined);
    try {
      await expect(sha256Hex("😀é")).resolves.toBe(
        "71b897d47640bd5e39412fb2d81c5d04b1195fc5524663a7704b6bfe2ec0db63"
      );
    } finally {
      vi.stubGlobal("crypto", original);
    }
  });
  it("normalizes line endings and preserves block provenance", () => {
    const lf = chunkMarkdownBlocks("# Title\n\nA paragraph.");
    const crlf = chunkMarkdownBlocks("# Title\r\n\r\nA paragraph.");
    expect(crlf).toEqual(lf);
    expect(lf.map((block) => [block.kind, block.startLine, block.endLine])).toEqual([
      ["heading", 1, 1],
      ["paragraph", 3, 3],
    ]);
  });

  it("recognizes front matter, nested headings, lists, quotes, tables, code, and breaks", () => {
    const source = [
      "---",
      "title: Example",
      "---",
      "# Parent",
      "## Child",
      "- first",
      "  continuation",
      "> quote",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "```ts",
      "const value = 1;",
      "```",
      "***",
    ].join("\n");
    const blocks = chunkMarkdownBlocks(source);
    expect(blocks.map((block) => block.kind)).toEqual([
      "front-matter",
      "heading",
      "heading",
      "list",
      "blockquote",
      "table",
      "code",
      "thematic-break",
    ] satisfies MarkdownBlockKind[]);
    expect(blocks[3].headingContext).toEqual(["Parent", "Child"]);
    expect(blocks[3].embeddingInput).toBe(
      serializeEmbeddingInput(["Parent", "Child"], blocks[3].body)
    );
  });

  it("keeps heading contexts dense when levels are skipped", () => {
    expect(chunkMarkdownBlocks("### First\n\nbody")[1].headingContext).toEqual(["First"]);
    expect(chunkMarkdownBlocks("# Parent\n\n### Child\n\nbody")[2].headingContext).toEqual([
      "Parent",
      "Child",
    ]);
    expect(
      chunkMarkdownBlocks("# Parent\n\n### Child\n\n## Sibling\n\nbody")[3].headingContext
    ).toEqual(["Parent", "Sibling"]);
    expect(chunkMarkdownBlocks("### First\n\n### Second\n\nbody")[2].headingContext).toEqual([
      "Second",
    ]);
    expect(
      chunkMarkdownBlocks("# Parent\n\n### First\n\n### Second\n\nbody")[3].headingContext
    ).toEqual(["Parent", "Second"]);
    expect(chunkMarkdownBlocks("First\n---\nSecond\n---\nbody")[2].headingContext).toEqual([
      "Second",
    ]);
  });

  it("keeps duplicate blocks as separate occurrences", () => {
    const blocks = chunkMarkdownBlocks("same\n\nsame");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].body).toBe(blocks[1].body);
    expect(blocks[0].startLine).not.toBe(blocks[1].startLine);
  });

  it("splits oversized Unicode lines on code point boundaries", () => {
    const blocks = chunkMarkdownBlocks("😀😀😀😀😀", 32);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.map((block) => block.body).join("")).toBe("😀😀😀😀😀");
    expect(blocks.every((block) => block.embeddingInput.length <= 32)).toBe(true);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    expect(
      blocks.every((block) => decoder.decode(new TextEncoder().encode(block.body)) === block.body)
    ).toBe(true);
  });

  it("bounds payloads after repeating a long heading context", () => {
    const source = `# ${"Heading ".repeat(8)}\n\n${"😀".repeat(120)}`;
    const blocks = chunkMarkdownBlocks(source, 384);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every((block) => block.embeddingInput.length <= 384)).toBe(true);
    expect(blocks[1].headingContext).toEqual(["Heading ".repeat(8).trim()]);
  });

  it("rejects a bound that cannot contain its serialized heading context", () => {
    expect(() => chunkMarkdownBlocks("# A heading\n\nbody", 8)).toThrow(
      "serialized heading context"
    );
  });

  it("keeps ordinary blocks separate without overlap", () => {
    const blocks = chunkMarkdownBlocks("one\n\ntwo\n\nthree");
    expect(blocks.map((block) => block.body)).toEqual(["one", "two", "three"]);
    expect(CHUNK_SIZE).toBeGreaterThan(0);
  });
});

describe("canonical embedding identity", () => {
  it("makes exact serialized input and source digests line-ending stable", async () => {
    expect(serializeEmbeddingInput(["Title"], "body\r\nnext")).toBe(
      serializeEmbeddingInput(["Title"], "body\nnext")
    );
    await expect(createSourceDigest("a\r\nb")).resolves.toBe(await createSourceDigest("a\nb"));
    await expect(createInputDigest("a\r\nb")).resolves.toBe(await createInputDigest("a\nb"));
  });

  it("orders revision descriptors and canonicalizes option keys", async () => {
    expect(canonicalEmbeddingOptions({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    await expect(
      createRevisionDigest("extract-v1", [
        { identity: "b", occurrence: 1 },
        { identity: "a", occurrence: 0 },
      ])
    ).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes action keys for exact input, fingerprint, preprocessing, or options", () => {
    const key = (input: string, fingerprint = "fp", preprocessing = "p", options = { x: 1 }) =>
      createEmbeddingActionKey(input, fingerprint, preprocessing, options);
    const base = key("input");
    expect(key("input")).toBe(base);
    expect(key("changed")).not.toBe(base);
    expect(key("input", "changed")).not.toBe(base);
    expect(key("input", "fp", "changed")).not.toBe(base);
    expect(key("input", "fp", "p", { x: 2 })).not.toBe(base);
  });
});
