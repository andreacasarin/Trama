import {
  bytesToHex,
  equalBytes,
  hexToBytes,
  sha256Bytes,
  utf8DecodeFatal,
  utf8Encode,
} from "./Hash";

export const SEGMENT_HEADER_SIZE = 128;
export const SEGMENT_RECORD_SIZE = 24;
export const SEGMENT_TARGET_SIZE = 4 * 1024 * 1024;
export const SEGMENT_MAX_SIZE = 8 * 1024 * 1024;
const MAGIC = "TRAMASEG";
const VERSION = 1;
const ENDIAN = 0x01020304;
const NORMALIZED_FLAG = 1;
const CHECKSUM_OFFSET = 80;

export interface BinarySegmentRecord {
  ordinal: number;
  startLine: number;
  endLine: number;
  text: string;
  vector: readonly number[] | Float32Array;
}
export interface BinarySegment {
  version: 1;
  dimensions: number;
  noteContentId: string;
  records: BinarySegmentRecord[];
  segmentId: string;
  checksum: string;
  bytes: Uint8Array;
  /** Global note ordinal represented by local record zero. */
  firstOrdinal: number;
}

function fail(message: string): never {
  throw new Error(`Invalid binary segment: ${message}`);
}
function u32(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
    fail(`${label} out of range`);
  return value;
}
function rangeEnd(offset: number, length: number): number {
  if (!Number.isSafeInteger(offset + length) || offset + length > 0xffffffff)
    fail("offset overflow");
  return offset + length;
}
function validateVector(
  vector: readonly number[] | Float32Array,
  dimensions: number
): Float32Array {
  if (vector.length !== dimensions) fail("vector dimensions mismatch");
  let sum = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) fail("vector contains non-finite value");
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (!(norm > 1e-12)) fail("zero vector");
  const result = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) result[i] = vector[i] / norm;
  return result;
}

export function normalizeVector(vector: readonly number[] | Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) fail("vector contains non-finite value");
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (!(norm > 1e-12)) fail("zero vector");
  return Float32Array.from(vector, (value) => value / norm);
}

export function normalizedDot(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) fail("vector dimensions mismatch");
  let score = 0;
  for (let i = 0; i < a.length; i++) score += a[i] * b[i];
  return Math.max(-1, Math.min(1, score));
}

interface PreparedRecord {
  source: BinarySegmentRecord;
  text: Uint8Array;
  vector: Float32Array;
}

function prepareRecord(
  record: BinarySegmentRecord,
  dimensions: number,
  ordinal: number
): PreparedRecord {
  if (record.ordinal !== ordinal || !Number.isSafeInteger(record.ordinal))
    fail("ordinals must be contiguous");
  if (
    !Number.isSafeInteger(record.startLine) ||
    record.startLine < 1 ||
    record.startLine > 0xffffffff ||
    !Number.isSafeInteger(record.endLine) ||
    record.endLine < record.startLine ||
    record.endLine > 0xffffffff
  )
    fail("invalid line range");
  const text = utf8Encode(record.text);
  if (text.length === 0) fail("empty text");
  return { source: record, text, vector: validateVector(record.vector, dimensions) };
}

async function encodePrepared(
  input: { dimensions: number; noteContentId: string; flags?: number },
  prepared: readonly PreparedRecord[],
  firstOrdinal = 0
): Promise<BinarySegment> {
  const dimensions = input.dimensions;
  const noteId = hexToBytes(input.noteContentId);
  const metadata = new Uint8Array(prepared.length * SEGMENT_RECORD_SIZE);
  const metadataView = new DataView(metadata.buffer);
  const vectors = new Float32Array(prepared.length * dimensions);
  let textLength = 0;
  for (let i = 0; i < prepared.length; i++) {
    const record = prepared[i];
    u32(textLength, "text offset");
    u32(record.text.length, "text length");
    rangeEnd(textLength, record.text.length);
    metadataView.setUint32(i * 24, i, true);
    metadataView.setUint32(i * 24 + 4, record.source.startLine, true);
    metadataView.setUint32(i * 24 + 8, record.source.endLine, true);
    metadataView.setUint32(i * 24 + 12, textLength, true);
    metadataView.setUint32(i * 24 + 16, record.text.length, true);
    metadataView.setUint32(i * 24 + 20, i, true);
    vectors.set(record.vector, i * dimensions);
    textLength += record.text.length;
  }
  const metadataOffset = SEGMENT_HEADER_SIZE;
  const textOffset = metadataOffset + metadata.byteLength;
  const vectorOffset = (textOffset + textLength + 3) & ~3;
  const total = vectorOffset + vectors.byteLength;
  if (total > SEGMENT_MAX_SIZE) fail("segment exceeds 8 MiB hard cap");
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes.set(utf8Encode(MAGIC), 0);
  view.setUint16(8, VERSION, true);
  view.setUint16(10, SEGMENT_HEADER_SIZE, true);
  view.setUint32(12, ENDIAN, true);
  view.setUint32(16, NORMALIZED_FLAG, true);
  view.setUint32(20, dimensions, true);
  view.setUint32(24, prepared.length, true);
  view.setUint32(28, SEGMENT_RECORD_SIZE, true);
  view.setUint32(32, metadataOffset, true);
  view.setUint32(36, textOffset, true);
  view.setUint32(40, vectorOffset, true);
  view.setUint32(44, total, true);
  bytes.set(noteId, 48);
  bytes.set(metadata, metadataOffset);
  let cursor = textOffset;
  for (const record of prepared) {
    bytes.set(record.text, cursor);
    cursor += record.text.length;
  }
  bytes.set(new Uint8Array(vectors.buffer), vectorOffset);
  bytes.fill(0, CHECKSUM_OFFSET, CHECKSUM_OFFSET + 32);
  const digest = await sha256Bytes(bytes);
  bytes.set(digest, CHECKSUM_OFFSET);
  const storedVectors = new Float32Array(bytes.buffer, vectorOffset, vectors.length);
  return {
    version: 1,
    dimensions,
    noteContentId: input.noteContentId.toLowerCase(),
    records: prepared.map((r, index) => ({
      ...r.source,
      ordinal: index,
      vector: storedVectors.subarray(index * dimensions, (index + 1) * dimensions),
    })),
    segmentId: bytesToHex(digest),
    checksum: bytesToHex(digest),
    bytes,
    firstOrdinal,
  };
}

export async function encodeBinarySegment(input: {
  dimensions: number;
  noteContentId: string;
  records: readonly BinarySegmentRecord[];
  flags?: number;
}): Promise<BinarySegment> {
  const dimensions = u32(input.dimensions, "dimensions");
  if (dimensions < 1 || dimensions > 16384) fail("dimensions out of range");
  if (input.flags !== undefined && input.flags !== NORMALIZED_FLAG) fail("unknown flags");
  if (input.records.length > 0xffffffff) fail("too many records");
  if (hexToBytes(input.noteContentId).length !== 32) fail("note content ID must be SHA-256");
  return encodePrepared(
    input,
    input.records.map((record, index) => prepareRecord(record, dimensions, index))
  );
}

export async function decodeBinarySegment(data: ArrayBuffer | Uint8Array): Promise<BinarySegment> {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  if (bytes.length < SEGMENT_HEADER_SIZE) fail("truncated header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (utf8DecodeFatal(bytes.slice(0, 8)) !== MAGIC) fail("magic");
  if (
    view.getUint16(8, true) !== VERSION ||
    view.getUint16(10, true) !== SEGMENT_HEADER_SIZE ||
    view.getUint32(12, true) !== ENDIAN
  )
    fail("version/header/endian");
  if (view.getUint32(16, true) !== NORMALIZED_FLAG) fail("unknown flags");
  const dimensions = view.getUint32(20, true);
  const count = view.getUint32(24, true);
  if (dimensions < 1 || dimensions > 16384) fail("dimensions");
  const recordSize = view.getUint32(28, true),
    metadataOffset = view.getUint32(32, true),
    textOffset = view.getUint32(36, true),
    vectorOffset = view.getUint32(40, true),
    totalLength = view.getUint32(44, true),
    metadataLength = count * SEGMENT_RECORD_SIZE,
    textLength = vectorOffset - textOffset,
    vectorLength = count * dimensions * 4;
  if (
    recordSize !== SEGMENT_RECORD_SIZE ||
    metadataOffset !== SEGMENT_HEADER_SIZE ||
    textOffset !== metadataOffset + metadataLength ||
    vectorOffset < textOffset ||
    vectorOffset % 4 !== 0 ||
    totalLength !== bytes.length ||
    rangeEnd(vectorOffset, vectorLength) !== bytes.length ||
    textLength < 0
  )
    fail("region bounds");
  if (bytes.slice(112, SEGMENT_HEADER_SIZE).some((v) => v !== 0)) fail("reserved bytes");
  const expected = bytes.slice(CHECKSUM_OFFSET, CHECKSUM_OFFSET + 32);
  const copy = bytes.slice();
  copy.fill(0, CHECKSUM_OFFSET, CHECKSUM_OFFSET + 32);
  const actual = await sha256Bytes(copy);
  if (!equalBytes(expected, actual)) fail("checksum");
  const noteContentId = bytesToHex(bytes.slice(48, 80));
  const metadata = new DataView(bytes.buffer, bytes.byteOffset + metadataOffset, metadataLength);
  const textBytes = bytes.slice(textOffset, textOffset + textLength);
  const vectorBytes = new Float32Array(
    bytes.buffer,
    bytes.byteOffset + vectorOffset,
    vectorLength / 4
  );
  const records: BinarySegmentRecord[] = [];
  let usedTextLength = 0;
  for (let i = 0; i < count; i++) {
    const at = i * 24;
    const ordinal = metadata.getUint32(at, true);
    const startLine = metadata.getUint32(at + 4, true);
    const endLine = metadata.getUint32(at + 8, true);
    const offset = metadata.getUint32(at + 12, true);
    const length = metadata.getUint32(at + 16, true);
    if (
      ordinal !== i ||
      startLine < 1 ||
      endLine < startLine ||
      offset + length > textLength ||
      length === 0 ||
      metadata.getUint32(at + 20, true) !== i
    )
      fail("record metadata");
    const text = utf8DecodeFatal(textBytes.slice(offset, offset + length));
    usedTextLength = Math.max(usedTextLength, offset + length);
    const vector = vectorBytes.subarray(i * dimensions, (i + 1) * dimensions);
    validateVector(vector, dimensions);
    let normSquared = 0;
    for (const value of vector) normSquared += value * value;
    const norm = Math.sqrt(normSquared);
    if (Math.abs(norm - 1) > 1e-4) fail("vector is not normalized");
    records.push({ ordinal, startLine, endLine, text, vector });
  }
  if (textBytes.slice(usedTextLength).some((value) => value !== 0)) fail("text padding");
  return {
    version: 1,
    dimensions,
    noteContentId,
    records,
    segmentId: bytesToHex(expected),
    checksum: bytesToHex(expected),
    bytes,
    firstOrdinal: 0,
  };
}

export async function encodeSegmentParts(input: {
  dimensions: number;
  noteContentId: string;
  records: readonly BinarySegmentRecord[];
}): Promise<BinarySegment[]> {
  const dimensions = u32(input.dimensions, "dimensions");
  if (dimensions < 1 || dimensions > 16384) fail("dimensions out of range");
  if (hexToBytes(input.noteContentId).length !== 32) fail("note content ID must be SHA-256");
  const parts: BinarySegment[] = [];
  let current: PreparedRecord[] = [];
  let currentFirstOrdinal = 0;
  let textLength = 0;
  const projected = (count: number, text: number) => {
    const vectorOffset = (SEGMENT_HEADER_SIZE + count * SEGMENT_RECORD_SIZE + text + 3) & ~3;
    return vectorOffset + count * dimensions * 4;
  };
  for (let index = 0; index < input.records.length; index++) {
    const prepared = prepareRecord(input.records[index], dimensions, index);
    const nextSize = projected(current.length + 1, textLength + prepared.text.length);
    if (current.length > 0 && nextSize > SEGMENT_TARGET_SIZE) {
      parts.push(await encodePrepared(input, current, currentFirstOrdinal));
      current = [];
      textLength = 0;
      currentFirstOrdinal = index;
    }
    const singleSize = projected(1, prepared.text.length);
    if (singleSize > SEGMENT_MAX_SIZE) fail("single record exceeds 8 MiB hard cap");
    current.push(prepared);
    textLength += prepared.text.length;
  }
  if (current.length) parts.push(await encodePrepared(input, current, currentFirstOrdinal));
  return parts;
}

export const encodeSegment = encodeBinarySegment;
export const decodeSegment = decodeBinarySegment;
