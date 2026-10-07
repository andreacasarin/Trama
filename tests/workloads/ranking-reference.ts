import { createHash } from "node:crypto";
import { loadTestSqlite } from "../sqlite-test-client";
import type { Workload, WorkloadChunk, WorkloadNote } from "../../test-vaults/benchmark/generator";

const CANDIDATE_LIMIT = 80;
const RELATED_LIMIT = 32;
const RELATED_PROBES = 3;
const RRF_K = 60;

export interface ReferenceHit {
  readonly path: string;
  readonly ordinal: number;
  readonly id: string;
  readonly score?: number;
  readonly semanticScore?: number;
  readonly lexicalScore?: number;
  readonly fused?: number;
}

interface LexicalRank extends ReferenceHit {
  readonly rank: number;
  readonly chunk: WorkloadChunk;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareHitTie(left: ReferenceHit, right: ReferenceHit): number {
  return (
    compareCodeUnits(left.path, right.path) ||
    left.ordinal - right.ordinal ||
    compareCodeUnits(left.id, right.id)
  );
}

export function voceWorkerOrder(hits: readonly ReferenceHit[]): ReferenceHit[] {
  return [...hits].sort(
    (left, right) => (right.fused ?? 0) - (left.fused ?? 0) || compareHitTie(left, right)
  );
}

function uniquePassages(note: WorkloadNote): WorkloadChunk[] {
  const seen = new Set<string>();
  return note.chunks.filter((chunk) => {
    if (seen.has(chunk.embeddingInput)) return false;
    seen.add(chunk.embeddingInput);
    return true;
  });
}

function finalNotes(workload: Workload): WorkloadNote[] {
  const byPath = new Map(workload.notes.map((note) => [note.path, note]));
  for (const mutation of workload.mutations) {
    if (mutation.kind === "add" || mutation.kind === "modify") {
      if (!mutation.note) throw new Error(`Missing ${mutation.kind} note`);
      byPath.set(mutation.note.path, mutation.note);
    } else if (mutation.kind === "delete") byPath.delete(mutation.path);
    else if (mutation.kind === "rename") {
      byPath.delete(mutation.path);
      if (!mutation.note || !mutation.to) throw new Error("Incomplete rename mutation");
      byPath.set(mutation.to, mutation.note);
    }
  }
  return [...byPath.values()].sort((left, right) => compareCodeUnits(left.path, right.path));
}

function serializedInputDigest(input: string): string {
  const normalized = input.replace(/\r\n?/g, "\n");
  return createHash("sha256")
    .update(`trama-input-v1\0${normalized.length}:\0${normalized}`, "utf8")
    .digest("hex");
}

function inputDigests(notes: readonly WorkloadNote[]): Set<string> {
  const inputs = new Map<string, string>();
  for (const note of notes) {
    for (const chunk of note.chunks) {
      const digest = serializedInputDigest(chunk.embeddingInput);
      const previous = inputs.get(digest);
      if (previous !== undefined && previous !== chunk.embeddingInput)
        throw new Error("Distinct provider inputs unexpectedly share a SHA-256 digest");
      inputs.set(digest, chunk.embeddingInput);
    }
  }
  return new Set(inputs.keys());
}

export function computedInputKeyCounts(workload: Workload): {
  readonly initial: number;
  readonly everComputed: number;
  readonly finalActive: number;
} {
  const mutationNotes = workload.mutations.flatMap((mutation) =>
    mutation.note ? [mutation.note] : []
  );
  return {
    initial: inputDigests(workload.notes).size,
    everComputed: inputDigests([...workload.notes, ...mutationNotes]).size,
    finalActive: inputDigests(finalNotes(workload)).size,
  };
}

function literalExpression(query: string): string {
  const terms = [
    ...new Set(
      query
        .normalize("NFKC")
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}_-]+/gu) ?? []
    ),
  ]
    .slice(0, 64)
    .map((term) => `"${term.replace(/"/g, '""')}"`);
  return terms.join(" OR ");
}

function dot(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) throw new Error("Reference vector dimensions differ");
  let score = 0;
  for (let index = 0; index < left.length; index++) score += left[index] * right[index];
  return score;
}

function compareSemantic(left: ReferenceHit, right: ReferenceHit): number {
  return (
    (right.score ?? 0) - (left.score ?? 0) ||
    compareCodeUnits(left.path, right.path) ||
    left.ordinal - right.ordinal ||
    compareCodeUnits(left.id, right.id)
  );
}

function bestPassage(note: WorkloadNote, vector: Float32Array): ReferenceHit {
  let winner: ReferenceHit | undefined;
  for (const chunk of uniquePassages(note)) {
    const candidate: ReferenceHit = {
      path: note.path,
      ordinal: chunk.ordinal,
      id: chunk.id,
      score: dot(vector, chunk.vector),
      semanticScore: dot(vector, chunk.vector),
    };
    if (!winner || compareSemantic(candidate, winner) < 0) winner = candidate;
  }
  if (!winner) throw new Error(`Note has no semantic passages: ${note.path}`);
  return winner;
}

function topTwo(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => right - left).slice(0, 2);
  return sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
}

function passageProbes(note: WorkloadNote): WorkloadChunk[] {
  const passages = uniquePassages(note);
  if (!passages.length) return [];
  const sum = new Float64Array(passages[0].vector.length);
  for (const passage of passages)
    for (let index = 0; index < sum.length; index++) sum[index] += passage.vector[index];
  const norm = Math.sqrt(sum.reduce((total, value) => total + value * value, 0));
  const centroid = Float32Array.from(sum, (value) => value / norm);
  let nearest = passages[0];
  for (const passage of passages.slice(1)) {
    const score = dot(passage.vector, centroid);
    const nearestScore = dot(nearest.vector, centroid);
    if (
      score > nearestScore ||
      (score === nearestScore &&
        compareHitTie(
          { path: note.path, ordinal: passage.ordinal, id: passage.id },
          { path: note.path, ordinal: nearest.ordinal, id: nearest.id }
        ) < 0)
    )
      nearest = passage;
  }
  const selected = [nearest];
  while (selected.length < Math.min(RELATED_PROBES, passages.length)) {
    let winner: WorkloadChunk | undefined;
    let nearestSimilarity = Infinity;
    for (const passage of passages) {
      if (selected.some((prior) => prior.embeddingInput === passage.embeddingInput)) continue;
      const maximumSimilarity = Math.max(
        ...selected.map((prior) => dot(passage.vector, prior.vector))
      );
      if (
        maximumSimilarity < nearestSimilarity ||
        (maximumSimilarity === nearestSimilarity &&
          (!winner ||
            passage.ordinal < winner.ordinal ||
            (passage.ordinal === winner.ordinal && compareCodeUnits(passage.id, winner.id) < 0)))
      ) {
        nearestSimilarity = maximumSimilarity;
        winner = passage;
      }
    }
    if (!winner) break;
    selected.push(winner);
  }
  return selected;
}

function sqlRows(db: any, sql: string, bind: readonly unknown[] = []): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  db.exec({
    sql,
    bind,
    rowMode: "object",
    callback: (row: Record<string, unknown>) => result.push(row),
  });
  return result;
}

function passageEvidence(db: any, note: WorkloadNote, expression: string): WorkloadChunk {
  db.exec(
    "CREATE VIRTUAL TABLE temp.reference_passages USING fts5(body,tokenize='unicode61 remove_diacritics 2')"
  );
  try {
    for (const chunk of note.chunks)
      db.exec({
        sql: "INSERT INTO temp.reference_passages(rowid,body) VALUES(?,?)",
        bind: [chunk.ordinal + 1, chunk.body],
      });
    const rows = sqlRows(
      db,
      `SELECT rowid AS passageId,bm25(reference_passages) AS rank
       FROM reference_passages WHERE reference_passages MATCH ?
       ORDER BY rank ASC,rowid ASC LIMIT 1`,
      [expression]
    );
    return rows.length
      ? note.chunks.find((chunk) => chunk.ordinal + 1 === Number(rows[0].passageId))!
      : note.chunks[0];
  } finally {
    db.exec("DROP TABLE IF EXISTS temp.reference_passages");
  }
}

function lexicalRanks(db: any, notes: readonly WorkloadNote[], expression: string): LexicalRank[] {
  db.exec("DROP TABLE IF EXISTS reference_notes");
  db.exec(
    "CREATE VIRTUAL TABLE reference_notes USING fts5(body,path_text,filename,title,headings,tokenize='unicode61 remove_diacritics 2')"
  );
  for (let index = 0; index < notes.length; index++) {
    const note = notes[index];
    if (/^ {0,3}#{1,6}[ \t]|^ {0,3}(`{3,}|~{3,})/m.test(note.content))
      throw new Error(
        `Generated reference fixture unexpectedly contains a heading or fence: ${note.path}`
      );
    const filename = note.path.slice(note.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
    db.exec({
      sql: "INSERT INTO reference_notes(rowid,body,path_text,filename,title,headings) VALUES(?,?,?,?,?,?)",
      bind: [index + 1, note.content, note.path, filename, filename, ""],
    });
  }
  const notesById = new Map(notes.map((note, index) => [index + 1, note]));
  const noteRows = sqlRows(
    db,
    `SELECT rowid AS noteId,bm25(reference_notes,1,2,3,3,0.5) AS rank
     FROM reference_notes WHERE reference_notes MATCH ?`,
    [expression]
  )
    .map((row) => ({
      note: notesById.get(Number(row.noteId))!,
      rank: Number(row.rank),
    }))
    .sort(
      (left, right) => left.rank - right.rank || compareCodeUnits(left.note.path, right.note.path)
    )
    .slice(0, CANDIDATE_LIMIT);
  const minRank = noteRows[0]?.rank ?? 0;
  return noteRows.map(({ note, rank }) => {
    const chunk = passageEvidence(db, note, expression);
    return {
      path: note.path,
      ordinal: chunk.ordinal,
      id: chunk.id,
      rank,
      chunk,
      lexicalScore: minRank < 0 ? rank / minRank : (1 + minRank) / (1 + rank),
    };
  });
}

function hybridRanks(
  lexical: readonly LexicalRank[],
  semantic: readonly ReferenceHit[]
): { readonly canonical: ReferenceHit[]; readonly worker: ReferenceHit[] } {
  const fused = new Map<string, ReferenceHit & { readonly fused: number }>();
  semantic.forEach((hit, index) => fused.set(hit.path, { ...hit, fused: 1 / (RRF_K + index + 1) }));
  lexical.forEach((hit, index) => {
    const previous = fused.get(hit.path);
    const add = 1 / (RRF_K + index + 1);
    if (previous)
      fused.set(hit.path, {
        ...previous,
        fused: previous.fused + add,
        lexicalScore: hit.lexicalScore,
      });
    else
      fused.set(hit.path, { ...hit, score: undefined, fused: add, lexicalScore: hit.lexicalScore });
  });
  const hits = [...fused.values()];
  return {
    worker: voceWorkerOrder(hits),
    canonical: hits.sort(
      (left, right) =>
        right.fused - left.fused ||
        (right.semanticScore ?? -Infinity) - (left.semanticScore ?? -Infinity) ||
        (right.lexicalScore ?? -Infinity) - (left.lexicalScore ?? -Infinity) ||
        compareHitTie(left, right)
    ),
  };
}

function relatedRanks(notes: readonly WorkloadNote[], sourcePath: string): ReferenceHit[] {
  const source = notes.find((note) => note.path === sourcePath);
  if (!source) return [];
  const sourcePassages = uniquePassages(source);
  const probes = passageProbes(source);
  const centroidValues = new Float64Array(sourcePassages[0]?.vector.length ?? 0);
  for (const passage of sourcePassages)
    for (let index = 0; index < centroidValues.length; index++)
      centroidValues[index] += passage.vector[index];
  const norm = Math.sqrt(centroidValues.reduce((sum, value) => sum + value * value, 0));
  const queries = [
    ...(norm ? [Float32Array.from(centroidValues, (value) => value / norm)] : []),
    ...probes.map((passage) => passage.vector),
  ];
  const candidates = new Map<string, WorkloadNote>();
  for (const query of queries) {
    const bestByPath = new Map<string, ReferenceHit>();
    for (const note of notes) {
      if (note.path === sourcePath) continue;
      const best = bestPassage(note, query);
      const previous = bestByPath.get(note.path);
      if (!previous || compareSemantic(best, previous) < 0) bestByPath.set(note.path, best);
    }
    for (const hit of [...bestByPath.values()].sort(compareSemantic).slice(0, RELATED_LIMIT))
      candidates.set(
        hit.path,
        notes.find((note) => note.path === hit.path)!
      );
  }
  const hits: ReferenceHit[] = [];
  for (const targetNote of candidates.values()) {
    const targets = uniquePassages(targetNote);
    if (!sourcePassages.length || !targets.length) continue;
    const sourceBest = sourcePassages.map((passage) =>
      Math.max(...targets.map((target) => dot(passage.vector, target.vector)))
    );
    const targetBest = targets.map((target) =>
      Math.max(...sourcePassages.map((passage) => dot(passage.vector, target.vector)))
    );
    let evidenceIndex = 0;
    for (let index = 1; index < targets.length; index++)
      if (
        targetBest[index] > targetBest[evidenceIndex] ||
        (targetBest[index] === targetBest[evidenceIndex] &&
          (targets[index].ordinal < targets[evidenceIndex].ordinal ||
            (targets[index].ordinal === targets[evidenceIndex].ordinal &&
              compareCodeUnits(targets[index].id, targets[evidenceIndex].id) < 0)))
      )
        evidenceIndex = index;
    hits.push({
      path: targetNote.path,
      ordinal: targets[evidenceIndex].ordinal,
      id: targets[evidenceIndex].id,
      score: (topTwo(sourceBest) + topTwo(targetBest)) / 2,
      semanticScore: (topTwo(sourceBest) + topTwo(targetBest)) / 2,
    });
  }
  return hits.sort(compareSemantic).slice(0, 7);
}

export interface DerivedRankingProbes {
  readonly lexical: readonly { readonly path: string; readonly occurrenceOrdinal: number }[];
  readonly hybrid: readonly { readonly path: string; readonly occurrenceOrdinal: number }[];
  readonly filo: readonly { readonly path: string }[];
  readonly voce: readonly { readonly path: string }[];
}

export async function deriveRankingProbes(workload: Workload): Promise<DerivedRankingProbes> {
  const notes = finalNotes(workload);
  const sqlite = await loadTestSqlite();
  const db = new sqlite.oo1.DB(":memory:", "c");
  try {
    const query = workload.queries.find(({ id }) => id === "hostile");
    if (!query) throw new Error("Hostile query vector is missing");
    const expression = literalExpression(query.text);
    const lexical = lexicalRanks(db, notes, expression);
    const semantic = notes
      .map((note) => bestPassage(note, query.vector))
      .sort(compareSemantic)
      .slice(0, CANDIDATE_LIMIT);
    const { canonical: hybrid, worker: voce } = hybridRanks(lexical, semantic);
    const filo = relatedRanks(notes, workload.notes[0].path);
    return {
      lexical: lexical
        .slice(0, 20)
        .map(({ path, ordinal }) => ({ path, occurrenceOrdinal: ordinal })),
      hybrid: hybrid.map(({ path, ordinal }) => ({ path, occurrenceOrdinal: ordinal })),
      filo: filo.map(({ path }) => ({ path })),
      voce: voce.slice(0, 7).map(({ path }) => ({ path })),
    };
  } finally {
    db.close();
  }
}

export function symmetricRelatedScore(
  source: readonly { readonly input: string; readonly vector: Float32Array }[],
  target: readonly { readonly input: string; readonly vector: Float32Array }[]
): number {
  const uniqueInputs = (passages: typeof source) => {
    const seen = new Set<string>();
    return passages.filter((passage) => {
      if (seen.has(passage.input)) return false;
      seen.add(passage.input);
      return true;
    });
  };
  const sourceUnique = uniqueInputs(source);
  const targetUnique = uniqueInputs(target);
  const sourceBest = sourceUnique.map((passage) =>
    Math.max(...targetUnique.map((candidate) => dot(passage.vector, candidate.vector)))
  );
  const targetBest = targetUnique.map((passage) =>
    Math.max(...sourceUnique.map((candidate) => dot(candidate.vector, passage.vector)))
  );
  return (topTwo(sourceBest) + topTwo(targetBest)) / 2;
}
