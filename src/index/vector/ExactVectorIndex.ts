import { normalizeVector } from "@/index/corpus/BinarySegment";
import type { CorpusSnapshot, CorpusSegmentView } from "@/index/corpus/CorpusStore";
import { chunkId } from "@/index/corpus/Hash";
import type { VectorIndex, VectorSearchHit, VectorSearchOptions } from "./VectorIndex";

interface SegmentRef {
  readonly path: string;
  readonly contentId: string;
  readonly ordinalBase: number;
  readonly view: CorpusSegmentView;
  readonly vectors?: Float32Array;
}

function cancelled(): Error {
  return new Error("Vector search cancelled");
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}
function compareBetter(a: VectorSearchHit, b: VectorSearchHit): number {
  if (a.score !== b.score) return a.score > b.score ? 1 : -1;
  if (a.path !== b.path) return a.path < b.path ? 1 : -1;
  if (a.ordinal !== b.ordinal) return a.ordinal < b.ordinal ? 1 : -1;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}
function compareWorst(a: VectorSearchHit, b: VectorSearchHit): number {
  return compareBetter(a, b);
}
function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Exact, immutable Float32 segment scan. The snapshot is pinned for this index's lifetime. */
export class ExactVectorIndex implements VectorIndex {
  readonly snapshot: CorpusSnapshot;
  private readonly segments: readonly SegmentRef[];
  private closed = false;

  private constructor(snapshot: CorpusSnapshot, segments: readonly SegmentRef[]) {
    this.snapshot = snapshot;
    this.segments = segments;
  }

  static async open(snapshot: CorpusSnapshot): Promise<ExactVectorIndex> {
    const pinned = snapshot.pin();
    try {
      const segments: SegmentRef[] = [];
      for (const note of pinned.notes) {
        let base = 0;
        for (const descriptor of note.segments) {
          const view = await pinned.readSegment(descriptor.id);
          if (view.chunkCount !== descriptor.chunkCount)
            throw new Error("Corpus segment count mismatch");
          const { segment } = view;
          if (segment.records.length !== descriptor.chunkCount || segment.dimensions < 1)
            throw new Error("Invalid corpus segment");
          const bytes = segment.bytes;
          if (bytes.byteLength < 128) throw new Error("Invalid corpus segment buffer");
          const vectorOffset = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength
          ).getUint32(40, true);
          const vectorLength = segment.records.length * segment.dimensions;
          if (
            (bytes.byteOffset + vectorOffset) % 4 !== 0 ||
            vectorOffset + vectorLength * 4 > bytes.byteLength
          )
            throw new Error("Invalid corpus vector region");
          const vectors = new Float32Array(
            bytes.buffer,
            bytes.byteOffset + vectorOffset,
            vectorLength
          );
          segments.push({
            path: note.path,
            contentId: note.contentId,
            ordinalBase: descriptor.firstOrdinal ?? base,
            view,
            vectors,
          });
          base = Math.max(base, (descriptor.firstOrdinal ?? base) + descriptor.chunkCount);
        }
        if (base !== note.chunkCount) throw new Error("Corpus note count mismatch");
      }
      return new ExactVectorIndex(pinned, Object.freeze(segments));
    } catch (error) {
      await pinned.release();
      throw error;
    }
  }

  async search(
    vector: readonly number[],
    optionsOrSignal: VectorSearchOptions | AbortSignal = {},
    positionalLimit?: number
  ): Promise<readonly VectorSearchHit[]> {
    if (this.closed) throw new Error("Vector index is closed");
    const options: VectorSearchOptions =
      "aborted" in optionsOrSignal
        ? { signal: optionsOrSignal, limit: positionalLimit }
        : optionsOrSignal;
    const limit = Math.min(1000, Math.max(0, Math.floor(options.limit ?? 20)));
    if (limit === 0) return [];
    const query = normalizeVector(vector);
    const dimensions = this.segments[0]?.view.segment.dimensions ?? query.length;
    if (query.length !== dimensions) throw new Error("Query vector dimensions mismatch");
    const heap: VectorSearchHit[] = [];
    let lastYield = Date.now();
    let seen = 0;
    for (const ref of this.segments) {
      check(options.signal);
      if (options.visiblePaths && !options.visiblePaths.has(ref.path)) continue;
      if (options.isVisible && !options.isVisible(ref.path)) continue;
      const excludedPath = options.excludePath ?? options.currentPath;
      if (excludedPath !== undefined && ref.path === excludedPath) continue;
      const segment = ref.view.segment;
      if (segment.dimensions !== dimensions) throw new Error("Corpus vector dimensions mismatch");
      for (let i = 0; i < segment.records.length; i++) {
        if ((seen++ & 255) === 0) check(options.signal);
        const row = ref.vectors
          ? ref.vectors.subarray(i * dimensions, (i + 1) * dimensions)
          : segment.records[i].vector;
        let score = 0;
        for (let d = 0; d < dimensions; d++) score += query[d] * row[d];
        score = Math.max(-1, Math.min(1, score));
        const hit: VectorSearchHit = {
          id: chunkId(ref.contentId, ref.ordinalBase + segment.records[i].ordinal),
          path: ref.path,
          ordinal: ref.ordinalBase + segment.records[i].ordinal,
          score,
        };
        if (heap.length < limit) {
          heap.push(hit);
          heap.sort(compareWorst);
        } else if (compareBetter(hit, heap[0]) > 0) {
          heap[0] = hit;
          heap.sort(compareWorst);
        }
        if (Date.now() - lastYield >= 8) {
          await yieldMacrotask();
          lastYield = Date.now();
          check(options.signal);
        }
      }
    }
    heap.sort((a, b) => -compareBetter(a, b));
    return heap;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.snapshot.release();
  }
}
