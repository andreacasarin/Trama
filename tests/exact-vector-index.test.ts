import { describe, expect, it } from "vitest";
import { encodeBinarySegment } from "@/index/corpus/BinarySegment";
import type { CorpusSnapshot, CorpusSegmentView } from "@/index/corpus/CorpusStore";
import { ExactVectorIndex } from "@/index/vector/ExactVectorIndex";

const id = (char: string) => char.repeat(64);

async function fixture() {
  const encoded = await encodeBinarySegment({
    dimensions: 2,
    noteContentId: id("a"),
    records: [
      { ordinal: 0, startLine: 1, endLine: 1, text: "a", vector: [1, 0] },
      { ordinal: 1, startLine: 2, endLine: 2, text: "b", vector: [0, 1] },
    ],
  });
  const view: CorpusSegmentView = {
    id: encoded.segmentId,
    checksum: encoded.checksum,
    chunkCount: 2,
    segment: encoded,
  };
  let pins = 1;
  let releases = 0;
  const snapshot = {
    generationId: id("b"),
    fingerprint: id("c"),
    root: {} as never,
    notes: [
      {
        path: "A.md",
        contentId: id("a"),
        chunkCount: 2,
        segments: [{ id: encoded.segmentId, checksum: encoded.checksum, chunkCount: 2 }],
      },
    ],
    pin() {
      pins++;
      return this;
    },
    async release() {
      pins--;
      releases++;
    },
    getNote: () => undefined,
    readSegment: async () => view,
    hydrateNote: async () => [view],
    hydrateChunk: async () => undefined,
  } as unknown as CorpusSnapshot;
  return {
    snapshot,
    get pins() {
      return pins;
    },
    get releases() {
      return releases;
    },
  };
}

async function multiFixture(count = 20) {
  const dimensions = 4;
  const records = Array.from({ length: count }, (_, ordinal) => {
    const vector = [
      ((ordinal * 17) % 13) - 6,
      ((ordinal * 11) % 9) - 4,
      (ordinal % 5) - 2,
      ((ordinal * 7) % 9) - 4,
    ];
    return {
      ordinal,
      startLine: ordinal + 1,
      endLine: ordinal + 1,
      text: `chunk-${ordinal}`,
      vector,
    };
  });
  const split = Math.ceil(count / 2);
  const first = await encodeBinarySegment({
    dimensions,
    noteContentId: id("d"),
    records: records.slice(0, split),
  });
  const second = await encodeBinarySegment({
    dimensions,
    noteContentId: id("d"),
    records: records.slice(split).map((record, i) => ({ ...record, ordinal: i })),
  });
  const views = new Map([
    [first.segmentId, first],
    [second.segmentId, second],
  ]);
  let releases = 0;
  const snapshot = {
    generationId: id("e"),
    fingerprint: id("f"),
    root: {} as never,
    notes: [
      {
        path: "A.md",
        contentId: id("d"),
        chunkCount: count,
        segments: [
          { id: first.segmentId, checksum: first.checksum, chunkCount: first.records.length },
          { id: second.segmentId, checksum: second.checksum, chunkCount: second.records.length },
        ],
      },
    ],
    pin() {
      return this;
    },
    async release() {
      releases++;
    },
    getNote: () => undefined,
    readSegment: async (segmentId: string) => {
      const segment = views.get(segmentId)!;
      return {
        id: segmentId,
        checksum: segment.checksum,
        chunkCount: segment.records.length,
        segment,
      };
    },
    hydrateNote: async () => [],
    hydrateChunk: async () => undefined,
  } as unknown as CorpusSnapshot;
  return {
    snapshot,
    records,
    views,
    get releases() {
      return releases;
    },
  };
}

describe("ExactVectorIndex", () => {
  it("scans normalized Float32 vectors in deterministic order and releases its pin", async () => {
    const state = await fixture();
    const index = await ExactVectorIndex.open(state.snapshot);
    expect((await index.search([1, 0], { limit: 10 })).map((hit) => hit.ordinal)).toEqual([0, 1]);
    expect((await index.search([1, 0], { currentPath: "A.md" })).length).toBe(0);
    await index.close();
    await index.close();
    expect(state.releases).toBe(1);
    expect(state.pins).toBe(1);
  });

  it("caps k and rejects invalid query vectors", async () => {
    const state = await fixture();
    const index = await ExactVectorIndex.open(state.snapshot);
    expect((await index.search([1, 0], { limit: 5000 })).length).toBe(2);
    await expect(index.search([0, 0])).rejects.toThrow();
    await expect(index.search([1])).rejects.toThrow("dimensions");
    await index.close();
  });

  it("matches an independent Float32 brute-force oracle across segment boundaries", async () => {
    const state = await multiFixture(2000);
    const index = await ExactVectorIndex.open(state.snapshot);
    const query = [0.75, -1.25, 2, 0.5];
    const norm = Math.hypot(...query);
    const normalized = query.map((value) => Math.fround(value / norm));
    const expected = state.records
      .map((record, ordinal) => {
        const recordNorm = Math.hypot(...record.vector);
        const score = record.vector.reduce(
          (sum, value, dimension) => sum + normalized[dimension] * Math.fround(value / recordNorm),
          0
        );
        return { ordinal, score: Math.max(-1, Math.min(1, score)) };
      })
      .sort((a, b) => b.score - a.score || a.ordinal - b.ordinal)
      .slice(0, 7);
    const actual = await index.search(query, { limit: 7 });
    expect(actual.map((hit) => hit.ordinal)).toEqual(expected.map((hit) => hit.ordinal));
    actual.forEach((hit, i) => expect(hit.score).toBeCloseTo(expected[i].score, 6));
    await index.close();
  });

  it("preserves ties, applies eligibility before scoring, and exposes no vector copy", async () => {
    const state = await fixture();
    const index = await ExactVectorIndex.open(state.snapshot);
    const segment = [...state.snapshot.notes][0].segments[0];
    const encoded = (await state.snapshot.readSegment(segment.id)).segment;
    const vectorOffset = new DataView(
      encoded.bytes.buffer,
      encoded.bytes.byteOffset,
      encoded.bytes.byteLength
    ).getUint32(40, true);
    const vectorView = new DataView(
      encoded.bytes.buffer,
      encoded.bytes.byteOffset,
      encoded.bytes.byteLength
    );
    const original = vectorView.getFloat32(vectorOffset, true);
    const before = (await index.search([1, 0], { limit: 1 }))[0].score;
    vectorView.setFloat32(vectorOffset, 0, true);
    expect((await index.search([1, 0], { limit: 1 }))[0].score).not.toBe(before);
    vectorView.setFloat32(vectorOffset, original, true);
    expect((await index.search([1, 0], { limit: 0 })).length).toBe(0);
    expect((await index.search([1, 0], { limit: -2 })).length).toBe(0);
    expect((await index.search([1, 0], { limit: 1001 })).length).toBe(2);
    expect((await index.search([1, 0], { visiblePaths: new Set(["missing.md"]) })).length).toBe(0);
    await index.close();
  });

  it("cancels at vector checkpoints and yields to the macrotask queue", async () => {
    const state = await multiFixture(2000);
    const index = await ExactVectorIndex.open(state.snapshot);
    const controller = new AbortController();
    let timerRan = false;
    const timer = setTimeout(() => {
      timerRan = true;
      controller.abort();
    }, 0);
    await expect(
      index.search([1, 1, 1, 1], { signal: controller.signal, limit: 1000 })
    ).rejects.toThrow("cancelled");
    clearTimeout(timer);
    expect(timerRan).toBe(true);
    await index.close();
  });
});
