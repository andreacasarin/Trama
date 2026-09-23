import { serializeEmbeddingInput } from "./Identity";

export { serializeEmbeddingInput } from "./Identity";

export const INDEX_SCHEMA_VERSION = 5;
export const EXTRACTION_VERSION = 1;
export const CHUNK_ALGORITHM_VERSION = 3;
export const CHUNK_SIZE = 384;
export const CHUNK_OVERLAP = 64;

export interface IndexChunk {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly embeddingInput?: string;
  readonly kind?: MarkdownBlockKind;
  readonly headingContext?: readonly string[];
}

export type MarkdownBlockKind =
  | "front-matter"
  | "heading"
  | "paragraph"
  | "list"
  | "blockquote"
  | "code"
  | "table"
  | "thematic-break";

export interface MarkdownBlock {
  readonly kind: MarkdownBlockKind;
  readonly body: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly headingContext: readonly string[];
  readonly embeddingInput: string;
}

const FRONT_MATTER_MARKER = /^(?:---|\.\.\.)[ \t]*$/;
const THEMATIC_BREAK = /^(?: {0,3}(?:\*[ \t]*){3,}| {0,3}(?:-[ \t]*){3,}| {0,3}(?:_[ \t]*){3,})$/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)\s*|[ \t]*)#*[ \t]*$/;
const SETEXT_HEADING = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/;
const BLOCKQUOTE = /^ {0,3}>/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/;

function normalizeLines(source: string): string[] {
  return source.replace(/\r\n?/g, "\n").split("\n");
}

function headingText(line: string): string | undefined {
  const match = line.match(ATX_HEADING);
  if (!match) return undefined;
  return (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
}

function isTableStart(lines: readonly string[], index: number): boolean {
  return (
    index + 1 < lines.length && lines[index].includes("|") && TABLE_SEPARATOR.test(lines[index + 1])
  );
}

function isBlockStart(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? "";
  return Boolean(
    headingText(line) ||
    FENCE.test(line) ||
    THEMATIC_BREAK.test(line) ||
    BLOCKQUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    /^ {4}/.test(line) ||
    isTableStart(lines, index)
  );
}

interface HeadingEntry {
  readonly level: number;
  readonly text: string;
}

function setHeading(headings: HeadingEntry[], level: number, text: string): void {
  while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
  headings.push({ level, text });
}

function parseBlocks(
  source: string,
  signal?: AbortSignal
): Omit<MarkdownBlock, "embeddingInput">[] {
  const lines = normalizeLines(source);
  const blocks: Omit<MarkdownBlock, "embeddingInput">[] = [];
  const headings: HeadingEntry[] = [];
  let index = 0;
  const push = (
    kind: MarkdownBlockKind,
    start: number,
    end: number,
    bodyLines: readonly string[]
  ) => {
    const body = bodyLines.join("\n");
    if (!body) return;
    blocks.push({
      kind,
      body,
      startLine: start + 1,
      endLine: end + 1,
      headingContext: headings.map((heading) => heading.text),
    });
  };
  while (index < lines.length) {
    if (signal?.aborted) throw new Error("Operation cancelled");
    if (!lines[index].trim()) {
      index++;
      continue;
    }
    if (index === 0 && lines[index].trim() === "---") {
      const start = index++;
      while (index < lines.length && !FRONT_MATTER_MARKER.test(lines[index])) index++;
      if (index < lines.length) index++;
      push("front-matter", start, index - 1, lines.slice(start, index));
      continue;
    }
    const atx = headingText(lines[index]);
    if (atx !== undefined) {
      push("heading", index, index, [lines[index]]);
      const level = lines[index].match(ATX_HEADING)?.[1].length ?? 1;
      setHeading(headings, level, atx);
      index++;
      continue;
    }
    if (index + 1 < lines.length && lines[index].trim() && SETEXT_HEADING.test(lines[index + 1])) {
      push("heading", index, index + 1, lines.slice(index, index + 2));
      const level = lines[index + 1].trim().startsWith("=") ? 1 : 2;
      setHeading(headings, level, lines[index].trim());
      index += 2;
      continue;
    }
    if (THEMATIC_BREAK.test(lines[index])) {
      push("thematic-break", index, index, [lines[index]]);
      index++;
      continue;
    }
    const fence = lines[index].match(FENCE);
    if (fence) {
      const start = index++;
      while (index < lines.length) {
        const close = lines[index].match(FENCE);
        index++;
        if (close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length) break;
      }
      push("code", start, index - 1, lines.slice(start, index));
      continue;
    }
    if (BLOCKQUOTE.test(lines[index])) {
      const start = index++;
      while (index < lines.length && (BLOCKQUOTE.test(lines[index]) || !lines[index].trim()))
        index++;
      push("blockquote", start, index - 1, lines.slice(start, index));
      continue;
    }
    if (LIST_ITEM.test(lines[index])) {
      const start = index++;
      while (index < lines.length && (LIST_ITEM.test(lines[index]) || /^ {2,}/.test(lines[index])))
        index++;
      push("list", start, index - 1, lines.slice(start, index));
      continue;
    }
    if (/^ {4}/.test(lines[index])) {
      const start = index++;
      while (index < lines.length && (/^ {4}/.test(lines[index]) || !lines[index].trim())) index++;
      push("code", start, index - 1, lines.slice(start, index));
      continue;
    }
    if (isTableStart(lines, index)) {
      const start = index++;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) index++;
      push("table", start, index - 1, lines.slice(start, index));
      continue;
    }
    const start = index++;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) index++;
    push("paragraph", start, index - 1, lines.slice(start, index));
  }
  return blocks;
}

function splitBlock(
  block: Omit<MarkdownBlock, "embeddingInput">,
  maxInput: number
): MarkdownBlock[] {
  const lines = block.body.split("\n");
  const result: MarkdownBlock[] = [];
  let current: string[] = [];
  let currentStart = block.startLine;
  const flush = (endLine: number) => {
    if (!current.length) return;
    const body = current.join("\n");
    result.push({
      ...block,
      body,
      startLine: currentStart,
      endLine,
      embeddingInput: serializeEmbeddingInput(block.headingContext, body),
    });
    current = [];
  };
  const addLine = (line: string, lineNumber: number) => {
    if (!line && !current.length) return;
    const candidate = [...current, line].join("\n");
    if (serializeEmbeddingInput(block.headingContext, candidate).length <= maxInput) {
      if (!current.length) currentStart = lineNumber;
      current.push(line);
      return;
    }
    if (current.length) flush(lineNumber - 1);
    let piece = "";
    for (const character of Array.from(line)) {
      const candidatePiece = piece + character;
      if (
        serializeEmbeddingInput(block.headingContext, candidatePiece).length > maxInput &&
        piece
      ) {
        currentStart = lineNumber;
        current = [piece];
        flush(lineNumber);
        piece = character;
      } else piece = candidatePiece;
    }
    if (piece) {
      currentStart = lineNumber;
      current = [piece];
      if (serializeEmbeddingInput(block.headingContext, piece).length >= maxInput)
        flush(lineNumber);
    }
  };
  lines.forEach((line, offset) => addLine(line, block.startLine + offset));
  flush(block.endLine);
  return result;
}

export function chunkMarkdownBlocks(
  source: string,
  maxInput = CHUNK_SIZE,
  signal?: AbortSignal
): readonly MarkdownBlock[] {
  if (!Number.isSafeInteger(maxInput) || maxInput < 1) throw new Error("Invalid chunk size");
  const blocks = parseBlocks(source, signal);
  for (const block of blocks)
    if (serializeEmbeddingInput(block.headingContext, "").length > maxInput)
      throw new Error("Chunk size is smaller than the serialized heading context");
  const result = blocks.flatMap((block) => splitBlock(block, maxInput));
  if (result.some((block) => block.embeddingInput.length > maxInput))
    throw new Error("Chunk splitter exceeded its serialized input bound");
  return result;
}

export function chunkMarkdown(
  text: string,
  size = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP,
  signal?: AbortSignal
): IndexChunk[] {
  if (size <= 0 || overlap < 0 || overlap >= size) throw new Error("Invalid chunk parameters");
  const sourceLines = normalizeLines(text);
  const lineNumbers: number[] = [];
  const lines = sourceLines.flatMap((line, sourceIndex) => {
    if (signal?.aborted) throw new Error("Operation cancelled");
    if (Array.from(line).length <= size) {
      lineNumbers.push(sourceIndex + 1);
      return [line];
    }
    const pieces: string[] = [];
    const codePoints = Array.from(line);
    for (let offset = 0; offset < codePoints.length; offset += size - overlap) {
      if (signal?.aborted) throw new Error("Operation cancelled");
      pieces.push(codePoints.slice(offset, offset + size).join(""));
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
