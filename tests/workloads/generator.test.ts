import { describe, expect, it } from "vitest";
import { createWorkload, workloadDigest } from "./generator";

describe("deterministic Trama workload generator", () => {
  it("uses real chunking, normalized 768d vectors, and stable mutations", () => {
    const fixture = { id: "trama-10k" as const, noteCount: 10, targetChunks: 20 };
    const first = createWorkload(fixture);
    const second = createWorkload(fixture);
    expect(workloadDigest(first)).toBe(workloadDigest(second));
    expect(first.notes).toHaveLength(10);
    expect(first.notes.reduce((sum, note) => sum + note.chunks.length, 0)).toBe(20);
    expect(first.notes.map((note) => note.path)).toEqual(
      [...first.notes.map((note) => note.path)].sort()
    );
    expect(
      first.notes.flatMap((note) => note.chunks).every((chunk) => chunk.vector.length === 768)
    ).toBe(true);
    expect(first.notes.flatMap((note) => note.chunks).every((chunk) => chunk.embeddingInput)).toBe(
      true
    );
    expect(first.mutations.map((mutation) => mutation.kind)).toEqual([
      "unchanged",
      "add",
      "modify",
      "delete",
      "rename",
    ]);
  });
});
