# Obsidian benchmark

This guide describes the current-app benchmark. It measures repeated operations in the normal Obsidian plugin on a fixed generated vault, using existing Console Debug timings. It publishes no current performance result; no live-app measurements are included here.

## Prepare the vault

Build the plugin, then prepare the benchmark vault:

```sh
npm run build
npm run benchmark:prepare
```

The preparer creates or reuses `.artifacts/test-vaults/benchmark/Trama Benchmark Vault`, marked by `.trama-benchmark-vault`. It contains a pinned 3,000-note corpus with SHA-256 `66d061b6c61c157587bf1dace04c6e72e7b0c5d3f8dd44393699d3b50f7b1c8a`. It installs the built plugin and enables Trama in that vault. It does not open or register the vault. Open that exact generated vault yourself in Obsidian; do not use a personal vault. The preparer restores a missing generated note on rerun and never overwrites existing note content.

In Trama settings, enable **Console Debug**. Use the same embedding endpoint, model, dimensions, and excluded folders for both reports. Record the actual settings and the app build, runtime, platform, and machine in each report. The endpoint and model must be nonempty, dimensions a positive integer, and excluded folders empty for this fixed corpus comparison.

## Collect samples

Allow startup or automatic indexing to finish before timing. Perform one full warm cycle without recording it, then perform exactly three recorded cycles. Each cycle follows this sequence:

1. Run **Rebuild index** and wait for completion.
2. In Lente, explicitly run a hybrid search for `D5 lexical sentinel unique phrase`. Record that completed manual search timing and confirm it returns at least one result. Search timing records do not contain the query text, so retain the original console evidence that identifies this explicit query.
3. Run **Update index** without changing notes; record the unchanged update.
4. Delete the generated `notes/2999.md` note and run **Update index**; record the single-note deletion update.
5. Run `npm run benchmark:prepare` again to restore the missing generated note, then run **Update index**; record the restoration update.

Wait for each operation to finish before starting the next. Reject a cycle if an operation fails or is cancelled, sharing is incomplete, search is degraded, automatic indexing overlaps, or expected counts do not match. Rebuild and Update retain compatible document and shared cache entries, so record `cacheCondition: "warm-after-rebuild"`; this is not a cold-cache measurement.

Use completed Console Debug operation records. Index records have label `Rebuilding note index completed` or `Updating note index completed`, with `automatic: false`, the expected `rebuild` value, `visited`, `deleted`, `numAdded`, `numUpdated`, `numSkipped`, and integer `elapsedMs`. Expected counts are:

| Operation        | visited | deleted | added | updated | skipped |
| ---------------- | ------: | ------: | ----: | ------: | ------: |
| Rebuild          |   3,000 |       0 | 3,000 |       0 |       0 |
| Unchanged update |   3,000 |       0 |     0 |       0 |   3,000 |
| Delete update    |   2,999 |       1 |     0 |       0 |   2,999 |
| Restore update   |   3,000 |       0 |     1 |       0 |   2,999 |

The search record has label `Vault search completed`, `mode: "hybrid"`, `resultCount > 0`, `degraded: false`, and integer `elapsedMs`. Use the integer millisecond values as reported; do not claim sub-millisecond precision. Timers may overlap, so never add phase timings together.

## Save and compare reports

Save the observed values and environment to JSON yourself. Console Debug output is timing evidence; the developer console does not export benchmark JSONL or a complete report. One sample row is shown below; each report must contain all three recorded cycles, in order.

```json
{
  "schema": "trama-app-benchmark-v1",
  "corpusSha256": "66d061b6c61c157587bf1dace04c6e72e7b0c5d3f8dd44393699d3b50f7b1c8a",
  "corpusCount": 3000,
  "context": {
    "appBuild": "<observed build>",
    "runtime": "<observed runtime>",
    "platform": "<observed platform>",
    "machine": "<observed machine>"
  },
  "settings": {
    "embeddingEndpoint": "<observed nonempty endpoint>",
    "embeddingModel": "<observed nonempty model>",
    "dimensions": 1536,
    "excludedFolders": [],
    "consoleDebug": true,
    "cacheCondition": "warm-after-rebuild",
    "query": "D5 lexical sentinel unique phrase"
  },
  "samples": [
    {
      "rebuild": {
        "label": "Rebuilding note index completed",
        "automatic": false,
        "rebuild": true,
        "visited": 3000,
        "deleted": 0,
        "numAdded": 3000,
        "numUpdated": 0,
        "numSkipped": 0,
        "elapsedMs": 12345
      },
      "search": {
        "label": "Vault search completed",
        "mode": "hybrid",
        "resultCount": 1,
        "degraded": false,
        "elapsedMs": 8
      },
      "unchanged": {
        "label": "Updating note index completed",
        "automatic": false,
        "rebuild": false,
        "visited": 3000,
        "deleted": 0,
        "numAdded": 0,
        "numUpdated": 0,
        "numSkipped": 3000,
        "elapsedMs": 234
      },
      "delete": {
        "label": "Updating note index completed",
        "automatic": false,
        "rebuild": false,
        "visited": 2999,
        "deleted": 1,
        "numAdded": 0,
        "numUpdated": 0,
        "numSkipped": 2999,
        "elapsedMs": 231
      },
      "restore": {
        "label": "Updating note index completed",
        "automatic": false,
        "rebuild": false,
        "visited": 3000,
        "deleted": 0,
        "numAdded": 1,
        "numUpdated": 0,
        "numSkipped": 2999,
        "elapsedMs": 240
      }
    },
    {
      "rebuild": {
        "label": "Rebuilding note index completed",
        "automatic": false,
        "rebuild": true,
        "visited": 3000,
        "deleted": 0,
        "numAdded": 3000,
        "numUpdated": 0,
        "numSkipped": 0,
        "elapsedMs": 12400
      },
      "search": {
        "label": "Vault search completed",
        "mode": "hybrid",
        "resultCount": 1,
        "degraded": false,
        "elapsedMs": 9
      },
      "unchanged": {
        "label": "Updating note index completed",
        "automatic": false,
        "rebuild": false,
        "visited": 3000,
        "deleted": 0,
        "numAdded": 0,
        "numUpdated": 0,
        "numSkipped": 3000,
        "elapsedMs": 230
      },
      "delete": {
        "label": "Updating note index completed",
        "automatic": false,
        "rebuild": false,
        "visited": 2999,
        "deleted": 1,
        "numAdded": 0,
        "numUpdated": 0,
        "numSkipped": 2999,
        "elapsedMs": 229
      },
      "restore": {
        "label": "Updating note index completed",
        "automatic": false,
        "rebuild": false,
        "visited": 3000,
        "deleted": 0,
        "numAdded": 1,
        "numUpdated": 0,
        "numSkipped": 2999,
        "elapsedMs": 242
      }
    },
    {
      "rebuild": {
        "label": "Rebuilding note index completed",
        "automatic": false,
        "rebuild": true,
        "visited": 3000,
        "deleted": 0,
        "numAdded": 3000,
        "numUpdated": 0,
        "numSkipped": 0,
        "elapsedMs": 12290
      },
      "search": {
        "label": "Vault search completed",
        "mode": "hybrid",
        "resultCount": 1,
        "degraded": false,
        "elapsedMs": 8
      },
      "unchanged": {
        "label": "Updating note index completed",
        "automatic": false,
        "rebuild": false,
        "visited": 3000,
        "deleted": 0,
        "numAdded": 0,
        "numUpdated": 0,
        "numSkipped": 3000,
        "elapsedMs": 236
      },
      "delete": {
        "label": "Updating note index completed",
        "automatic": false,
        "rebuild": false,
        "visited": 2999,
        "deleted": 1,
        "numAdded": 0,
        "numUpdated": 0,
        "numSkipped": 2999,
        "elapsedMs": 235
      },
      "restore": {
        "label": "Updating note index completed",
        "automatic": false,
        "rebuild": false,
        "visited": 3000,
        "deleted": 0,
        "numAdded": 1,
        "numUpdated": 0,
        "numSkipped": 2999,
        "elapsedMs": 238
      }
    }
  ]
}
```

All sample values are illustrative only; replace them with observed values. Each phase object lists exactly the fields emitted by the current completed debug record and required by the comparator. Preserve each report as `before.json` or `after.json` with its raw console evidence alongside it.

Compare a baseline and changed build with:

```sh
npm run benchmark:compare -- before.json after.json
```

The comparator prints each side's raw three samples, medians, and after-minus-before milliseconds. It writes no files. Both reports must use the same corpus and settings, and match in runtime, platform, and machine; `appBuild` may differ. Treat the output as a comparison for that machine and run only. The cache and storage ADRs preserve selected dated measurements with their workloads and limitations; those historical results are not comparable with this current-app series and must not be joined to it.

## Safety and interpretation

Run mutation steps only in the marked generated benchmark vault. The committed `test-vaults/benchmark/` files are inputs, not targets. Do not rely on the active-vault selector or run the procedure in a personal vault. Keep SQLite filtering, grouping, ranking, and vector scoring in SQLite; this benchmark observes existing application operations and adds no production logger.

## Revision-cache regression workload

`npx vitest run tests/performance-regressions.test.ts --silent=false` measures
three unchanged indexing runs on the same pinned 3,000-note, 400-character corpus,
with deterministic two-dimensional vectors and the production SQLite/WASM runtime
inside Node.js. This isolates local indexing work; it is not an Obsidian UI or
provider-latency benchmark. The test asserts zero unchanged body reads and no
provider calls, and verifies that content reconciliation still catches edits with
unchanged file metadata. `tests/source-revisions.test.ts` also checks the SQL join
shape, revision persistence, exclusions, renames, and deletion.

A local comparison against `0c3982d` used Node.js 24.13.0, Vitest 5.0.5, the same
SQLite assets, and the same corpus and vectors for both implementations:

| Implementation | Unchanged samples (ms) | Median (ms) | Body reads per run |
| -------------- | ---------------------- | ----------- | ------------------ |
| Before         | 147.34, 119.32, 119.82 | 119.82      | 3,000              |
| Revision cache | 18.22, 18.58, 17.78    | 18.22       | 0                  |

These are local harness observations, not universal timing guarantees. Startup
and file-event runs use persisted file revisions; manual Update and the five-minute content backstop
still reread the vault. Changed notes retain native LangChain hashing and cleanup.
The revision query drives indexed path lookups from the bounded input batch using
`CROSS JOIN`, avoiding a query plan that rescans the corpus for every input path.

## Native scoring comparison — 2026-10-27

A paired Node.js 24.13.0 run on the same arm64 Mac compared the preceding demo
build's SQLite-Vector Float32 scorer with the independent double precision scorer.
Both used the same SQLite version, 3,000 stored vectors of 768 dimensions, five
warmups, and 30 measured full scans. Each scan executed
`SELECT sum(trama_vector_dot(vector,?)) FROM vectors`, returning only the aggregate.
The query and all stored vectors used the same Float32 components
`(i % 17 - 8) / 100`, normalized once using double precision and rounded to Float32.
The vector bytes have SHA-256
`de67eb751bf8a895587d098129459cadaa87767381fd67dfce3d481c938733da`.

| Native arithmetic      | Median scan (ms) | Sum of 3,000 self-similarities |
| ---------------------- | ---------------- | ------------------------------ |
| SQLite-Vector Float32  | 1.204            | 3000.001072884                 |
| Trama double precision | 2.768            | 3000.000039847                 |

This is a microbenchmark, not end-to-end Obsidian latency. Double precision costs
about 1.56 ms more per scan here. The deliberate tradeoff is consistent validation
and finite scoring across the Float32 range, a small native implementation, and
removal of the external vector library. Float32 normalization still introduces
rounding, so self-similarity is approximately one.

The compared WASM SHA-256 values were
`a391b6b16e24c1421130cac383664f51bd5cab4c569de00c2c04cbe700c81493` (before) and
`23af819bb43b7ff981912ab2d1b58bec385c594113cfa8f1b0172eff996eedb5` (after).
Regression coverage in `tests/vector-scoring.test.ts` verifies extreme magnitudes,
invalid inputs, scale-invariant cosine ranking, and the native/JavaScript contract.
The isolated `scripts/benchmark/sqlite-opfs-shard.mjs` browser harness additionally
verifies legacy shards, tiny/large vector round trips, receipt reconciliation,
malformed shard rejection, persistence, and scratch-file cleanup with the production
worker. Those checks do not substitute for native Obsidian UI validation.

On 2026-10-28, the same production WASM kernel was used to compare shard vector
validation with three self-dot evaluations per row against one. The paired query
microbenchmark used 128 vectors of 768 Float32 dimensions, five warmups, and 50
measured samples per variant, alternating execution order on Node.js 24.13.0 arm64.
Components were `(i % 17 - 8) / 100`, without normalization; vector SHA-256 was
`d9d03cb72f05bbea967dc8ea0e5ab2e0264ab602e8b16b6eefa8906311a88c1b`.
Both queries rejected zero rows; median time decreased from 0.527 ms to 0.286 ms.
This measures the validation query only, not full import or UI latency. Scoring
arithmetic is unchanged. The scoring suite checks the production validation query
has one native dot opcode and that cancellation still stops import before commit.
