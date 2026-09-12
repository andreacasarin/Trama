import { chunkMarkdown } from "@/index/chunking";
import { UNIFIED_ORAMA_BENCHMARK_CONFIG, type UnifiedOramaBenchmarkScale } from "./benchmarkConfig";

const TOPICS = ["alpha", "beta", "gamma", "tie"] as const;
type Topic = (typeof TOPICS)[number];

export interface SyntheticNote {
  readonly path: string;
  readonly content: string;
  readonly topic: Topic;
}

export interface SyntheticWorkload {
  readonly scale: UnifiedOramaBenchmarkScale;
  readonly notes: readonly SyntheticNote[];
  readonly totalChunks: number;
  readonly queries: readonly string[];
}

function topicFor(index: number): Topic {
  return TOPICS[index % TOPICS.length];
}

function lineFor(noteIndex: number, ordinal: number, topic: Topic): string {
  const prefix = `topic-${topic} synthetic-note-${noteIndex.toString().padStart(5, "0")} chunk-${ordinal.toString().padStart(3, "0")}`;
  return `${prefix} ${"x".repeat(Math.max(0, 350 - prefix.length))}`;
}

function chunksForNote(noteIndex: number, totalChunks: number, noteCount: number): number {
  const base = Math.floor(totalChunks / noteCount);
  const remainder = totalChunks % noteCount;
  return base + (noteIndex < remainder ? 1 : 0);
}

/** Creates deterministic Markdown that is chunked by the production chunker. */
export function createSyntheticWorkload(scale: UnifiedOramaBenchmarkScale): SyntheticWorkload {
  const noteCount = (UNIFIED_ORAMA_BENCHMARK_CONFIG.notesForScale as Record<number, number>)[scale];
  const notes: SyntheticNote[] = [];
  for (let noteIndex = 0; noteIndex < noteCount; noteIndex++) {
    const topic = topicFor(noteIndex);
    const chunkCount = chunksForNote(noteIndex, scale, noteCount);
    const content = Array.from({ length: chunkCount }, (_, ordinal) =>
      lineFor(noteIndex, ordinal, topic)
    ).join("\n");
    const actualChunks = chunkMarkdown(
      content,
      UNIFIED_ORAMA_BENCHMARK_CONFIG.chunkSize,
      UNIFIED_ORAMA_BENCHMARK_CONFIG.overlap
    ).length;
    if (actualChunks !== chunkCount)
      throw new Error(`Synthetic chunk count mismatch at note ${noteIndex}`);
    notes.push({ path: `synthetic/${noteIndex.toString().padStart(5, "0")}.md`, content, topic });
  }
  return {
    scale,
    notes: Object.freeze(notes),
    totalChunks: scale,
    queries: Object.freeze(["topic alpha", "topic beta", "topic gamma", "topic tie", "synthetic", "missing lexical", "topic alpha"]),
  };
}

function topicIndex(text: string): number {
  const lowered = text.toLowerCase();
  return TOPICS.findIndex((topic) => lowered.includes(`topic-${topic}`) || lowered.includes(`topic ${topic}`));
}

function normalizedBasis(index: number, dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  vector[index < 0 ? 0 : index % dimensions] = 1;
  return vector;
}

/** Deterministic 768D normalized embeddings with controlled ties. */
export function createSyntheticEmbedding(dimensions = UNIFIED_ORAMA_BENCHMARK_CONFIG.dimensions) {
  return {
    dimensions,
    embed: async (texts: readonly string[]) =>
      texts.map((text) => normalizedBasis(Math.max(0, topicIndex(text)), dimensions)),
  };
}

export class SyntheticVault {
  readonly contents = new Map<string, string>();
  private readonly revisions = new Map<string, number>();

  constructor(notes: readonly SyntheticNote[]) {
    for (const note of notes) {
      this.contents.set(note.path, note.content);
      this.revisions.set(note.path, 0);
    }
  }

  update(path: string, content: string): void {
    this.contents.set(path, content);
    this.revisions.set(path, (this.revisions.get(path) ?? 0) + 1);
  }

  rename(oldPath: string, path: string): void {
    const content = this.contents.get(oldPath);
    if (content === undefined) throw new Error(`Synthetic note is unavailable: ${oldPath}`);
    this.contents.delete(oldPath);
    this.revisions.delete(oldPath);
    this.contents.set(path, content);
    this.revisions.set(path, 0);
  }

  remove(path: string): void {
    this.contents.delete(path);
    this.revisions.delete(path);
  }

  port() {
    return {
      listMarkdownPaths: async () => [...this.contents.keys()],
      readMarkdown: async (path: string) => {
        const content = this.contents.get(path);
        if (content === undefined) throw new Error(`Synthetic note is unavailable: ${path}`);
        return { path, content, revision: String(this.revisions.get(path) ?? 0) };
      },
      isMarkdownAvailable: async (path: string) => this.contents.has(path),
      estimateMarkdownTextCount: async (paths: readonly string[]) =>
        paths.reduce((sum, path) => {
          const content = this.contents.get(path);
          return (
            sum +
            (content
              ? chunkMarkdown(
                  content,
                  UNIFIED_ORAMA_BENCHMARK_CONFIG.chunkSize,
                  UNIFIED_ORAMA_BENCHMARK_CONFIG.overlap
                ).length
              : 0)
          );
        }, 0),
    };
  }
}
