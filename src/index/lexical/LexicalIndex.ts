import type { IndexRevision } from "@/index/contracts";

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
  /** Backend row identity used for race-safe hydration when available. */
  readonly rowId?: string;
  /** Canonical content-addressed chunk identity, when available. */
  readonly canonicalId?: string;
  /** Legacy/backend identity retained during the transition. */
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
  readonly generationId?: string;
  readonly revision?: IndexRevision;
  readonly fingerprint?: string;
  readonly profile?: LexicalProfile;
  search(query: string, options?: LexicalSearchOptions): Promise<readonly LexicalHit[]>;
  close(): Promise<void>;
}

/** Builder source is intentionally generic: concrete backends own their source shape. */
export type LexicalIndexBuilder<Source = unknown> = (
  source: Source,
  options?: LexicalBuildOptions
) => Promise<LexicalIndex>;
