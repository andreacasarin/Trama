import { compareCodeUnits } from "../../src/index/order";

export interface OracleCandidate {
  readonly id: string;
  readonly path: string;
  readonly ordinal: number;
  readonly vector: ArrayLike<number>;
}

export interface RankingHit {
  readonly id: string;
  readonly score: number;
}

export function exactCosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length !== right.length) throw new Error("Cosine vectors must have equal dimensions");
  let score = 0;
  for (let index = 0; index < left.length; index++) score += left[index] * right[index];
  return score;
}

function compareCandidates(
  left: RankingHit & OracleCandidate,
  right: RankingHit & OracleCandidate
): number {
  if (left.score !== right.score) return right.score - left.score;
  const pathOrder = compareCodeUnits(left.path, right.path);
  if (pathOrder !== 0) return pathOrder;
  if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
  return compareCodeUnits(left.id, right.id);
}

/** Independent exact cosine scan with UTF-16 code-unit tie ordering. */
export function exactTopK(
  query: ArrayLike<number>,
  candidates: readonly OracleCandidate[],
  limit = 20
): RankingHit[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be positive");
  return candidates
    .map((candidate) => ({ ...candidate, score: exactCosine(query, candidate.vector) }))
    .sort(compareCandidates)
    .slice(0, limit)
    .map(({ id, score }) => ({ id, score }));
}

export interface RankingComparison {
  readonly exactEquality: boolean;
  readonly exactIdEquality: boolean;
  readonly maxScoreError: number;
  readonly recallAt20: number;
  readonly ndcgAt20: number;
}

export function compareRankings(
  expected: readonly RankingHit[],
  actual: readonly RankingHit[],
  k = 20
): RankingComparison {
  if (!Number.isSafeInteger(k) || k < 1) throw new Error("k must be positive");
  const expectedTop = expected.slice(0, k);
  const actualTop = actual.slice(0, k);
  const exactIdEquality =
    expected.length === actual.length &&
    expected.every((hit, index) => hit.id === actual[index]?.id);
  const exactEquality =
    exactIdEquality && expected.every((hit, index) => Object.is(hit.score, actual[index]?.score));
  const actualById = new Map(actual.map((hit) => [hit.id, hit.score]));
  let maxScoreError = 0;
  for (const hit of expectedTop) {
    const actualScore = actualById.get(hit.id);
    if (actualScore !== undefined)
      maxScoreError = Math.max(maxScoreError, Math.abs(hit.score - actualScore));
  }
  const expectedIds = new Set(expectedTop.map((hit) => hit.id));
  const overlap = actualTop.reduce((count, hit) => count + (expectedIds.has(hit.id) ? 1 : 0), 0);
  const recallAt20 = expectedIds.size === 0 ? 1 : overlap / expectedIds.size;

  const ideal = expectedTop
    .map((hit) => Math.max(0, hit.score))
    .sort((left, right) => right - left);
  const gain = (hit: RankingHit): number =>
    Math.max(0, expected.find((item) => item.id === hit.id)?.score ?? 0);
  const discounted = (hits: readonly RankingHit[]): number =>
    hits.reduce((sum, hit, index) => sum + gain(hit) / Math.log2(index + 2), 0);
  const idealDiscounted = ideal.reduce(
    (sum, score, index) => sum + score / Math.log2(index + 2),
    0
  );
  const ndcgAt20 = idealDiscounted === 0 ? 1 : discounted(actualTop) / idealDiscounted;
  return { exactEquality, exactIdEquality, maxScoreError, recallAt20, ndcgAt20 };
}
