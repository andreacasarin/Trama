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
