import { describe, expect, it } from "vitest";
import type { CorpusSnapshot } from "@/index/corpus/CorpusStore";
import { OramaLexicalIndex } from "@/index/lexical/OramaLexicalIndex";

function snapshot(
  records: Array<{ text: string; ordinal: number }>,
  segmentParts = [records],
  notePaths = ["a.md"]
): CorpusSnapshot & { released: number } {
  const value = {
    generationId: "g1",
    fingerprint: "f1",
    notes: notePaths.map((path) => ({
      path,
      contentId: "a",
      chunkCount: records.length,
      segments: segmentParts.map((part, i) => ({
        id: `s${i}`,
        checksum: `c${i}`,
        chunkCount: part.length,
      })),
    })),
    root: {} as CorpusSnapshot["root"],
    released: 0,
    pin() {
      return this;
    },
    async release() {
      this.released++;
    },
    getNote(path: string) {
      return this.notes.find((note) => note.path === path);
    },
    async readSegment(id: string) {
      const i = Number(id.slice(1));
      const part = segmentParts[i] ?? records;
      return {
        id,
        checksum: `c${i}`,
        chunkCount: part.length,
        segment: { records: part },
      } as never;
    },
    async hydrateNote() {
      return segmentParts.map((part, i) => ({
        id: `s${i}`,
        checksum: `c${i}`,
        chunkCount: part.length,
        segment: { records: part },
      })) as never;
    },
    async hydrateChunk(_path: string, ordinal: number) {
      return records[ordinal] as never;
    },
  } as CorpusSnapshot & { released: number };
  return value;
}

describe("OramaLexicalIndex", () => {
  it("builds text-only documents and returns deterministic BM25 hits", async () => {
    const source = snapshot([
      { ordinal: 0, text: "alpha" },
      { ordinal: 1, text: "alpha" },
    ]);
    const progress: number[] = [];
    const index = await OramaLexicalIndex.build(source, {
      onProgress: (event) => progress.push(event.completed),
    });
    expect(await index.search("alpha", { limit: 2 })).toEqual([
      { id: "a.md:0", path: "a.md", ordinal: 0, score: expect.any(Number) },
      { id: "a.md:1", path: "a.md", ordinal: 1, score: expect.any(Number) },
    ]);
    expect(progress).toEqual([2]);
    await index.close();
    await index.close();
    expect(source.released).toBe(1);
  });

  it("filters visibility and exclusions before returning candidates", async () => {
    const source = snapshot([{ ordinal: 0, text: "alpha" }]);
    const index = await OramaLexicalIndex.build(source);
    expect(await index.search("alpha", { visiblePaths: ["other.md"] })).toEqual([]);
    expect(await index.search("alpha", { excludePath: "a.md" })).toEqual([]);
    await index.close();
  });

  it("uses locale-independent code-unit ordering for equal BM25 hits", async () => {
    const source = snapshot([{ ordinal: 0, text: "alpha" }], undefined, ["ä.md", "a.md", "Z.md"]);
    const index = await OramaLexicalIndex.build(source);

    expect((await index.search("alpha", { limit: 3 })).map((hit) => hit.path)).toEqual([
      "Z.md",
      "a.md",
      "ä.md",
    ]);
    await index.close();
  });

  it("uses only text fields and supports multiple segments", async () => {
    const source = snapshot(
      [
        { ordinal: 0, text: "first" },
        { ordinal: 0, text: "second" },
      ],
      [[{ ordinal: 0, text: "first" }], [{ ordinal: 0, text: "second" }]]
    );
    const index = await OramaLexicalIndex.build(source);
    const db = (
      index as unknown as {
        db: { data: { docs: { docs: Record<string, unknown> } }; schema: unknown };
      }
    ).db;
    expect(db.schema).toEqual({ id: "string", text: "string", path: "string", ordinal: "number" });
    expect(Object.values(db.data.docs.docs)).toEqual([
      { id: "a.md:0", text: "first", path: "a.md", ordinal: 0 },
      { id: "a.md:1", text: "second", path: "a.md", ordinal: 1 },
    ]);
    expect(await index.search("second")).toMatchObject([{ id: "a.md:1", ordinal: 1 }]);
    await index.close();
  });

  it("bounds candidates and inserts in 256-document batches", async () => {
    const records = Array.from({ length: 513 }, (_, ordinal) => ({
      ordinal,
      text: `needle ${ordinal}`,
    }));
    const source = snapshot(records);
    const progress: number[] = [];
    const index = await OramaLexicalIndex.build(source, {
      onProgress: (event) => progress.push(event.completed),
    });
    expect(progress).toEqual([256, 512, 513]);
    expect((await index.search("needle", { candidateLimit: 3, limit: 100 })).length).toBe(3);
    await index.close();
  });

  it("releases its pin when build is cancelled", async () => {
    const source = snapshot([{ ordinal: 0, text: "alpha" }]);
    const controller = new AbortController();
    controller.abort();
    await expect(OramaLexicalIndex.build(source, { signal: controller.signal })).rejects.toThrow(
      "cancelled"
    );
    expect(source.released).toBe(0);
  });

  it("releases its pin on hydration failure and observes search cancellation", async () => {
    const source = snapshot([{ ordinal: 0, text: "alpha" }]);
    source.hydrateNote = async () => {
      throw new Error("read failed");
    };
    await expect(OramaLexicalIndex.build(source)).rejects.toThrow("read failed");
    expect(source.released).toBe(1);
    const usable = await OramaLexicalIndex.build(snapshot([{ ordinal: 0, text: "alpha" }]));
    const controller = new AbortController();
    controller.abort();
    await expect(usable.search("alpha", { signal: controller.signal })).rejects.toThrow(
      "cancelled"
    );
    await usable.close();
  });
});
