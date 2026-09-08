import { describe, expect, it } from "vitest";
import {
  decodeBinarySegment,
  encodeBinarySegment,
  encodeSegmentParts,
} from "@/index/corpus/BinarySegment";

const id = "a".repeat(64);
const record = (text = "héllo 世界") => ({
  ordinal: 0,
  startLine: 1,
  endLine: 2,
  text,
  vector: [3, 4],
});

describe("TRAMASEG v1", () => {
  it("round-trips UTF-8 text and normalized vectors", async () => {
    const encoded = await encodeBinarySegment({
      dimensions: 2,
      noteContentId: id,
      records: [record()],
    });
    const decoded = await decodeBinarySegment(encoded.bytes);
    expect(decoded.records[0]).toMatchObject({ text: "héllo 世界", startLine: 1, endLine: 2 });
    expect(decoded.records[0].vector[0]).toBeCloseTo(0.6, 5);
    expect(decoded.records[0].vector[1]).toBeCloseTo(0.8, 5);
    expect(encoded.segmentId).toBe(encoded.checksum);
    const header = new DataView(
      encoded.bytes.buffer,
      encoded.bytes.byteOffset,
      encoded.bytes.byteLength
    );
    expect(header.getUint32(16, true)).toBe(1);
    expect(header.getUint32(28, true)).toBe(24);
    expect(header.getUint32(32, true)).toBe(128);
    expect(header.getUint32(44, true)).toBe(encoded.bytes.byteLength);
    expect(Array.from(encoded.bytes.slice(80, 112))).not.toEqual(Array(32).fill(0));
    expect(Array.from(encoded.bytes.slice(112, 128))).toEqual(Array(16).fill(0));
  });
  it("rejects corruption, unsupported headers, invalid vectors, and oversized records", async () => {
    const encoded = await encodeBinarySegment({
      dimensions: 2,
      noteContentId: id,
      records: [record()],
    });
    for (const mutate of [
      (b: Uint8Array) => (b[0] ^= 1),
      (b: Uint8Array) => new DataView(b.buffer).setUint16(8, 2, true),
      (b: Uint8Array) => new DataView(b.buffer).setUint32(12, 0, true),
      (b: Uint8Array) => new DataView(b.buffer).setUint32(16, 2, true),
      (b: Uint8Array) => (b[127] = 1),
      (b: Uint8Array) => new DataView(b.buffer).setUint32(40, 1, true),
    ]) {
      const copy = encoded.bytes.slice();
      mutate(copy);
      await expect(decodeBinarySegment(copy)).rejects.toThrow();
    }
    await expect(
      encodeBinarySegment({
        dimensions: 2,
        noteContentId: id,
        records: [{ ...record(), vector: [0, 0] }],
      })
    ).rejects.toThrow();
    await expect(
      encodeBinarySegment({
        dimensions: 2,
        noteContentId: id,
        records: [{ ...record(), vector: [NaN, 1] }],
      })
    ).rejects.toThrow();
    const extra = new Uint8Array(encoded.bytes.length + 1);
    extra.set(encoded.bytes);
    await expect(decodeBinarySegment(extra)).rejects.toThrow();
    await expect(
      encodeBinarySegment({
        dimensions: 2,
        noteContentId: id,
        records: [record("x".repeat(8 * 1024 * 1024))],
      })
    ).rejects.toThrow();
  });
  it("splits oversized notes into bounded target segments", async () => {
    const parts = await encodeSegmentParts({
      dimensions: 2,
      noteContentId: id,
      records: [
        record("x".repeat(2_200_000)),
        { ...record("y".repeat(2_200_000)), ordinal: 1 },
        { ...record("z"), ordinal: 2 },
      ],
    });
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.bytes.length <= 8 * 1024 * 1024)).toBe(true);
    expect(parts.map((part) => part.firstOrdinal)).toEqual([0, 1]);
  });
  it("encodes a bounded 1,000 by 768 fixture without quadratic regrouping", async () => {
    const vector = Array.from({ length: 768 }, (_, index) => (index % 17) + 1);
    const records = Array.from({ length: 1000 }, (_, index) => ({
      ordinal: index,
      startLine: index + 1,
      endLine: index + 1,
      text: `row-${index}-${"x".repeat(2000)}`,
      vector,
    }));
    const started = performance.now();
    const parts = await encodeSegmentParts({ dimensions: 768, noteContentId: id, records });
    const elapsed = performance.now() - started;
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.bytes.length <= 8 * 1024 * 1024)).toBe(true);
    expect(elapsed).toBeLessThan(20_000);
  }, 30_000);
});
