import type { CorpusSnapshot } from "../corpus/CorpusStore";

export interface LexicalSearchOptions {
  readonly limit?: number;
  readonly candidateLimit?: number;
  readonly visiblePaths?: readonly string[] | ReadonlySet<string>;
  readonly excludePath?: string;
  readonly signal?: AbortSignal;
  readonly profile?: LexicalProfile;
}

export type LexicalProfile = "default" | "lente";

export interface LexicalHit {
  readonly id: string;
  readonly path: string;
  readonly ordinal: number;
  readonly score: number;
}

export interface LexicalProgress {
  readonly phase: "build-lexical";
  readonly completed: number;
  readonly total?: number;
  readonly unit: "chunks";
}

export interface LexicalBuildOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: LexicalProgress) => void;
  readonly profile?: LexicalProfile;
}

export interface LexicalIndex {
  readonly generationId: string;
  readonly fingerprint: string;
  readonly profile?: LexicalProfile;
  search(query: string, options?: LexicalSearchOptions): Promise<readonly LexicalHit[]>;
  close(): Promise<void>;
}

export type LexicalIndexBuilder = (
  snapshot: CorpusSnapshot,
  options?: LexicalBuildOptions
) => Promise<LexicalIndex>;
