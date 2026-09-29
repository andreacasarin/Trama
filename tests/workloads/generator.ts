import { createHash } from "node:crypto";
import { chunkMarkdownBlocks, type MarkdownBlock } from "@/index/chunking";
import { compareCodeUnits } from "@/index/Identity";
import {
  workloadProfile,
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
    vector: vectorFor(`${path}\0${ordinal}\0${chunk.embeddingInput}`),
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
    queries: [
      { id: "semantic", text: "anchor alpha", vector: vectorFor("query:semantic") },
      { id: "unicode", text: "naïve café 東京", vector: vectorFor("query:unicode") },
      { id: "tie", text: "tie", vector: tieVector },
      { id: "empty", text: "", vector: vectorFor("query:empty") },
      { id: "large", text: "large", vector: vectorFor("query:large") },
      {
        id: "hostile",
        text: 'alpha OR beta "quoted" -tag NEAR/3 (unsafe)',
        vector: vectorFor("query:hostile"),
      },
    ],
  };
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
