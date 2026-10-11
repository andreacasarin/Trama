# LangChain rewrite: performance and package assessment

**Status: measured comparison.** The database figures below use the same exported-byte metric for both revisions. Results describe this deterministic local workload and do not establish general performance or live-provider behavior.

## Compared revisions and method

This assessment compares the pre-rewrite implementation at `e03133025f3acb68b75514dfbf18448e903cbbf0` with the approved rewrite at `86423c69ef8563dabebd4db252e88a53676853db`, measured on 2026-10-11. The paired runner builds and executes each revision sequentially in isolated work directories using Node.js 24.13, npm 11.6.2, an M1 Max, real in-memory SQLite WASM, and a deterministic fake provider with zero delay. Both revisions use the same pinned SQLite assets and the same 3,000-note corpus of 400-character Markdown files (SHA-256 `66d061b6c61c157587bf1dace04c6e72e7b0c5d3f8dd44393699d3b50f7b1c8a`). The run records declared revision labels and archive hashes; the runner does not independently verify archive contents against Git revisions.

The runner tests a 24-note smoke profile, a 300-note profile with one warmup and five fresh-index samples, and a 3,000-note profile with one warmup and three fresh-index samples. Query tests use five warmups and 30 queries per run, for 150 samples on the 300-note profile and 90 on the 3,000-note profile. Reports include cold indexing, no-op update, edit, delete, lexical search, hybrid search, and related-note lookup. The full test suite also checks sentinels, result paths and bounds, and cancellation. Automated checks passed: 71 tests across 19 files, build, type, lint, SQLite, and format checks.

Reproduction requires `npm ci --offline --ignore-scripts` to find both revisions' lockfile dependencies in the local npm cache. Building uses the pinned SQLite WASM fingerprint cache when available; a cache miss requires the project Docker build environment and socket. This run's baseline build populated the cache, which the current build reused.

Cold-index timing excludes child-process and Vitest startup. Both cold timers include SQLite WASM module initialization when first needed, database/client/schema setup, and the full initial index. Later fresh-database samples reuse the process's loaded WASM module; measured runs follow a warmup.

The `baseline` and `current` labels are supplied to the runner; it does not independently prove that a tar archive contains the named Git revision. When reproducing the report, retain each exact archive and record its hash alongside the revision IDs. The local output is written under `.ai/bench/langchain-assessment/`, which is ignored by Git.

## Results

Times are medians across repeated samples unless a range is shown. The fake provider has zero simulated latency. Provider round trips therefore show work performed but do not model endpoint delay; extra requests could change cold-index results with a real provider. These timings describe this workload only.

| Profile and operation                   |                  Before |                After |
| --------------------------------------- | ----------------------: | -------------------: |
| 3,000-note cold index                   | 19.52 s (19.41–19.71 s) | 8.62 s (8.03–8.64 s) |
| 3,000-note no-op update                 |               105.53 ms |            411.16 ms |
| 3,000-note edit                         |             1,556.73 ms |            413.43 ms |
| 3,000-note delete                       |             1,087.48 ms |            410.01 ms |
| 3,000-note lexical search, median (p95) |     29.07 ms (34.69 ms) |    0.91 ms (5.71 ms) |
| 3,000-note hybrid search, median (p95)  |     45.43 ms (63.03 ms) |  12.23 ms (15.77 ms) |
| 3,000-note related lookup, median (p95) |   112.18 ms (118.76 ms) |    2.75 ms (2.88 ms) |
| 300-note cold index                     |     238 ms (232–246 ms) |  668 ms (619–682 ms) |
| 300-note no-op update                   |                10.79 ms |             43.15 ms |
| 300-note edit                           |                56.34 ms |             45.71 ms |
| 300-note delete                         |                52.65 ms |             43.93 ms |

Exported database bytes increased from 2,662,400 to 4,235,264 bytes for 300 notes and from 23,371,776 to 41,312,256 bytes for 3,000 notes (76.8% for the larger profile). This is the serialized database export size, not allocated OPFS or filesystem size.

## Provider work and workload equivalence

| Workload              | Before                 | After                     |
| --------------------- | ---------------------- | ------------------------- |
| 3,000-note cold index | 24 calls / 3,005 texts | 3,000 calls / 3,000 texts |
| 300-note cold index   | 3 calls / 304 texts    | 300 calls / 300 texts     |
| 90 hybrid queries     | 6 embedding calls      | 90 embedding calls        |

Because the fake provider adds no delay, the 3,000-note cold-index timing does not capture the cost of the extra 2,976 HTTP requests. A real endpoint could reverse that comparison. This harness does not measure end-to-end LM Studio latency.

The compared indexing work is not internally equivalent. The previous implementation produced 6,000 structural chunks and 3,005 deduplicated cache-compatible vectors; the rewrite uses 3,000 default Markdown chunks and vectors. The baseline adapter forced related-note refresh, bypassing the old result cache. These changes affect both work and results, so the table compares representative behavior rather than identical internal operations.

## Code and package size

For `src/**/*.{ts,tsx,js,mjs}`, the previous implementation had 72 files, 19,158 physical lines, and 18,315 nonblank lines. The rewrite has 29 files, 4,549 physical lines, and 4,290 nonblank lines: about 76.3% fewer physical lines. The npm runtime dependency count changed from zero to five.

The local emitted main/worker code contribution changed from 342,363 to 76,684 bytes. The current build also emits 1,924,676 bytes of vendor modules and 2,363 bytes of bundler overhead. These emitted-module bytes are not source input lines, and gzip attribution is not additive.

| Emitted asset                                     |                    Before |                        After |
| ------------------------------------------------- | ------------------------: | ---------------------------: |
| `main.js`                                         | 217,257 B / 58,260 B gzip | 1,989,605 B / 502,231 B gzip |
| `sqlite-worker.mjs`                               | 125,726 B / 31,004 B gzip |      14,118 B / 4,780 B gzip |
| Six packaged assets, total raw bytes              |               2,761,782 B |         4,422,522 B (+60.1%) |
| Six packaged assets, sum of individual gzip sizes |                 945,876 B |         1,363,623 B (+44.2%) |

The SQLite JS/WASM, manifest, and styles are unchanged. The largest current vendor modules are Zod (518,892 B), OpenAI (421,185 B), LangChain core (391,638 B), LangSmith (216,626 B), and LangGraph (175,604 B). The local worker JavaScript is about 89% smaller, while total packaged assets are larger because the rewrite bundles runtime libraries.

## Behavior and limits

The rewrite retains Voce, Filo, Lente, Obsidian integration, approved local endpoints, read-only tools, privacy boundaries, native SQLite retrieval, and manual Update/Rebuild/Stop controls. It removes scheduled maintenance, publications, shared cache, diagnostics, and passage-style presentation. Retrieval changed from weighted structural FTS, recency, and probe reranking to body/path BM25 plus maximum-chunk vector RRF60; related-note lookup uses note centroids. The agent now exposes four native Responses tools instead of five prior tools. Initial indexing now uses provider calls where the earlier lexical build could be provider-free; cached lexical queries remain available offline.

The comparison does not demonstrate semantic-quality equivalence, a universal speedup, or live-provider performance. It does not validate Obsidian startup, desktop/mobile storage behavior, or live LM Studio agent tool execution. The unchanged Filo same-leaf refresh limitation predates this rewrite and is not a new regression. No new behavior or architecture decision follows from this measurement; the rewrite is an approved simplification, not a behavior-equivalence claim.

## Reproduction

Create the exact source archives for the two revisions, then run the paired comparison with explicit archive and output paths. Default local archive paths are not portable, so supply all three paths:

```sh
git archive --format=tar e03133025f3acb68b75514dfbf18448e903cbbf0 -o /private/tmp/trama-e031330.tar
git archive --format=tar 86423c69ef8563dabebd4db252e88a53676853db -o /private/tmp/trama-86423c6.tar
npm run benchmark:compare -- --baseline-tar /private/tmp/trama-e031330.tar --current-tar /private/tmp/trama-86423c6.tar --output-dir .ai/bench/langchain-assessment/local-run
```

For a quick 24-note validation, add `--smoke`. The full assessment uses the default 300- and 3,000-note profiles. Preserve the output report and archive hashes when publishing a final rerun. The measured raw report is `.ai/bench/langchain-assessment/run-20261011-b4/report.json`.

The rewrite substantially reduces owned source code and improves local query times on the large profile, while increasing packaged asset size and slowing no-op updates and small-profile cold indexing. Provider-call differences and the zero-delay fake provider leave real cold-index latency uncertain; this comparison does not measure semantic quality or live endpoint behavior.

## Working-tree batching follow-up

This separate, uncommitted follow-up compares the frozen pre-batching rewrite with a prepared working-tree patch that changes only two runtime files. SHA-256 provenance for those files is recorded in `.ai/bench/langchain-batching/run-20261011/report.json`; the working-tree patch is not a Git commit. The run uses the same corpus and deterministic, zero-delay in-memory embedding provider. It does not measure live endpoint latency.

| Profile and operation                  | Before batching |  Batched |
| -------------------------------------- | --------------: | -------: |
| 300-note cold index                    |        667.5 ms | 529.1 ms |
| 300-note no-op update                  |         43.2 ms |  16.7 ms |
| 300-note embedding calls, cold index   |             300 |        3 |
| 3,000-note cold index                  |          8.62 s |   5.70 s |
| 3,000-note no-op update                |          411 ms |   171 ms |
| 3,000-note embedding calls, cold index |           3,000 |       30 |

The corpus still produces 3,000 texts/vectors; exported database sizes are unchanged at 4,235,264 bytes for 300 notes and 41,312,256 bytes for 3,000 notes. Query sentinels, result bounds, and counts passed; query latencies were broadly similar in these runs. This follow-up is a local synthetic workload, not evidence of live-provider or end-to-end Obsidian performance.

## Post-COUNT-removal rerun

This rerun compares the prior batching snapshot with a newer working-tree snapshot after removing a redundant SQLite COUNT query. It uses the same plan, corpus (SHA-256 `66d061b6c61c157587bf1dace04c6e72e7b0c5d3f8dd44393699d3b50f7b1c8a`), SQLite assets, and batching-source hashes. The database-source patch hash changed; both report files record snapshot hashes and provenance. The new snapshot is uncommitted and is not represented as a Git revision. The local, ignored report outputs are `.ai/bench/langchain-small-optimizations/run-20261011/report.json` and `.ai/bench/langchain-batching/run-20261011/report.json`; rerun the documented benchmark method to regenerate them.

| Profile and operation                  | Prior batching snapshot | Post-COUNT-removal snapshot |
| -------------------------------------- | ----------------------: | --------------------------: |
| 3,000-note cold index                  |                  5.70 s |                      5.86 s |
| 3,000-note no-op update                |                171.4 ms |                    172.1 ms |
| 3,000-note edit                        |                175.7 ms |                    193.3 ms |
| 3,000-note delete                      |                169.2 ms |                    170.0 ms |
| 3,000-note lexical search, median      |                0.911 ms |                    0.898 ms |
| 3,000-note hybrid search, median (p95) |     12.52 ms (16.16 ms) |         10.78 ms (13.88 ms) |
| 3,000-note related lookup, median      |                2.787 ms |                    2.750 ms |
| 300-note hybrid search, median (p95)   |       1.71 ms (2.29 ms) |           1.58 ms (2.10 ms) |

The 300- and 3,000-note profiles used five fresh-index samples and three fresh-index samples respectively, after one warmup; queries used five warmups and 30 queries per run. The 24-note profile was a single smoke run. Cold-index embedding calls remained 1, 3, and 30 for the 24-, 300-, and 3,000-note profiles; text/vector counts and exported database sizes were unchanged at 24/425,984 bytes, 300/4,235,264 bytes, and 3,000/41,312,256 bytes. Query sentinels, result bounds, and counts passed.

Hybrid-search medians were lower in this snapshot, consistent with removing the redundant scan, but this historical comparison does not establish causation. Cold indexing and 3,000-note edits were slightly slower. Measurements use real in-memory SQLite WASM and a deterministic zero-delay provider in a headless runner; they do not validate LM Studio, Obsidian, OPFS, or end-to-end provider latency.
