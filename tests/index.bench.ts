import { bench, describe } from "vitest";

// Opt-in scale probe for the contiguous exact Float32 scan primitive. It does
// not construct an Obsidian DataAdapter corpus, Orama index, or hybrid
// retriever, so it deliberately makes no claims about those layers.
const chunks = Number(process.env.TRAMA_BENCH_CHUNKS ?? 25_000);
const dimensions = Number(process.env.TRAMA_BENCH_DIMENSIONS ?? 768);
const sampleCount = Number(process.env.TRAMA_BENCH_SAMPLES ?? 7);
if (![25_000, 50_000, 100_000].includes(chunks))
  throw new Error("TRAMA_BENCH_CHUNKS must be 25000, 50000, or 100000");
if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 16_384)
  throw new Error("TRAMA_BENCH_DIMENSIONS must be an integer from 1 to 16384");
if (!Number.isSafeInteger(sampleCount) || sampleCount < 5 || sampleCount > 30)
  throw new Error("TRAMA_BENCH_SAMPLES must be an integer from 5 to 30");

const vectors = new Float32Array(chunks * dimensions);
for (let i = 0; i < vectors.length; i++) vectors[i] = ((i * 17) % 101) / 100;
const query = new Float32Array(dimensions);
query.fill(1 / Math.sqrt(dimensions));

function exactScan(): number {
  let best = -Infinity;
  for (let row = 0; row < chunks; row++) {
    let score = 0;
    const offset = row * dimensions;
    for (let column = 0; column < dimensions; column++)
      score += vectors[offset + column] * query[column];
    if (score > best) best = score;
  }
  return best;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function measureScan(): { p50Ms: number; p95Ms: number } {
  exactScan();
  const samples: number[] = [];
  for (let sample = 0; sample < sampleCount; sample++) {
    const startedAt = performance.now();
    void exactScan();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((a, b) => a - b);
  return {
    p50Ms: Number(percentile(samples, 0.5).toFixed(2)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
  };
}

const measured = measureScan();
const summary = `TRAMA_INDEX_BENCHMARK p50=${measured.p50Ms}ms p95=${measured.p95Ms}ms vectorBytes=${vectors.byteLength} samples=${sampleCount}`;

describe(`exact Float32 scan (${chunks} chunks × ${dimensions} dimensions); ${summary}`, () => {
  bench(
    "exact semantic scan",
    () => {
      void exactScan();
    },
    {
      iterations: 3,
      warmupIterations: 1,
    }
  );
});
