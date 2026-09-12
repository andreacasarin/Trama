import { chunkMarkdown, type IndexChunk } from "../../src/index/chunking";
import { compareCodeUnits } from "../../src/index/order";
import {
  getWorkloadProfile,
  CHUNKING_ASSERTIONS,
  PRNG_SEED,
  VECTOR_DIMENSIONS,
  type WorkloadProfile,
  type WorkloadProfileName,
} from "./config";

export const QUERY_IDS = Object.freeze({
  lexical: "lexical",
  semantic: "semantic",
  hybridConflict: "hybrid-conflict",
  tie: "tie",
  noMatch: "no-match",
});
export type QueryId = (typeof QUERY_IDS)[keyof typeof QUERY_IDS];

export interface SyntheticQuery {
  readonly id: QueryId;
  readonly text: string;
  readonly mode: "lexical" | "semantic" | "hybrid";
}

export const QUERIES: readonly SyntheticQuery[] = Object.freeze([
  { id: QUERY_IDS.lexical, text: "architecture delta", mode: "lexical" },
  { id: QUERY_IDS.semantic, text: "retrieval lifecycle", mode: "semantic" },
  { id: QUERY_IDS.hybridConflict, text: "local semantic corpus", mode: "hybrid" },
  { id: QUERY_IDS.tie, text: "tie probe", mode: "semantic" },
  { id: QUERY_IDS.noMatch, text: "zzzz nonexistent token", mode: "hybrid" },
]);

export type MutationKind =
  | "unchanged"
  | "add"
  | "modify"
  | "delete"
  | "rename"
  | "exclusion"
  | "interruption"
  | "dirty-recovery";

export interface MutationStep {
  readonly kind: MutationKind;
  readonly path: string;
  readonly fromPath?: string;
  readonly toPath?: string;
  readonly content?: string;
}

const MUTATION_PATHS = Object.freeze({
  unchanged: "synthetic/0001-α.md",
  add: "synthetic/added-🧪.md",
  modify: "synthetic/0002-é.md",
  delete: "synthetic/0003-é.md",
  renameFrom: "synthetic/0004-old.md",
  renameTo: "synthetic/0004-new.md",
  exclusion: "synthetic/private/0005.md",
  interruption: "synthetic/0006-interrupted.md",
  dirtyRecovery: "synthetic/0007-recovery.md",
});

/** The fixed sequence is shared by baseline and Tala runners. */
export const MUTATION_SEQUENCE: readonly MutationStep[] = Object.freeze([
  { kind: "unchanged", path: MUTATION_PATHS.unchanged },
  { kind: "add", path: MUTATION_PATHS.add, content: "# deterministic added note\n" },
  { kind: "modify", path: MUTATION_PATHS.modify, content: "# deterministic modified note\n" },
  { kind: "delete", path: MUTATION_PATHS.delete },
  {
    kind: "rename",
    path: MUTATION_PATHS.renameFrom,
    fromPath: MUTATION_PATHS.renameFrom,
    toPath: MUTATION_PATHS.renameTo,
  },
  { kind: "exclusion", path: MUTATION_PATHS.exclusion },
  { kind: "interruption", path: MUTATION_PATHS.interruption },
  { kind: "dirty-recovery", path: MUTATION_PATHS.dirtyRecovery },
]);

export interface SyntheticNote {
  readonly path: string;
  readonly content: string;
  readonly chunks: readonly IndexChunk[];
}

export interface SyntheticChunk {
  readonly id: string;
  readonly path: string;
  readonly ordinal: number;
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Undefined only when vectorMaterializationLimit intentionally bounds memory. */
  readonly vector?: Float32Array;
}

export interface GeneratedWorkload {
  readonly profile: WorkloadProfile;
  readonly seed: string;
  readonly dimensions: number;
  readonly notes: readonly SyntheticNote[];
  readonly chunks: readonly SyntheticChunk[];
  readonly queries: readonly SyntheticQuery[];
  readonly mutations: readonly MutationStep[];
  readonly vectorMaterializationLimit: number;
}

class XorShift32 {
  private state: number;

  constructor(seed: string) {
    let hash = 2_166_136_261;
    for (let index = 0; index < seed.length; index++) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    this.state = hash >>> 0 || 1;
  }

  nextUnit(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 4_294_967_296;
  }
}

function normalizedVector(seed: string, dimensions: number): Float32Array {
  const random = new XorShift32(seed);
  const vector = new Float32Array(dimensions);
  let normSquared = 0;
  for (let index = 0; index < dimensions; index++) {
    const value = random.nextUnit() * 2 - 1;
    vector[index] = value;
    normSquared += value * value;
  }
  const inverseNorm = 1 / Math.sqrt(normSquared);
  for (let index = 0; index < dimensions; index++) vector[index] *= inverseNorm;
  return vector;
}

function repeatToLength(pattern: string, length: number): string {
  let result = "";
  while (result.length < length) result += pattern;
  return result.slice(0, length);
}

function contentFor(
  noteIndex: number,
  targetChunks: number,
  chunkSize: number,
  overlap: number
): string {
  const stride = chunkSize - overlap;
  // Keep the final long-line piece larger than the packing overlap. Otherwise
  // chunkMarkdown can pack the final short piece with its predecessor and
  // produce one fewer chunk than the long-line segment count.
  const length = targetChunks === 1 ? 300 : stride * (targetChunks - 1) + overlap + 1;
  return repeatToLength(
    `Synthetic note ${String(noteIndex).padStart(4, "0")} — deterministic Δ corpus. `,
    length
  );
}

function chunkAllocation(noteCount: number, targetChunkCount: number): number[] {
  if (!Number.isSafeInteger(noteCount) || noteCount < 1)
    throw new Error("noteCount must be positive");
  if (!Number.isSafeInteger(targetChunkCount) || targetChunkCount < noteCount)
    throw new Error("targetChunkCount must be at least noteCount");
  const base = Math.floor(targetChunkCount / noteCount);
  const remainder = targetChunkCount % noteCount;
  return Array.from({ length: noteCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

export interface GenerateWorkloadOptions {
  readonly seed?: string;
  readonly dimensions?: number;
  /** Bound vector allocation while retaining all generated note/chunk text. */
  readonly vectorMaterializationLimit?: number;
}

export function generateWorkload(
  profile: WorkloadProfileName | WorkloadProfile,
  options: GenerateWorkloadOptions = {}
): GeneratedWorkload {
  const selected = getWorkloadProfile(profile);
  const seed = options.seed ?? PRNG_SEED;
  const dimensions = options.dimensions ?? VECTOR_DIMENSIONS;
  const vectorLimit = options.vectorMaterializationLimit ?? selected.targetChunkCount;
  if (!Number.isSafeInteger(dimensions) || dimensions < 1)
    throw new Error("dimensions must be positive");
  if (!Number.isSafeInteger(vectorLimit) || vectorLimit < 0)
    throw new Error("vectorMaterializationLimit must be non-negative");

  const allocation = chunkAllocation(selected.noteCount, selected.targetChunkCount);
  const notes: SyntheticNote[] = [];
  const chunks: SyntheticChunk[] = [];
  for (let noteIndex = 0; noteIndex < selected.noteCount; noteIndex++) {
    const path = `synthetic/${String(noteIndex).padStart(5, "0")}-${noteIndex % 2 ? "é" : "α"}.md`;
    const content = contentFor(
      noteIndex,
      allocation[noteIndex],
      CHUNKING_ASSERTIONS.size,
      CHUNKING_ASSERTIONS.overlap
    );
    const noteChunks = chunkMarkdown(content);
    if (noteChunks.length !== allocation[noteIndex])
      throw new Error(
        `Chunk count mismatch for ${path}: expected ${allocation[noteIndex]}, got ${noteChunks.length}`
      );
    notes.push({ path, content, chunks: noteChunks });
    noteChunks.forEach((chunk, ordinal) => {
      const id = `${path}#${ordinal}`;
      chunks.push({
        id,
        path,
        ordinal,
        text: chunk.text,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        vector:
          chunks.length < vectorLimit ? normalizedVector(`${seed}:${id}`, dimensions) : undefined,
      });
    });
  }
  notes.sort((left, right) => compareCodeUnits(left.path, right.path));
  chunks.sort((left, right) => compareCodeUnits(left.id, right.id));
  if (chunks.length !== selected.targetChunkCount)
    throw new Error(
      `Target chunk count mismatch: expected ${selected.targetChunkCount}, got ${chunks.length}`
    );
  return {
    profile: selected,
    seed,
    dimensions,
    notes,
    chunks,
    queries: QUERIES,
    mutations: MUTATION_SEQUENCE,
    vectorMaterializationLimit: vectorLimit,
  };
}

export function materializedVectorCount(workload: GeneratedWorkload): number {
  return workload.chunks.reduce((count, chunk) => count + (chunk.vector ? 1 : 0), 0);
}

export function isNormalized(vector: ArrayLike<number>, tolerance = 1e-5): boolean {
  let sum = 0;
  for (let index = 0; index < vector.length; index++) sum += vector[index] * vector[index];
  return Math.abs(Math.sqrt(sum) - 1) <= tolerance;
}
