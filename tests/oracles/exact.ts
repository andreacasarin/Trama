export interface OracleChunk {
  readonly id: string;
  readonly path: string;
  readonly ordinal: number;
  readonly vector: Float32Array;
  readonly text?: string;
}

export interface OracleHit {
  readonly id: string;
  readonly path: string;
  readonly ordinal: number;
  readonly score: number;
  readonly text?: string;
}

function compare(a: OracleHit, b: OracleHit): number {
  const pathOrder = a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  const idOrder = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return b.score - a.score || pathOrder || a.ordinal - b.ordinal || idOrder;
}

export function exactSemanticOracle(
  chunks: readonly OracleChunk[],
  query: Float32Array,
  limit: number
): readonly OracleHit[] {
  let norm = 0;
  for (const value of query) norm += value * value;
  if (!(norm > 0) || !Number.isFinite(norm))
    throw new Error("Oracle query vector must be non-zero");
  const queryScale = 1 / Math.sqrt(norm);
  const hits: OracleHit[] = [];
  for (const chunk of chunks) {
    let score = 0;
    let chunkNorm = 0;
    for (let index = 0; index < query.length; index++) {
      const value = chunk.vector[index] ?? 0;
      score += query[index] * value;
      chunkNorm += value * value;
    }
    if (!(chunkNorm > 0) || !Number.isFinite(chunkNorm)) continue;
    score *= queryScale / Math.sqrt(chunkNorm);
    hits.push({
      id: chunk.id,
      path: chunk.path,
      ordinal: chunk.ordinal,
      score: Math.max(-1, Math.min(1, score)),
      ...(chunk.text === undefined ? {} : { text: chunk.text }),
    });
  }
  return hits.sort(compare).slice(0, Math.max(0, limit));
}

export function assertOracleScores(
  actual: readonly OracleHit[],
  expected: readonly OracleHit[],
  tolerance = 1e-5
): void {
  if (actual.length !== expected.length)
    throw new Error(`Oracle result length mismatch: ${actual.length} !== ${expected.length}`);
  for (let index = 0; index < expected.length; index++) {
    if (actual[index].id !== expected[index].id)
      throw new Error(
        `Oracle ID mismatch at ${index}: ${actual[index].id} !== ${expected[index].id}`
      );
    if (Math.abs(actual[index].score - expected[index].score) > tolerance)
      throw new Error(`Oracle score mismatch at ${index}`);
  }
}
