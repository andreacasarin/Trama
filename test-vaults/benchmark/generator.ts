import { createHash } from "node:crypto";
import { chunkMarkdownBlocks, type MarkdownBlock } from "@/index/chunking";
import { compareCodeUnits } from "@/index/Identity";
import {
  workloadProfile,
  SIMPLE_BENCHMARK_NOTE_CHARACTERS,
  SIMPLE_BENCHMARK_NOTE_COUNT,
  SIMPLE_BENCHMARK_CORPUS_SHA256,
  WORKLOAD_DIMENSIONS,
  WORKLOAD_FINGERPRINT,
  WORKLOAD_SEED,
  type WorkloadProfile,
} from "./config";

export interface WorkloadChunk extends MarkdownBlock {
  readonly id: string;
  readonly ordinal: number;
  readonly vector: Float32Array;
}

export interface WorkloadNote {
  readonly path: string;
  readonly content: string;
  readonly contentId: string;
  readonly chunks: readonly WorkloadChunk[];
}

export interface WorkloadMutation {
  readonly kind: "unchanged" | "add" | "modify" | "delete" | "rename";
  readonly path: string;
  readonly to?: string;
  readonly note?: WorkloadNote;
}

export interface WorkloadQuery {
  readonly id: "semantic" | "unicode" | "tie" | "empty" | "large" | "hostile";
  readonly text: string;
  readonly vector: Float32Array;
}

export interface Workload {
  readonly profile: WorkloadProfile;
  readonly seed: number;
  readonly notes: readonly WorkloadNote[];
  readonly mutations: readonly WorkloadMutation[];
  readonly queries: readonly WorkloadQuery[];
}

export interface SimpleBenchmarkCorpus {
  readonly notes: readonly { readonly path: string; readonly content: string }[];
  readonly sha256: string;
}

/** The one-note-per-file corpus used by the current Obsidian benchmark. */
export function createSimpleBenchmarkCorpus(): SimpleBenchmarkCorpus {
  const notes = Array.from({ length: SIMPLE_BENCHMARK_NOTE_COUNT }, (_, index) => {
    const path = `notes/${String(index).padStart(4, "0")}.md`;
    const seed =
      index === 0
        ? "D5 lexical sentinel unique phrase."
        : index === 1 || index === 2
          ? "D5 semantic sentinel shared passage for related-note retrieval."
          : `Trama benchmark note ${index}.`;
    const content =
      `${seed} ${"A fixed benchmark note with ordinary prose for indexing. ".repeat(12)}`
        .slice(0, SIMPLE_BENCHMARK_NOTE_CHARACTERS)
        .padEnd(SIMPLE_BENCHMARK_NOTE_CHARACTERS, "x");
    return { path, content };
  });
  const hash = createHash("sha256");
  for (const note of notes) {
    updateLengthPrefixed(hash, note.path);
    updateLengthPrefixed(hash, note.content);
  }
  const sha256 = hash.digest("hex");
  if (sha256 !== SIMPLE_BENCHMARK_CORPUS_SHA256)
    throw new Error("Simple benchmark corpus digest differs from its pinned identity.");
  return { notes, sha256 };
}

export const PROVIDER_CHALLENGE_INPUTS_V1 = [
  "",
  "provider fixture challenge",
  "line one\nline two",
  "naïve café 東京\nsecond line 🚀",
  "anchor alpha",
  "naïve café 東京",
  "tie",
  "large",
  'alpha OR beta "quoted" -tag NEAR/3 (unsafe)',
] as const;

const queryDefinitionsV1 = [
  ["semantic", "anchor alpha", "query:semantic"],
  ["unicode", "naïve café 東京", "query:unicode"],
  ["tie", "tie", "fixed-tie"],
  ["empty", "", "query:empty"],
  ["large", "large", "query:large"],
  ["hostile", 'alpha OR beta "quoted" -tag NEAR/3 (unsafe)', "query:hostile"],
] as const satisfies readonly (readonly [WorkloadQuery["id"], string, string])[];

function vectorBytes(vector: Float32Array): Buffer {
  const bytes = Buffer.alloc(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) =>
    bytes.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT)
  );
  return bytes;
}

function updateLengthPrefixed(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  hash.update(length).update(bytes);
}

export function deterministicProviderChallengeDigest(): string {
  const hash = createHash("sha256");
  for (const input of PROVIDER_CHALLENGE_INPUTS_V1) {
    updateLengthPrefixed(hash, input);
    hash.update(vectorBytes(deterministicEmbeddingVector(input)));
  }
  return hash.digest("hex");
}

export function workloadQueryVectorDigest(workload: Workload): string {
  const hash = createHash("sha256");
  for (const query of workload.queries) {
    updateLengthPrefixed(hash, query.id);
    updateLengthPrefixed(hash, query.text);
    hash.update(vectorBytes(query.vector));
  }
  return hash.digest("hex");
}

export function deterministicEmbeddingVector(input: string, forced?: "tie"): Float32Array {
  return vectorFor(input, forced);
}

function hashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nextRandom(state: { value: number }): number {
  let value = state.value | 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.value = value | 0;
  return (state.value >>> 0) / 0x1_0000_0000;
}

function vectorFor(key: string, forced?: "tie"): Float32Array {
  const state = {
    value:
      (WORKLOAD_SEED ^
        hashHex(key)
          .slice(0, 8)
          .split("")
          .reduce((value, character) => value * 16 + Number.parseInt(character, 16), 0)) |
      0,
  };
  const vector = new Float32Array(WORKLOAD_DIMENSIONS);
  let norm = 0;
  for (let index = 0; index < vector.length; index++) {
    const value = forced === "tie" ? (index === 0 ? 1 : 0) : nextRandom(state) * 2 - 1;
    vector[index] = value;
    norm += value * value;
  }
  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < vector.length; index++) vector[index] *= scale;
  return vector;
}

function paddedLine(path: string, ordinal: number, seed: number, marker = "anchor"): string {
  const prefix = `${marker} ${path} chunk ${ordinal} seed ${seed} — naïve café 東京 🚀 `;
  return `${prefix} ${"alpha beta gamma delta ".repeat(22)}`.slice(0, 300).padEnd(300, "x");
}

function contentFor(path: string, chunkCount: number, seed: number, marker = "anchor"): string {
  return Array.from({ length: chunkCount }, (_, ordinal) =>
    paddedLine(path, ordinal, seed, marker)
  ).join("\n\n");
}

function noteFrom(path: string, content: string): WorkloadNote {
  const contentId = hashHex(`${WORKLOAD_FINGERPRINT}\0${content}`);
  const chunks = chunkMarkdownBlocks(content).map((chunk, ordinal) => ({
    ...chunk,
    id: `${contentId}:${ordinal}`,
    ordinal,
    vector: deterministicEmbeddingVector(chunk.embeddingInput),
  }));
  return { path, content, contentId, chunks };
}

function chunkCounts(profile: WorkloadProfile): number[] {
  const counts = new Array(profile.noteCount).fill(
    Math.floor(profile.targetChunks / profile.noteCount)
  );
  let remainder = profile.targetChunks - counts.reduce((sum, value) => sum + value, 0);
  for (let index = 0; remainder > 0; index++, remainder--) counts[index]++;
  return counts;
}

function specialPath(index: number): string {
  if (index === 0) return "00-special/Ä.md";
  if (index === 1) return "00-special/a.md";
  if (index === 2) return "00-special/😀.md";
  return `notes/${String(index).padStart(5, "0")}/note-${index}.md`;
}

export function createWorkload(profileOrId: WorkloadProfile | WorkloadProfile["id"]): Workload {
  const profile = typeof profileOrId === "string" ? workloadProfile(profileOrId) : profileOrId;
  const notes = chunkCounts(profile).map((count, index) => {
    const path = specialPath(index);
    const marker = index === 1 ? "unicode" : index === 2 ? "tie" : index === 3 ? "large" : "anchor";
    return noteFrom(path, contentFor(path, count, WORKLOAD_SEED, marker));
  });
  const tieVector = vectorFor("fixed-tie", "tie");
  const materialized = notes.map((note, index) =>
    index === 4 || index === 5
      ? {
          ...note,
          chunks: note.chunks.map((chunk) => ({
            ...chunk,
            vector: new Float32Array(tieVector),
          })),
        }
      : note
  );
  const added = noteFrom(
    "mutations/added.md",
    contentFor("mutations/added.md", 2, WORKLOAD_SEED + 1, "added")
  );
  const modifiedBase = materialized[6] ?? materialized[0];
  const modified = noteFrom(
    modifiedBase.path,
    `${modifiedBase.content}\n${paddedLine(modifiedBase.path, modifiedBase.chunks.length, WORKLOAD_SEED + 2, "modified")}`
  );
  const deleted = materialized[7] ?? materialized[0];
  const renamed = materialized[8] ?? materialized[0];
  const first = materialized[0];
  if (!first || !modifiedBase || !deleted || !renamed) throw new Error("Workload is empty");
  return {
    profile,
    seed: WORKLOAD_SEED,
    notes: [...materialized].sort((a, b) => compareCodeUnits(a.path, b.path)),
    mutations: [
      { kind: "unchanged", path: first.path, note: first },
      { kind: "add", path: added.path, note: added },
      { kind: "modify", path: modified.path, note: modified },
      { kind: "delete", path: deleted.path, note: deleted },
      {
        kind: "rename",
        path: renamed.path,
        to: "mutations/renamed.md",
        note: noteFrom("mutations/renamed.md", renamed.content),
      },
    ],
    queries: queryDefinitionsV1.map(([id, text, vectorKey]) => ({
      id,
      text,
      vector: vectorKey === "fixed-tie" ? tieVector : deterministicEmbeddingVector(vectorKey),
    })),
  };
}

export function workloadSourceBytes(workload: Workload): string {
  return JSON.stringify({
    contract: "trama-workload-source-v1",
    profile: workload.profile.id,
    seed: workload.seed,
    notes: workload.notes.map(({ path, content }) => ({ path, content })),
    mutations: workload.mutations.map(({ kind, path, to, note }) => ({
      kind,
      path,
      to: to ?? null,
      note: note ? { path: note.path, content: note.content } : null,
    })),
    queries: workload.queries.map(({ id, text }) => ({ id, text })),
  });
}

export function workloadSourceDigest(workload: Workload): string {
  return hashHex(workloadSourceBytes(workload));
}

export function workloadDigest(workload: Workload): string {
  return hashHex(
    JSON.stringify({
      profile: workload.profile.id,
      notes: workload.notes.map((note) => ({
        path: note.path,
        contentId: note.contentId,
        chunks: note.chunks.length,
      })),
      mutations: workload.mutations.map(({ kind, path, to }) => ({ kind, path, to })),
      queries: workload.queries.map(({ id, text }) => ({ id, text })),
    })
  );
}
