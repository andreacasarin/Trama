import { describe, expect, it } from "vitest";
import {
  decodeCorpusManifest,
  decodeCorpusPointer,
  encodeCorpusManifest,
  MANIFEST_MAX_SIZE,
  MANIFEST_TARGET_SIZE,
  serializeManifest,
  type ManifestNote,
} from "@/index/corpus/CorpusManifest";
const hex = (n: number) => n.toString(16).padStart(64, "0");
const note = (n: number): ManifestNote => ({
  path: `note-${n}.md`,
  contentId: hex(n + 1),
  chunkCount: 1,
  segments: [{ id: hex(n + 10000), checksum: hex(n + 20000), chunkCount: 1 }],
});
describe("paged corpus manifests", () => {
  it("is deterministic and keeps notes only in bounded pages", async () => {
    const input = { fingerprint: hex(7), notes: [note(2), note(1)] };
    const a = await encodeCorpusManifest(input);
    const b = await encodeCorpusManifest(input);
    expect(a.root).toEqual(b.root);
    expect(a.pages).toEqual(b.pages);
    expect((a.root as any).notes).toBeUndefined();
    await expect(
      decodeCorpusManifest(serializeManifest(a.root), a.pages.map(serializeManifest))
    ).resolves.toEqual(a.root);
  });
  it("uses stable code-unit path ordering for mixed case and diacritics", async () => {
    const paths = ["ä.md", "a.md", "Á.md", "Z.md", "A.md"];
    const built = await encodeCorpusManifest({
      fingerprint: hex(7),
      notes: paths.map((path, index) => ({ ...note(index), path })),
    });

    expect(built.pages.flatMap((page) => page.notes.map((entry) => entry.path))).toEqual([
      "A.md",
      "Z.md",
      "a.md",
      "Á.md",
      "ä.md",
    ]);
    await expect(
      decodeCorpusManifest(serializeManifest(built.root), built.pages.map(serializeManifest))
    ).resolves.toEqual(built.root);
  });
  it("splits pages by actual serialized UTF-8 bytes before the note-count limit", async () => {
    const built = await encodeCorpusManifest({
      fingerprint: hex(7),
      notes: Array.from({ length: 1_800 }, (_, index) => ({
        ...note(index),
        path: `${index.toString().padStart(4, "0")}-${"é".repeat(1_200)}.md`,
      })),
    });

    expect(built.pages.length).toBeGreaterThan(1);
    expect(built.pages[0].notes.length).toBeLessThan(2048);
    for (const page of built.pages) {
      const bytes = new TextEncoder().encode(serializeManifest(page)).byteLength;
      expect(bytes).toBeLessThanOrEqual(MANIFEST_TARGET_SIZE);
      expect(bytes).toBeLessThanOrEqual(MANIFEST_MAX_SIZE);
    }
  });
  it("rejects one note that cannot fit a hard-capped page", async () => {
    await expect(
      encodeCorpusManifest({
        fingerprint: hex(7),
        notes: [{ ...note(1), path: `${"x".repeat(MANIFEST_MAX_SIZE)}.md` }],
      })
    ).rejects.toThrow("single note exceeds manifest page hard cap");
  });
  it("splits pages and rejects cross-link/count/order corruption", async () => {
    const built = await encodeCorpusManifest({
      fingerprint: hex(8),
      notes: Array.from({ length: 2049 }, (_, i) => note(i)),
    });
    expect(built.pages.length).toBe(2);
    expect(built.pages[0].notes.length).toBe(2048);
    const pages = built.pages.map(serializeManifest);
    const altered = JSON.parse(pages[1]);
    altered.generationId = hex(99);
    await expect(
      decodeCorpusManifest(serializeManifest(built.root), [pages[0], JSON.stringify(altered)])
    ).rejects.toThrow();
    const root = JSON.parse(serializeManifest(built.root));
    root.noteCount++;
    await expect(decodeCorpusManifest(JSON.stringify(root), pages)).rejects.toThrow();
  });
  it("validates pointer current and previous IDs", async () => {
    expect(
      decodeCorpusPointer(JSON.stringify({ schema: 1, current: hex(1), previous: hex(2) }))
    ).toEqual({ schema: 1, current: hex(1), previous: hex(2) });
    expect(() => decodeCorpusPointer(JSON.stringify({ schema: 1, current: "bad" }))).toThrow();
  });
  it("rejects non-contiguous segment ordinals", async () => {
    await expect(
      encodeCorpusManifest({
        fingerprint: hex(7),
        notes: [
          {
            path: "a.md",
            contentId: hex(1),
            chunkCount: 2,
            segments: [
              { id: hex(2), checksum: hex(3), chunkCount: 1, firstOrdinal: 0 },
              { id: hex(4), checksum: hex(5), chunkCount: 1, firstOrdinal: 2 },
            ],
          },
        ],
      })
    ).rejects.toThrow("contiguous source order");
  });

  it("rejects an oversized page count before page hydration", async () => {
    const built = await encodeCorpusManifest({ fingerprint: hex(7), notes: [] });
    const root = JSON.parse(serializeManifest(built.root));
    root.pageCount = Number.MAX_SAFE_INTEGER;
    await expect(decodeCorpusManifest(JSON.stringify(root))).rejects.toThrow("root schema/count");
  });
});
