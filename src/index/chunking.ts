export const INDEX_SCHEMA_VERSION = 3;
export const EXTRACTION_VERSION = 1;
export const CHUNK_ALGORITHM_VERSION = 2;
export const CHUNK_SIZE = 384;
export const CHUNK_OVERLAP = 64;

export interface IndexChunk {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** Deterministically splits Markdown into bounded, line-aware chunks. */
export function chunkMarkdown(
  text: string,
  size = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP,
  signal?: AbortSignal
): IndexChunk[] {
  if (size <= 0 || overlap < 0 || overlap >= size) throw new Error("Invalid chunk parameters");
  const sourceLines = text.replace(/\r\n?/g, "\n").split("\n");
  const lineNumbers: number[] = [];
  const lines = sourceLines.flatMap((line, sourceIndex) => {
    if (signal?.aborted) throw new Error("Operation cancelled");
    if (line.length <= size) {
      lineNumbers.push(sourceIndex + 1);
      return [line];
    }
    const pieces: string[] = [];
    const stride = size - overlap;
    for (let offset = 0; offset < line.length; offset += stride) {
      if (signal?.aborted) throw new Error("Operation cancelled");
      pieces.push(line.slice(offset, offset + size));
    }
    lineNumbers.push(...pieces.map(() => sourceIndex + 1));
    return pieces;
  });
  const chunks: IndexChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    if (signal?.aborted) throw new Error("Operation cancelled");
    let end = start;
    let length = 0;
    while (
      end < lines.length &&
      (length === 0 || length + lines[end].length + (end > start ? 1 : 0) <= size)
    ) {
      length += lines[end].length + (end > start ? 1 : 0);
      end++;
    }
    const value = lines.slice(start, end).join("\n");
    if (value)
      chunks.push({
        text: value,
        startLine: lineNumbers[start] ?? start + 1,
        endLine: lineNumbers[end - 1] ?? end,
      });
    if (end === lines.length) break;
    // Long-line segments already overlap by construction; applying the
    // packing overlap again would duplicate that context.
    if (lineNumbers[end - 1] === lineNumbers[end]) {
      start = end;
      continue;
    }
    let carried = 0;
    let next = end;
    while (next > start && carried < overlap) {
      next--;
      carried += lines[next].length + 1;
    }
    start = Math.max(start + 1, next);
  }
  return chunks;
}
