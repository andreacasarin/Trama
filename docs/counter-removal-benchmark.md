# SQLite counter removal benchmark

> **Historical benchmark:** The in-memory runner described below has been retired. Its measurements are not current V1 performance claims. Use the [current-app benchmark guide](obsidian-benchmark.md) for new measurements.

## Workload and conditions

Measured the deterministic `trama-10k` profile through `node scripts/benchmark/run.mjs`, with `TRAMA_BENCHMARK_PROFILE=trama-10k`, `TRAMA_BENCHMARK_REPETITIONS=1`, and `TRAMA_BENCHMARK_TIMEOUT_MS=900000`. Each independent run used seed `99538792`, 1,100 notes, and 10,000 chunks. The benchmark exercises a full lexical build, no-op and reconciliation paths, uncached/cached/partial semantic work, scoped add/modify/delete/rename, publication and adoption, retrieval queries, and a chat-tool turn.

The baseline is the verified T1 tree before any T2 production edits. The after set uses the same machine and workload after counter removal and version bump. Both sets ran on Node `v24.13.0`, `darwin/arm64`; dependencies and benchmark settings were unchanged. Each report records all correctness checks as `true`: fixture and initial/final counts, semantic convergence and results, finite scores, mutation convergence, publication, and adoption. All six runs completed successfully.

## Raw duration timings

Milliseconds, in independent run order. Report files preserve the full raw evidence, including latency distributions, byte/memory measurements, counters, environment, and correctness:

- Baseline: `.artifacts/benchmarks/baseline/run-1.json` through `run-3.json`
- After: `.artifacts/benchmarks/after/run-1.json` through `run-3.json`

| Scenario                      |  Baseline runs 1 / 2 / 3 |     After runs 1 / 2 / 3 | Median change |
| ----------------------------- | -----------------------: | -----------------------: | ------------: |
| Full build                    | 2986.6 / 3101.6 / 3922.7 | 2450.1 / 2722.5 / 2570.3 |        -17.1% |
| Immediate no-op               |    0.106 / 0.102 / 0.104 |    0.085 / 0.079 / 0.080 |        -23.3% |
| Unchanged full reconciliation |    178.3 / 131.2 / 203.2 |    142.8 / 115.6 / 136.5 |        -23.5% |
| Semantic uncached             | 3750.1 / 3815.3 / 3869.9 | 3203.0 / 3192.5 / 3009.7 |        -16.3% |
| Semantic cached               |    110.4 / 108.6 / 116.2 |       95.9 / 89.9 / 85.4 |        -18.6% |
| Scoped add                    |       72.2 / 70.2 / 72.0 |       65.9 / 72.0 / 53.6 |         -8.6% |
| Scoped modify                 |       74.6 / 68.9 / 73.1 |       64.3 / 58.1 / 58.3 |        -20.3% |
| Semantic partial              |    123.1 / 117.9 / 117.5 |      102.3 / 93.8 / 94.9 |        -19.5% |
| Scoped delete                 |       71.2 / 70.8 / 71.3 |       64.0 / 56.8 / 53.7 |        -20.2% |
| Scoped rename                 |       63.0 / 66.4 / 69.0 |       53.8 / 61.5 / 50.3 |        -19.0% |
| Publish                       | 1823.9 / 1762.2 / 1755.7 | 1578.1 / 1494.2 / 1338.9 |        -15.2% |
| Publication adopt             |    957.3 / 995.9 / 921.2 |    805.1 / 806.6 / 739.2 |        -15.9% |
| Queries                       | 1173.1 / 1204.1 / 1155.7 |  1024.0 / 1010.6 / 924.6 |        -13.9% |
| Chat-tool turn                |    380.1 / 399.9 / 426.6 |    348.4 / 338.5 / 319.8 |        -15.4% |

## Variability and conclusion

Baseline spread (min–max) was 2,986.6–3,922.7 ms for full build, 3,750.1–3,869.9 ms for uncached semantic work, 1,755.7–1,823.9 ms for publication, and 921.2–995.9 ms for adoption. The corresponding after spreads were 2,450.1–2,722.5 ms, 3,009.7–3,203.0 ms, 1,338.9–1,578.1 ms, and 739.2–806.6 ms. No measured scenario's after median regressed; most after ranges also sit below baseline ranges. The scoped-add ranges overlap, and no tolerance threshold was preselected.

The measured evidence does not show a meaningful regression, so no benchmark-driven adjustment was needed. The broad improvement is consistent with removing repeated aggregate-count maintenance, but these are short sequential runs on a shared machine, not an isolated causal experiment. Warm-up, scheduling, and machine load may contribute. Three runs per side provide only a limited estimate of variability; the timing shift should not be presented as a guaranteed production speedup.
