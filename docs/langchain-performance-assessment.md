# LangChain rewrite: performance and package assessment

**Historical assessment.** All measurements below preserve results from retired benchmark runners and describe their original workloads only. They do not establish current-app timings or general performance claims. For current comparisons in the normal Obsidian application, follow the [current benchmark guide](obsidian-benchmark.md).

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

## Historical reproduction: retired paired runner

The source-archive runner below has been removed and cannot reproduce a current-app comparison. Keep this command as historical context for the measurements immediately above; use the [current benchmark guide](obsidian-benchmark.md) for new before/after observations.

```sh
git archive --format=tar e03133025f3acb68b75514dfbf18448e903cbbf0 -o /private/tmp/trama-e031330.tar
git archive --format=tar 86423c69ef8563dabebd4db252e88a53676853db -o /private/tmp/trama-86423c6.tar
npm run benchmark:compare -- --baseline-tar /private/tmp/trama-e031330.tar --current-tar /private/tmp/trama-86423c6.tar --output-dir .ai/bench/langchain-assessment/local-run
```

This historical runner used a 24-note smoke mode and 300- and 3,000-note profiles. Its measured raw report was `.ai/bench/langchain-assessment/run-20261011-b4/report.json`; these instructions no longer describe a supported command.

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

## Fresh committed comparison — 2026-10-12

This fresh paired comparison builds baseline `e03133025f3acb68b75514dfbf18448e903cbbf0` and current `66ebd201e0c69945709445d00d632cd8df698abe` from exact source archives. It uses the same corpus, 768-dimensional deterministic zero-delay provider, in-memory SQLite WASM, M1 Max, and Node 24, with each revision's own lockfile and matching SQLite asset hashes. Builds used a temporary current-revision label override and type-only `number[][]` assertions in both adapters; these did not change runtime vectors or tracked source. The harness records declared labels and archive provenance but does not independently validate them against Git. The ignored raw report is `.ai/bench/langchain-final-comparison/run-20261012/report.json`.

The 300-note profile used five fresh-index samples and the 3,000-note profile used three, each after one warmup. Queries used five warmups and 30 queries per run; the 24-note profile was a single smoke run.

| 3,000-note operation         |                Baseline |              Current | Observed comparison |
| ---------------------------- | ----------------------: | -------------------: | ------------------: |
| Cold index, median (range)   | 20.67 s (20.48–21.78 s) | 5.80 s (5.70–5.82 s) |        3.57× faster |
| No-op update                 |               133.63 ms |            188.52 ms |          41% slower |
| Edit                         |             1,707.46 ms |            194.08 ms |        8.80× faster |
| Delete                       |             1,263.32 ms |            192.43 ms |        6.57× faster |
| Lexical query, median (p95)  |     32.48 ms (37.48 ms) |    1.09 ms (6.59 ms) | 29.8× faster median |
| Hybrid query, median (p95)   |     49.48 ms (67.90 ms) |  12.07 ms (17.07 ms) | 4.10× faster median |
| Related lookup, median (p95) |   122.07 ms (128.59 ms) |    3.03 ms (3.70 ms) | 40.2× faster median |

At 300 notes, cold indexing was 266.26 ms versus 490.29 ms (1.84× slower), and no-op update was 14.46 ms versus 19.12 ms (32% slower). These are measurements of this workload, not general performance guarantees.

The compared work is not semantically equivalent. The baseline generated 6,000 structural chunks and 3,005 deduplicated cache-compatible vectors; the current implementation uses 3,000 default Markdown chunks and vectors. Cold indexing used 24 provider calls and 3,005 texts at baseline versus 30 calls and 3,000 texts currently. Hybrid queries made 6 calls for 90 queries at baseline and 90 calls for 90 queries currently; the baseline forced related-note refresh, bypassing its old result cache. These differences affect both work and results, and the benchmark does not measure semantic quality.

Exported database size at 3,000 notes increased from 23,371,776 to 41,312,256 bytes (1.77×). Across the six packaged assets, raw size increased from 2,761,782 to 4,423,170 bytes (60%); the sum of individual gzip sizes increased from 945,875 to 1,363,819 bytes (44%). `main.js` changed from 217,257 to 1,990,378 bytes, and the worker from 125,726 to 13,993 bytes. Sentinels, counts, result bounds, and vector-transfer checks passed. The zero-delay provider and headless in-memory SQLite setup do not validate live LM Studio latency, Obsidian, OPFS, or result quality.

## Vector rowid experiment — 2026-10-12

This experiment compares fresh copies of `66ebd201e0c69945709445d00d632cd8df698abe`: the control and a candidate that removes `WITHOUT ROWID` only from `note_vectors`. Composite primary-key constraints, centroids, and native UID behavior are retained. Both runs use the same corpus (SHA-256 `66d061b6c61c157587bf1dace04c6e72e7b0c5d3f8dd44393699d3b50f7b1c8a`), SQLite assets, and deterministic zero-delay 768-dimensional provider. Snapshot hashes and provenance are in `.ai/bench/vector-rowid/run-20261012/summary.json` and `.ai/bench/vector-rowid/run-20261012/storage-summary.json`.

The 300-note profile used five fresh-index samples and the 3,000-note profile used three, each after one warmup. Queries used five warmups and 30 queries per run; the 24-note profile was a smoke run only.

| 3,000-note operation       |              Control |             Candidate |
| -------------------------- | -------------------: | --------------------: |
| Exported database size     |         41,312,256 B | 25,583,616 B (-38.1%) |
| Cold index                 |              5.005 s |               4.811 s |
| No-op update               |            173.15 ms |             184.12 ms |
| Edit                       |            182.05 ms |             188.94 ms |
| Delete                     |            180.59 ms |             198.81 ms |
| Lexical query              |             0.928 ms |              0.999 ms |
| Hybrid query, median (p95) | 11.226 ms (14.51 ms) |    5.252 ms (8.88 ms) |
| Related lookup             |             2.875 ms |              2.654 ms |

The vector payload is identical at 9,236,872 bytes. Vector allocation decreased from 28,090,368 to 12,312,576 bytes; vector pages fell from 3,429 to 1,503, and overflow pages fell from 3,000 to zero. The candidate added a 49,152-byte unique index. Total pages decreased from 5,043 to 3,123 at 8,192 bytes per page, with no freelist pages. The centroid-bearing `note_index` table was unchanged at 12,312,576 bytes. At 300 notes, exported database size fell from 4,235,264 to 2,662,400 bytes (37.1%); cold indexing was 465.68 versus 480.52 ms, and hybrid lookup was 1.690 versus 1.201 ms.

This fresh-database experiment shows a storage reduction and a lower observed hybrid-query median, while no-op updates and writes were slightly slower and delete timing varied. It does not guarantee improvement across operations. The candidate's `CREATE TABLE IF NOT EXISTS` behavior does not convert existing databases; no vault database was changed and no migration or automatic reset was tested. The synthetic provider and in-memory SQLite run do not measure live LM Studio, Obsidian, OPFS, or semantic quality. This experiment records evidence, not a migration policy.

## SQLite embedding-cache comparison — 2026-10-13

The cache snapshots in the two 2026-10-13 sections below predate the later endpoint-independent cache identity based on trimmed model ID and dimensions. Those measurements do not evaluate that identity change; all other historical figures and provenance remain as recorded.

This paired run compares uncached commit `50fa` with a working-tree snapshot of that commit plus document-cache and publication-receipt fixes. The snapshot is identified by archive SHA-256 `57d208666c43637b3f40098b28bfe009194715a548941e8dd01def578ce0aeaf`; it is not a committed revision. Both builds used the same corpus, 768-dimensional zero-delay provider, in-memory SQLite WASM, and each revision's own lockfile. The ignored raw report is `.ai/bench/sqlite-embedding-cache/run-20261013/uncached-comparison-final/report.json`.

The 300-note profile used five fresh-index samples and the 3,000-note profile used three, each after one warmup. Queries used five warmups and 30 per run; the 24-note profile was a smoke run.

| Profile and operation     |    Uncached |       Cache snapshot |
| ------------------------- | ----------: | -------------------: |
| 3,000-note cold index     | 4,962.74 ms | 5,779.67 ms (+16.5%) |
| 3,000-note no-op update   |   188.18 ms |            198.87 ms |
| 3,000-note edit           |   192.16 ms |            203.51 ms |
| 3,000-note delete         |   184.03 ms |            197.55 ms |
| 3,000-note lexical query  |     1.02 ms |              1.04 ms |
| 3,000-note hybrid query   |     5.24 ms |              5.73 ms |
| 3,000-note related lookup |     2.73 ms |              2.75 ms |
| 300-note cold index       |   503.35 ms |   590.27 ms (+17.3%) |

For 90 measured hybrid queries, provider calls fell from 90 to 6. Cold indexing still made 30 provider calls and embedded 3,000 texts on both sides. At 3,000 notes, exported database size grew from 25,583,616 to 39,174,144 bytes (+53.1%); the cache stored 2,999 unique document vectors alongside the index's 3,000 vectors and centroids. At 300 notes, database size grew from 2,662,400 to 4,063,232 bytes while measured query calls fell from 150 to 10.

A separate second-database bootstrap indexed 3,000 notes and vectors with zero provider requests; its median time was 5,725.15 ms. Its 24 cache artifacts occupied 12,502,544 bytes; after one edit, 25 artifacts occupied 12,506,825 bytes. This used an in-memory vault adapter and does not validate real vault synchronization. `main.js` changed from 1,990,378 to 2,000,264 bytes (502,459 to 505,357 bytes gzip); the worker changed from 13,979 to 21,755 bytes (4,747 to 6,328 bytes gzip).

This is a synthetic comparison of an uncached commit and an uncommitted cache snapshot. It does not test a live provider or real sync transport, establish semantic quality, or show that cached and uncached outputs are interchangeable. Cold indexing was slower in both measured profiles, while query timings were broadly similar; the observed request reduction comes with additional local database and package storage.

## Legacy-to-cache comparison — 2026-10-13

This is a separate fresh pair comparing baseline `e03133025f3acb68b75514dfbf18448e903cbbf0` with the declared `50fa` revision plus the cache working-tree snapshot, archive SHA-256 `57d208666c43637b3f40098b28bfe009194715a548941e8dd01def578ce0aeaf`. It uses the same corpus, SQLite assets, and deterministic 768-dimensional zero-delay provider. The 300-note profile used five fresh-index samples and the 3,000-note profile three, each after one warmup; queries used five warmups and 30 per run. The ignored raw report is `.ai/bench/sqlite-embedding-cache/run-20261013/legacy-comparison-final/report.json`.

| 3,000-note operation |         Legacy median (p95) |        Cache median (p95) |
| -------------------- | --------------------------: | ------------------------: |
| Cold index           | 20,344.00 ms (20,544.45 ms) | 5,757.37 ms (5,980.18 ms) |
| No-op update         |       113.93 ms (117.42 ms) |     190.48 ms (192.04 ms) |
| Edit                 |   1,652.14 ms (1,681.93 ms) |     196.98 ms (202.18 ms) |
| Delete               |   1,196.34 ms (1,235.34 ms) |     187.76 ms (206.28 ms) |
| Lexical query        |         32.51 ms (40.99 ms) |         0.98 ms (5.26 ms) |
| Hybrid query         |         48.75 ms (74.25 ms) |         5.38 ms (9.30 ms) |
| Related lookup       |       118.02 ms (125.33 ms) |         2.71 ms (3.06 ms) |

Provider calls for 90 measured hybrid queries were six on both sides. Cold indexing used 24 provider calls and 3,005 texts at baseline versus 30 calls and 3,000 texts in the cache snapshot. At 3,000 notes, exported database size increased from 23,371,776 to 39,174,144 bytes (67.6%). The baseline produced 6,000 structural chunks and 3,005 deduplicated vectors; the cache snapshot used 3,000 default Markdown chunks and 3,000 vectors. At 300 notes, cold indexing was 266.30 versus 603.32 ms and no-op update was 13.87 versus 20.81 ms; edit and delete were 83.67 versus 25.68 ms and 67.98 versus 22.29 ms.

The cache snapshot's second-database bootstrap took a median 5,949 ms in the in-memory vault adapter with zero provider calls; this pair's bootstrap artifacts had 24 files. The legacy-pair build changed `main.js` from 217,257 to 2,000,264 bytes (58,261 to 505,358 bytes gzip) and the worker from 125,726 to 21,755 bytes (31,005 to 6,329 bytes gzip); SQLite assets were unchanged.

The pairs have different chunking, ranking, and related-result cache behavior, so their timings do not establish equivalent result quality or isolate the cache's causal effect. This zero-delay-provider comparison does not measure live endpoint latency or real vault synchronization.

## Publication phase and cache format experiment — 2026-10-13

These measurements use the current cache implementation and a separate SQLite-file-format prototype. They use the same deterministic 768-dimensional vector fixture, in-memory SQLite WASM, in-memory vault adapter, and 24-note smoke, 300-note, and 3,000-note profiles. The 300-note profile used five samples and the 3,000-note profile three. The current-run report is `.ai/bench/sqlite-embedding-cache/publication-20261013/current-final/report.json`; the format comparison report is `.ai/bench/sqlite-embedding-cache/publication-20261013/format-comparison-final/format-report.json`.

The production publisher's measured phase is included in each total and is not additive to it. “Temporary writes” counts local temporary cache-file writes, not remote vault synchronization.

| Current cache operation | Total median | Publication phase median (p95) | Temporary writes | Bytes written |
| ----------------------- | -----------: | -----------------------------: | ---------------: | ------------: |
| 300-note cold index     |    578.91 ms |               79.77 ms (81.09) |                3 |     1,246,571 |
| 3,000-note cold index   |  5,772.86 ms |             793.34 ms (801.47) |               24 |    12,502,544 |
| 3,000-note no-op update |    192.32 ms |                        2.49 ms |                0 |             0 |
| 3,000-note edit         |    204.45 ms |                        5.39 ms |                1 |         4,281 |
| 3,000-note delete       |    188.99 ms |                        2.54 ms |                0 |             0 |

A separate 3,000-note bootstrap of a second local index completed in a median 5,895.93 ms with zero provider calls and 3,000 notes/vectors. Its initial cache contained 24 files and 12,502,544 bytes; a later edit produced a 25th file, so that final file count is not the bootstrap count.

The format comparison seeded the same deterministic vector fixture outside the timed publication phase, then alternated JSON and SQLite-shard publication in one process. The SQLite prototype publishes document vectors only; its timed work includes ATTACH, schema setup, copying, VACUUM, export, file write and verification, and DETACH. Receipt-count checks run after the timed phase in both arms. A separate exact comparison after SQLite deserialization covered 2,999 document vectors for 3,000 notes and 299 for 300 notes; it took 9.275 ms and 1.228 ms, respectively.

| Profile     |    JSON median (p95) | SQLite-shard median (p95) | JSON files | SQLite files | JSON bytes |        SQLite bytes |
| ----------- | -------------------: | ------------------------: | ---------: | -----------: | ---------: | ------------------: |
| 300 notes   |   78.918 ms (85.773) |          4.676 ms (5.119) |          3 |            3 |  1,246,571 |  1,359,872 (+9.09%) |
| 3,000 notes | 782.971 ms (806.053) |        44.289 ms (48.535) |         24 |           24 | 12,502,544 | 13,451,264 (+7.59%) |

This prototype was a measurement, not an adopted format change. It did not test `VACUUM INTO`, OPFS durability, real vault synchronization, live-provider latency, incremental publication alternatives, or semantic quality. At the time of that experiment, the production format remained unchanged; its in-memory results alone did not establish end-to-end performance in Obsidian.

## Production OPFS shard comparison — 2026-10-14

This paired comparison measures the frozen JSON cache snapshot (`cf8e2902ef6582cafc09d28b445d41593222af4376ad2919b020c61ea502d0d3`) against the production SQLite-shard snapshot (`1bfef414f52958c38186d80caf2968ebd67a2c62a2407bcae16c1a6b8f0729bc`). Both used the same corpus, 768-dimensional deterministic provider fixture, SQLite WASM assets, and lockfile. Publication ran through the production worker on Brave 154 with a real SAH OPFS pool and an in-memory vault adapter; this does not measure actual vault synchronization. The raw report is `.ai/bench/sqlite-embedding-cache/opfs-performance-20261014-final/report.json` (SHA-256 `33e5ae23e9a9400429f0817ca59db9d8a51cd22138166a6a4c281ab1f3954fb8`). Production-worker OPFS validation is recorded in `.ai/bench/sqlite-embedding-cache/opfs-20261014/production-worker-opfs.json`.

The 300-note profile used five samples and the 3,000-note profile used three. The 24-note profile was a smoke run. The publication phase is included in cold-index totals and must not be added to them. The measured production path uses native SQL to select and copy vectors into file-backed scratch databases, `VACUUM INTO` to create each shard, and VFS export; the import path validates and copies into the local cache using SQLite. No per-step OPFS timings were collected.

| Operation               |   300-note JSON |           300-note SQLite |   3,000-note JSON |           3,000-note SQLite |
| ----------------------- | --------------: | ------------------------: | ----------------: | --------------------------: |
| Cold index              |     1,198.07 ms |               2,485.47 ms |       9,478.29 ms |                24,337.27 ms |
| Publication phase       |       107.47 ms |               1,567.02 ms |       1,045.95 ms |                15,255.30 ms |
| Fresh-device bootstrap  |       973.72 ms |               1,235.99 ms |       9,221.01 ms |                 8,825.08 ms |
| Published files / bytes | 3 / 1,246,571 B | 3 / 1,409,024 B (+13.03%) | 24 / 12,502,544 B | 24 / 13,844,480 B (+10.73%) |

At 3,000 notes, no-op update was 407.38 ms for JSON and 440.62 ms for SQLite; edit was 433.70 versus 481.61 ms, and delete was 410.98 versus 461.36 ms. Lexical, hybrid, and related-query medians were similar (1.31/13.30/3.02 ms for JSON and 1.36/13.94/3.06 ms for SQLite). Both made six provider calls across 90 measured hybrid queries. Fresh-device bootstrap made zero provider calls in both cases. The local SQLite database was 39,174,144 bytes in both snapshots, with 3,000 notes/vectors and 2,999 cached document vectors.

In this pre-optimization snapshot, SQLite shard publication was substantially slower than JSON publication, while producing artifacts 10–13% larger. Fresh-device bootstrap timings were similar and varied by profile. The benchmark did not measure live provider latency or real sync; these results do not establish semantic equivalence or broad end-to-end performance in Obsidian.

## OPFS receipt batching comparison — 2026-10-14

This paired comparison isolates the bounded receipt-insert optimization in the production SQLite-shard path. It compares the earlier SQLite implementation (`1bfef414f52958c38186d80caf2968ebd67a2c62a2407bcae16c1a6b8f0729bc`) with the receipt-batched implementation (`94945f991f82d6912c7c8916af50c53420be7ec7f7ea6b3f3a02f464fe546b7d`). Both use the production `VACUUM INTO` and OPFS export path; shard format, VFS workflow, corpus, SQLite assets, and provider fixture are unchanged. The receipt write now uses one bounded native `INSERT ... SELECT` for up to 128 document hashes per shard, with cancellation checks between SQL steps and before commit. The raw paired report is `.ai/bench/sqlite-embedding-cache/opfs-receipts-20261014/report.json` (SHA-256 `05904dc80ec6548c9697914e4085e41def20090f9d18bc5d49000d59cdfd2dcd`); the focused OPFS profile is `.ai/bench/sqlite-embedding-cache/opfs-profile-20261014/profile.json` (SHA-256 `71418ff7b6ca23fa2bd173206362469f091446e417d636eb94a136d8173b6517`).

Runs used Brave 154, a real SAH OPFS worker, SQLite WASM, an in-memory vault adapter, and a deterministic 768-dimensional provider fixture. The 300-note profile used five samples; the 3,000-note profile used three; the 24-note profile was a smoke run. Publication timing is included in cold-index totals. These snapshots are a causal pair for the receipt optimization; their absolute timings should not be compared directly with the earlier JSON-to-SQLite pair.

| Operation              | 300-note old SQL | 300-note batched SQL | 3,000-note old SQL | 3,000-note batched SQL |
| ---------------------- | ---------------: | -------------------: | -----------------: | ---------------------: |
| Cold index             |      3,159.70 ms |          1,444.66 ms |       31,905.10 ms |           14,675.80 ms |
| Publication phase      |      1,857.84 ms |            103.91 ms |       18,169.12 ms |              802.04 ms |
| No-op update           |                — |                    — |          537.46 ms |              520.72 ms |
| Edit                   |                — |                    — |          561.37 ms |              548.25 ms |
| Delete                 |                — |                    — |          517.63 ms |              512.91 ms |
| Fresh-device bootstrap |                — |                    — |       13,809.98 ms |           13,690.98 ms |

At 3,000 notes, publication time fell by about 22.7× and cold indexing by about 2.2× in this pair. The focused profile identified the earlier cost: per-hash receipt writes yielded 3,023 times and took 14,056.95 ms (86.54% of publication), while the measured `VACUUM INTO` step took 143.52 ms across 24 artifacts. The cache held 24 artifacts totaling 13,844,480 bytes in both paired runs; the local database was 39,174,144 bytes in both. Both versions made 30 embedding calls for 3,000 texts during cold indexing and six calls across 90 measured hybrid queries. Lexical/hybrid/related-query medians were similar (1.04/11.77/2.48 ms before and 0.99/11.50/2.45 ms after). Fresh-device bootstrap made zero provider calls in both versions.

This comparison measures the receipt-write change, not JSON versus SQLite. It did not measure live provider latency or real vault synchronization; it establishes neither semantic quality nor broad end-to-end Obsidian performance.

## Original-to-final OPFS comparison — 2026-10-14

This fresh committed comparison measures the original implementation (`e03133025f3acb68b75514dfbf18448e903cbbf0`, archive SHA-256 `17d4d756bd05c073d39f52b2d97c15e4504005dd18b50b6353c79df4206d46f5`) against the final implementation (`b32f6be97af9a4502b2f00e72d38cd770c0e86ab`, archive SHA-256 `4dfa29190c831a96e2b58bdb0e79f6dded1e1b546bd8f83eb0b6573798f46b83`). The raw report is `.ai/bench/final-vs-original-20261014/final/report.json` (SHA-256 `c280e7f3553f2c178e500fba1ae3c158d4907a6aff420e8be2164d6daff2de73`); its summary is in `.ai/bench/final-vs-original-20261014/final/summary.json`.

Both versions ran in Brave 154 with production workers, a real SAH OPFS pool, the same SQLite WASM, corpus, 768-dimensional deterministic provider fixture, and in-memory vault artifact transport. The 300-note profile used five samples and the 3,000-note profile three, each with one warmup; queries used five warmups and 30 queries per sample. The 24-note profile was a smoke run. Cold indexing measures the full manual update including publication but excludes initial worker/index load; publication is a subset and must not be added to the total. Fresh-device bootstrap excludes runtime initialization. This does not measure live model or real sync latency.

| 3,000-note operation   | Original median | Final median |   Comparison |
| ---------------------- | --------------: | -----------: | -----------: |
| Cold update            |    21,607.65 ms | 14,649.54 ms |  32.2% lower |
| Publication phase      |     1,255.16 ms |    864.91 ms |  31.1% lower |
| No-op update           |       116.12 ms |    551.82 ms | 4.75× slower |
| Edit                   |       549.78 ms |    639.82 ms | 16.4% slower |
| Delete                 |       118.00 ms |    555.97 ms | 4.71× slower |
| Fresh-device bootstrap |    15,704.19 ms | 14,287.68 ms |   9.0% lower |

At 300 notes, cold update was 466.71 ms for the original and 1,465.95 ms for the final (3.14× slower); publication was 85.63 versus 94.05 ms. No-op update was 40.57 versus 68.59 ms, edit 56.40 versus 100.48 ms, delete 18.28 versus 69.12 ms, and fresh-device bootstrap 352.74 versus 1,295.37 ms. Both bootstraps made zero provider calls.

Pooled query medians (p95) in milliseconds, original to final, were lexical 29.665 (35.740) to 1.155 (5.173), hybrid 46.397 (63.932) to 13.225 (20.832), and related-note lookup 113.165 (121.813) to 2.783 (3.310). Both made six provider calls across 90 measured hybrid queries; lexical and related lookup made none. The original related lookup also recomputed results rather than using its result cache.

The implementations do different work and do not establish equivalent results or quality. The original produced 6,000 structural chunks and 3,005 distinct document vectors; the final uses 3,000 default Markdown chunks/vectors, 3,000 centroids, and 2,999 cached document vectors. Cold indexing made 24 provider calls for 3,005 texts in the original and 30 calls for 3,000 texts in the final. The original shared serialized embedding inputs alongside document and query vectors in its plain-VACUUM cache; the final shares document-hash vectors only in v2 SQLite shards created with `VACUUM INTO`, while query embeddings stay local. After querying, an original no-op update published one query shard; the final published none. The original also used a mutation-journal shortcut and targeted events, while the final reads notes and runs LangChain indexing/cleanup on each manual update.

At 3,000 notes, the local database grew from 26,591,232 to 39,174,144 bytes (47.3%). Shared cache artifacts changed from 14,458,880 bytes across six files to 13,844,480 bytes across 24 files (4.2% fewer bytes). Combined database and shared-artifact storage increased from 41,050,112 to 53,018,624 bytes (29.2%). The final stores cached document vectors, search vectors, and centroids; the original stored deduplicated cache vectors without centroids. No page-level partition of the database-size difference was measured. At 300 notes, database size changed from 2,981,888 to 4,063,232 bytes, while artifacts changed from 1,482,752 bytes in one file to 1,409,024 bytes in three.

The packaged main bundle changed from 217,257 bytes (58,259 gzip) to 1,998,502 bytes (504,830 gzip); the worker changed from 125,726 bytes (31,004 gzip) to 25,791 bytes (7,563 gzip). SQLite JavaScript and WASM assets were unchanged. Combined main, worker, and SQLite assets increased from 2,754,388 to 4,435,698 bytes raw, and from 944,007 to 1,367,137 bytes as the sum of individual gzip sizes. These synthetic results show mixed workload effects: large-vault cold updates and searches were lower, while no-op, edit, and delete operations were slower, especially on the small profile. They do not prove equivalent retrieval quality or predict live-provider, vault-sync, mobile, or end-to-end Obsidian performance.

The esbuild metafiles report the repository-code contribution to main-plus-worker minified output changing from 342,363 to 95,604 bytes (72.1% lower), with 1,926,326 raw bytes of current vendor modules in `main.js`. These are emitted bytes, not source-line counts; gzip totals are not attributed by module. Bundle provenance is recorded in `.ai/bench/final-vs-original-20261014/`.

## RecordManager UPSERT batching comparison — 2026-10-15

This paired OPFS run isolates the bounded RecordManager UPSERT change. It compares the prior production implementation (`b32f6be97af9a4502b2f00e72d38cd770c0e86ab`, archive SHA-256 `4dfa29190c831a96e2b58bdb0e79f6dded1e1b546bd8f83eb0b6573798f46b83`) with the candidate (archive SHA-256 `ac54f9a9ea3d5707fa4366a1ff03c14b91bd9288c0f0ab646bafe441436cfbbe`). The only runtime change was replacing per-key RecordManager writes with bounded native multi-row UPSERTs. The LangChain indexing and cleanup lifecycle, 100-note window, transaction and clock semantics, grouping and duplicate behavior, schema, cache format, `VACUUM INTO` publication, and provider workload were unchanged. The report is `.ai/bench/record-manager-20261015/paired/report.json` (SHA-256 `9f8c18bad4191388e057de00a8795a14e79d9131f9339fe2565d774abb9ba85a`); a separate diagnostic profile is `.ai/bench/record-manager-20261015/profile/report.json`.

Both runs used Brave 154.1 on an M1 Max with real SAH OPFS workers, the same shipped SQLite WASM and package lockfiles, the same corpus and plan, a deterministic 768-dimensional provider fixture, and an in-memory vault adapter. The 300-note profile used five samples and the 3,000-note profile three; the 24-note profile was a smoke run. The comparison used the regular production esbuild output. The environment lacked the Docker SQLite build needed for a fresh SQLite WASM build, so both sides reused the identical pinned shipped WASM assets.

| Operation              | 300-note prior | 300-note batched | 3,000-note prior | 3,000-note batched |
| ---------------------- | -------------: | ---------------: | ---------------: | -----------------: |
| No-op update           |       54.33 ms |         57.43 ms |        565.36 ms |          445.76 ms |
| Delete                 |       45.92 ms |         42.62 ms |        560.23 ms |          440.95 ms |
| Edit                   |       85.86 ms |         73.13 ms |        591.25 ms |          477.67 ms |
| Cold update            |    1,373.91 ms |      1,303.54 ms |     12,869.20 ms |       11,173.57 ms |
| Publication phase      |      100.34 ms |         91.35 ms |        572.21 ms |          566.33 ms |
| Fresh-device bootstrap |    1,164.84 ms |      1,370.16 ms |     12,577.57 ms |       11,908.31 ms |

At 3,000 notes, no-op update and delete were about 21% lower, edit about 19% lower, and cold update about 13% lower; publication time changed by about 1%. At 300 notes, no-op update was 5.7% slower and fresh-device bootstrap 17.6% slower, while delete, edit, and cold update were lower. This small-sample workload does not show a uniform gain. Query medians were effectively flat: lexical 1.067 to 1.043 ms, hybrid 13.150 to 13.190 ms, and related lookup 2.947 to 2.920 ms. Both runs made six provider calls for 90 measured hybrid queries.

Storage and request counts were unchanged: the 3,000-note database was 39,174,144 bytes, with 24 shared artifacts totaling 13,844,480 bytes, 3,000 notes/vectors, and 2,999 cached document vectors in both runs. Cold indexing made 30 calls for 3,000 texts in both runs; no-op, delete, and bootstrap made none, and edit made one. The main bundle stayed 1,998,502 bytes; the worker changed from 25,791 to 25,768 bytes. The standard full cleanup remains necessary because incremental indexing cannot discover source IDs that disappeared entirely.

The earlier RecordManager profile saw roughly 6,000 per-key UPSERTs across 60 RPCs for a 3,000-note no-op update, with `RecordManager.update` accounting for about 70% of elapsed time. Its nested timings overlap and must not be added; approximately 200 ms of the prior update was commit time, and the SQL batching keeps the same transactions. Larger note windows of 200 or 500 were considered but not adopted because they retain two or five times as many note inputs. This explains why the bounded 100-key SQL batch improved some operations without eliminating full-update cost.

Earlier legacy-to-cache results that showed 5.76 seconds for a 3,000-note cold index used a Node in-memory SQLite test workflow and an intermediate cache candidate, not the production OPFS workflow. The original adapter called `IndexManager.build`/`synchronize` directly and omitted production maintenance scheduling/publication and record-path mutation events. The later original-to-final comparison used the full production controller on real OPFS and correct mutation events, with different indexing and cache behavior. Those runs have different harnesses and operations and cannot attribute their absolute timing difference to one code change; they are not evidence that this SQL change caused the full difference.

This comparison is a synthetic OPFS workload, not live-provider or real-sync timing. It does not establish retrieval-quality equivalence or predict end-to-end Obsidian performance.

## Latest HEAD paired benchmark — 2026-10-17

This paired run compares the committed production baseline `b32f6be97af9a4502b2f00e72d38cd770c0e86ab` with current HEAD `5a0cf5378588761eb8067413a121d4d5d414b770`. The paired raw report is [paired.json](../.ai/bench/history-20261017-5a0cf53/paired.json); the current-only summary and raw browser report are [latest/report.json](../.ai/bench/history-20261017-5a0cf53/latest/report.json) and [latest/current-raw.json.browser.json](../.ai/bench/history-20261017-5a0cf53/latest/current-raw.json.browser.json). Run metadata, archive hashes, and exact plan are in [run-metadata.json](../.ai/bench/history-20261017-5a0cf53/run-metadata.json). The baseline and current archive SHA-256 values are `4dfa29190c831a96e2b58bdb0e79f6dded1e1b546bd8f83eb0b6573798f46b83` and `5f7536cec8e1b5c84f75575539d88ddb128d35bcbc7c70ea0588b63abfeaab17`.

The matched workload uses the same 3,000-note corpus (400 characters per note), 768-dimensional deterministic provider fixture, benchmark driver, SQLite WASM, package lock, Node 24.13, Apple M1 Max, and Brave 154.1.96.61. It also runs a 24-note smoke profile and 300-note profile. The 300-note run has five measured samples and 3,000-note run three, each after one warmup; queries use five warmups and 30 samples per profile run. Production workers use a real SAH OPFS pool and an in-memory vault adapter. Note/sentinel counts and complete-bootstrap checks passed. This measures neither a live provider nor real vault synchronization or the Obsidian UI. Times below are medians in milliseconds unless the publication p95 is shown in parentheses. Publication is included in cold-update time and must not be added to it.

| Operation                           | 300-note baseline | 300-note HEAD |   3,000-note baseline |       3,000-note HEAD |
| ----------------------------------- | ----------------: | ------------: | --------------------: | --------------------: |
| Cold update                         |          1,344.31 |      1,340.10 |             13,853.09 |             13,914.36 |
| Publication phase                   |             89.90 |         91.38 | 913.72 (p95 1,110.99) | 641.31 (p95 1,202.85) |
| No-op update                        |             58.56 |         54.95 |                519.16 |                472.73 |
| One-note edit                       |             79.39 |         81.70 |                548.19 |                491.15 |
| One-note delete                     |             46.63 |         54.80 |                502.77 |                447.95 |
| Fresh-device bootstrap, 3,000 notes |                 — |             — |             13,030.04 |             13,355.74 |

At 3,000 notes, cold update is effectively flat (+0.4%); the median publication phase is 29.8% lower, but its p95 is higher, so the three-sample tail is noisy. No-op, edit, and delete medians are 8.9%, 10.4%, and 10.9% lower, respectively; bootstrap is 2.5% higher. The 300-note results are mixed and do not show a uniform improvement. A separate current-only run measured 11,640.01 ms for 3,000-note cold update versus 13,914.36 ms in the paired run; use the matched pair for revision comparisons and treat this spread as observed run-to-run variation rather than selecting the faster single run.

| 3,000-note query    | Baseline median (p95) | HEAD median (p95) |
| ------------------- | --------------------: | ----------------: |
| Lexical             |         0.925 (4.605) |     1.015 (4.940) |
| Hybrid              |       11.355 (17.475) |   12.000 (16.745) |
| Related-note lookup |         2.415 (3.125) |     0.010 (2.955) |

Both revisions made 30 provider calls for 3,000 texts during cold indexing, and fresh-device bootstrap completed with zero provider calls. With repeated source paths and the new related-hit cache, 51 of 90 HEAD related-note calls completed in under 0.1 ms (baseline: none); this is consistent with cache reuse, not evidence of faster SQL. Database and shared-artifact sizes were unchanged between paired revisions: 39,174,144 bytes locally and 13,844,480 bytes across 24 immutable artifacts.

The main bundle increased from 1,998,502 to 2,019,950 bytes; the worker from 25,791 to 25,884 bytes. Combined main, worker, and SQLite JavaScript/WASM assets increased from 4,435,698 to 4,457,239 raw bytes; SQLite assets were unchanged. The esbuild metafile attributes 1,926,367 bytes of the HEAD main bundle to vendor modules and 91,313 bytes to local code; the worker adds 25,791 local bytes. Thus local main-plus-worker output is 117,104 bytes, compared with 95,604 bytes at the b32 baseline and 342,363 bytes in the original implementation. Vendor modules account for about 95.4% of the HEAD main bundle. These emitted-byte counts are not source lines, and gzip attribution by module is not measured. The measured revision spans accumulated changes since b32; this comparison does not isolate the Console debugging toggle or assign timing differences to any single change.

The historical sections above describe successive milestones, but their harnesses are not one continuous timing series. The 2026-10-11 in-memory baseline-to-rewrite run reported 3,000-note cold indexing at 19.52 s versus 8.62 s; its batching follow-up measured 5.70 s and reduced embedding calls from 3,000 to 30. The 2026-10-12 rowid experiment reduced exported database size from 41,312,256 to 25,583,616 bytes. On 2026-10-13, the query-cache comparison reduced measured hybrid-query provider calls from 90 to 6 while increasing local DB size; the 44.289 ms SQLite publication result was an in-memory format prototype, not the production OPFS path. Production OPFS measurements on 2026-10-14 first exposed high SQLite receipt-write cost, then a separate receipt-batching pair reduced its 3,000-note publication median from 18,169.12 to 802.04 ms. The 2026-10-15 RecordManager pair then reduced 3,000-note no-op/delete medians from 565.36/560.23 to 445.76/440.95 ms, while 300-note no-op was 5.7% slower. The specific reports and their differing conditions are documented in the dated sections above. In particular, the attractive 20.344 s to 5.757 s legacy-to-cache result used a Node in-memory direct-index harness without production publication and is not comparable to the OPFS workflow. Do not splice these results into one trend or treat cross-harness differences as effects of a single code change.

## RecordManager clock-statement experiment — 2026-10-17

A scratch-only candidate replaced the database-clock SELECT plus guarded UPDATE with one guarded UPDATE ... RETURNING. It kept the existing transaction boundaries, 100-key batches, LangChain indexing, watermark handling, and rollback behavior; no production SQL change was adopted. The repaired browser runner completed smoke runs and this unprofiled matched OPFS pair. The pair used the same plan, 3,000-note corpus, driver, package lock, and SQLite inputs; it measured five 300-note samples and three 3,000-note samples after one warmup. Values are medians in milliseconds with min–max ranges.

| Operation       |    300-note control |   300-note candidate |            3,000-note control |       3,000-note candidate |
| --------------- | ------------------: | -------------------: | ----------------------------: | -------------------------: |
| No-op update    | 57.96 (48.74–63.88) | 60.98 (39.73–995.50) | 4,627.91 (3,099.41–23,001.11) | 1,097.99 (564.51–9,807.26) |
| One-note delete | 55.38 (51.85–66.58) | 43.76 (41.04–248.87) | 6,562.10 (3,614.31–23,234.44) |   674.83 (668.37–2,009.82) |

The ranges are too wide to establish a stable benefit or attribute the median differences to the statement change. Cold-index timing also varied substantially (15.64–146.04 s for the control and 16.51–149.63 s for the candidate). The pair preserved the expected result: after deletion, both sides had 2,999 indexed notes and vectors; cold indexing made 30 provider calls for 3,000 texts, while no-op and delete made none. The 3,000-note database and 24 shared artifacts remained 39,174,144 and 13,844,480 bytes, respectively. The candidate remains a benchmark-only experiment; no SQL optimization was adopted because this run did not prove a reliable improvement.

Raw results and validation summary: [clock-pair.json](../.ai/bench/index-maintenance-20261017-5a0cf53/browser-fix-rerun/clock-pair.json) and [clock-pair-summary.json](../.ai/bench/index-maintenance-20261017-5a0cf53/browser-fix-rerun/clock-pair-summary.json). The full pair passed 183 validation checks.

## Focused maintenance rerun — 2026-10-17

A focused, unprofiled OPFS pair compared 12 balanced AB/BA rounds of no-op update and deletion on the same 3,000-note plan and corpus. Each side prepared its index once and ran two warmup no-ops before timing. Each measured round ran one no-op, then deleted notes/2999.md and restored/reindexed it outside the timer. Both workers stayed open; retrieval queries and bootstrap were omitted. The existing LangChain index, 100-key batches, cache handling, and publication path were unchanged. The lower-middle observation is used for even-sized medians; paired improvements are medians of the 12 per-round percentage changes, not a significance test.

- **No-op:** control median 3,018 ms (p90 5,354); candidate median 3,047 ms (p90 4,184). The candidate won 5/12 pairs; paired median improvement was −5.45%.
- **Delete:** control median 3,634 ms (p90 7,367); candidate median 2,857 ms (p90 6,528). The candidate won 8/12 pairs; paired median improvement was +10.90%.

The predeclared retention gate required at least 10/12 wins and at least 5% paired-median improvement for both operations, with no worse p90 or extreme tails. It failed: no-op did not improve, despite its lower candidate p90; delete improved by the median but won only 8/12 pairs. No sample exceeded three times its side median, and no additional tail diagnostic was triggered. The candidate SQL change is therefore not adopted in production.

All timed no-op and delete operations made zero provider calls, cache-publication writes, or vault-adapter writes. The no-op skipped all 3,000 notes; deletion removed exactly one note, and every round restored the index to 3,000 notes and vectors. The OPFS database remained about 39.2 MB, with an eight-KiB allocation increase observed between rounds 4 and 5, outside timed samples. Browser timer lag before and after each operation was at most 3.685 ms; this bounds observed event-loop lag around the timer but does not prove the host was otherwise idle. Host load was high during the run, but the captured data cannot attribute the latency variation to CPU, disk, or another cause.

A separate two-round baseline profile found 60 RecordManager update RPCs per operation accounting for 49–60% of elapsed time; nested native-exec timings overlap those RPC spans. Transaction commits accounted for 22–31% (433–1,143 ms). Between the profile two no-op samples, elapsed time rose from 1,976 to 5,106 ms: 1,317 ms more in update RPCs and 1,813 ms elsewhere, which the profile did not localize. This is evidence of variable cost, not a proven root cause. A later phase-instrumented attempt timed out during DevTools setup before workload measurement, so it produced no additional timing data.

The primary artifact recorded a b32f6be baseline archive argument, but the provenance correction confirms the measured baseline workspace matches the 5a0cf53 source tree; the candidate is that same tree plus the isolated clock SQL patch and focused-test correction. This is a 5a-to-5a-plus-scratch comparison, not a b32 comparison. Raw results, summary, run metadata, and provenance correction are local ignored benchmark artifacts and may be absent from a clean checkout: [raw.json](../.ai/bench/index-maintenance-20261017-5a0cf53/maintenance-focus/raw.json), [summary.json](../.ai/bench/index-maintenance-20261017-5a0cf53/maintenance-focus/summary.json), [run-metadata.json](../.ai/bench/index-maintenance-20261017-5a0cf53/maintenance-focus/run-metadata.json), and [provenance-correction.json](../.ai/bench/index-maintenance-20261017-5a0cf53/maintenance-focus/primary-driver/provenance-correction.json).

## Benchmark reliability A/A control — 2026-10-18

An unprofiled A/A control ran four balanced ABBA rounds on the same verified 5a0cf53 source, identical worker and workload bundles, 3,000-note input, and persistent prepared indexes, with two warmups per side. Conventional even-sample medians are used for this and later focused summaries; older saved summaries retain their original lower-middle convention. The no-op medians were 442.06 ms (baseline, 413.71–512.12) and 440.82 ms (current, 417.94–521.29); delete medians were 448.93 ms (baseline, 426.49–451.76) and 437.80 ms (current, 413.17–462.91). These are same-code timing differences, not a speedup. The two second-round no-ops were both slower (512 and 521 ms); the other no-op samples were 414–446 ms. Four rounds indicate modest repeatability for this run and workload, not a general stability bound.

The timed interval is `performance.now()` around `await ManualIndex.update()`. It includes cache import and vault preparation, LangChain hashing/index work, RecordManager refresh writes, cleanup, publication, and waits. A no-op made no provider calls or publication writes but was not read-only: it still performed 60 RecordManager transactions covering 6,000 keys. Deletes removed one note and each restore returned both indexes to 3,000 rows and vectors; each side's initial population used 30 provider calls for 3,000 texts, with no new embeddings during measured no-op/delete work. Runtime PRAGMAs were identical on both sides: journal mode `DELETE`, synchronous `FULL` (`2`), cache size `16 MiB` (`-16384`), and page size `8 KiB`. Warmups, snapshots, OPFS enumeration, timer-lag probes, and status posts were outside the clock and can affect subsequent samples. RPC, native-exec, and commit durations overlap; native-exec is worker wall time, not isolated CPU or physical I/O time.

The older focused run's no-op range was 1.766–5.596 s and its delete range was 1.710–8.970 s. These observations occurred alongside high host load, but the measurements do not establish that load as their cause. A slow no-op pair also appeared before the later rounds, so round age alone does not explain the variation. The full historical harness repeats cold indexing, queries, and bootstrap, whereas this control uses persistent workers and indexes; their timings are not directly comparable. The root cause of the older swings remains unresolved. The successful control and corrected raw-first report capture establish the measurement result, not a performance effect; synthetic success, failure-preservation, and output-collision checks passed for report generation.

If the slow behavior recurs, first repeat a source-verified A/A with identical inputs, then use an unprofiled matched ABBA comparison with raw ranges, paired statistics, and state guards. Capture phase or resource evidence during the measured operations before drawing a causal conclusion. The current four-round control does not justify a production change or generic profiling without recurrence.

Raw report, summary, and run metadata: [raw.json](../.ai/bench/benchmark-reliability-20261018/aa-unprofiled-verified/raw.json), [summary.json](../.ai/bench/benchmark-reliability-20261018/aa-unprofiled-verified/summary.json), and [metadata.json](../.ai/bench/benchmark-reliability-20261018/aa-unprofiled-verified/metadata.json). These local ignored artifacts may be absent from a clean checkout.

## Controlled `UPDATE RETURNING` comparison — 2026-10-19

A profile-off comparison used 3,000 notes, two warmups per side, and 12 balanced rounds across three sessions: the same 5a source as baseline and identical-code control, plus the scratch `UPDATE RETURNING` candidate. Conventional medians were 470.65/462.34/456.37 ms for no-op and 466.52/461.08/469.89 ms for delete (baseline/control/candidate). Median paired savings against the mean of the two controls were 1.31 ms (0.29%) for no-op and 11.80 ms (2.45%) for delete; the candidate was faster than both controls in only 4/12 rounds for each operation. Median absolute A/A gaps were 31.22 ms (6.82%) and 38.89 ms (8.24%). The predeclared gate required at least 10/12 wins and paired median gains exceeding both the 5%/A-A-gap and 25-ms/A-A-gap thresholds; the candidate failed all three conditions for both operations. One identical-code delete control sample reached 1,506.74 ms; its cause is unknown.

Decision: retain the existing 5a clock SQL and do not adopt `UPDATE RETURNING`. This comparison demonstrates no gain that meets the predeclared gate and does not establish behavioral equivalence.

The result is **offline-validated from preserved browser output**, not a clean successful runner result. The original post-capture identity guard failed because it compared emitted workload bytes that differed in esbuild comments containing workspace paths. Offline checks found the 725-input closures equal and rebuilt workload bytes equal after only that exact comment normalization; executable-byte differences were rejected. The original emitted bundle hashes were not retained, so this does not prove the exact bundle bytes used by the browser run. The failed sidecars remain unchanged, and no rerun was made. Validation covered 180 snapshots, matching SQLite PRAGMAs, restored index/vector counts, zero provider/publication writes, one OPFS pool, and bounded OPFS allocation; four focused clock tests and synthetic guard checks passed.

Artifacts: [offline-validated report](../.ai/bench/update-returning-controlled-comparison-20261019/offline-validated-from-preserved-browser-result.json), [bundle-identity diagnosis](../.ai/bench/update-returning-controlled-comparison-20261019/bundle-identity-diagnosis.json), and [preserved browser result](../.ai/bench/update-returning-controlled-comparison-20261019/raw-browser-unvalidated.json). These local ignored files may be absent from a clean checkout.
