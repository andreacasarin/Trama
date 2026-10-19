# Lifecycle benchmark run and comparison guide

> **Historical workflow:** The collection and comparison guidance below belongs to
> the former lifecycle benchmark. It is not a current V1 workflow or performance
> baseline. See the [current V1 implementation and evidence](langchain-sqlite-implementation.md).

This guide describes how to collect and compare lifecycle benchmark observations.
It does not publish a machine-specific performance baseline. The workflow is
historical and is not active for V1. See the [current implementation and evidence](langchain-sqlite-implementation.md).

## Run ordinary observations

The ordinary runner uses deterministic synthetic Markdown and does not access a real
vault. Run one profile per invocation with a single repetition and a documented
timeout:

```sh
TRAMA_BENCHMARK_PROFILE=trama-10k TRAMA_BENCHMARK_REPETITIONS=1 TRAMA_BENCHMARK_TIMEOUT_MS=900000 npm run benchmark
TRAMA_BENCHMARK_PROFILE=trama-large TRAMA_BENCHMARK_REPETITIONS=1 TRAMA_BENCHMARK_TIMEOUT_MS=900000 npm run benchmark
```

Run independent invocations to observe variability; a single run is not a stable
comparison. The runner overwrites the current profile report at
`.artifacts/benchmarks/<profile>.json` on each run. If keeping a local sample
set, copy each report before the next run to the next unused
`.artifacts/benchmarks/archive/lifecycle-v1/<profile>/run-N.json`. Check that
the destination does not already exist. Preserve error and timeout reports with
their status; partial reports and completed reports may not have comparable timing
or RSS boundaries.

Oracle capture is a separate maintenance operation, not a timing run. The
`TRAMA_BENCHMARK_CAPTURE=1` mode emits provisional `reference-capture` evidence for
manual review and may allow a manifest mismatch; it never updates the versioned oracle
automatically. Do not use capture mode for ordinary observations or compare its timings
with ordinary runs. Review and validate any oracle change separately.

## Validate before comparing

For every report, parse the JSON and verify the report and workload contract versions,
profile and source digest, build identity, runtime/OS/architecture, timeout and
repetition settings, provider identity, query-vector identity, and source provenance.
For ordinary observations, require the expected and observed source-manifest digests
to equal the pinned value, manifest status `match`, and the manifest correctness gate
to pass. Require a completed status and every correctness gate—including occurrence
content, mutation arithmetic, output-oracle, provider/query identity, and
published/adopted semantic equivalence—to be true before interpreting timings.
Confirm duration units and publication/adoption outcomes. Keep diagnostic evidence
optional; its absence must not change interpretation of the stable report core.

Compare only reports with matching report/workload contract, source digest, build,
provider/query identities, runtime environment, and measurement boundaries. Report
repeated observations and their variability rather than treating one measurement as
representative. Do not invent performance targets or infer causality from aggregate
scenario timings.

## Interpretation limits

RSS is sampled process resident memory in the report's declared window, not memory
allocated by an individual scenario; sampling can miss short peaks. Optional
`semanticAttribution` separates semantic phase wall spans, SQLite `exec` elapsed time
and calls, callback rows, provider and vector-conversion work, and the in-process
handler/RPC boundary. `exec` time includes binding and callbacks, not just engine CPU.
Nested transaction phases overlap; sum only disjoint spans. The isolated uncached,
cached productive, partial, and no-work probes use a separate small fixture after
the measured lifecycle and must not be mixed into the stable scenario timings or
provider totals. RPC minus handler time is unattributed Node client/queue overhead,
not a measurement of browser Worker transport.

The fixture uses a deterministic, instantaneous inference provider. Browser
Worker/OPFS behavior, real Obsidian vault/UI latency, and real inference-provider
latency are outside this Node harness's support. Treat the results as workload- and
environment-specific observations, not product performance guarantees.

## Local semantic-attribution evidence (2026-09-30)

Twelve independent, one-repetition invocations used the commands above with
`TRAMA_BENCHMARK_DIAGNOSTICS=1` or `0`, in three interleaved
`10k on → 10k off → large on → large off` rounds. Raw completed reports and
invocation logs are ignored local files at
`.artifacts/benchmarks/archive/semantic-attribution-2026-09-30/<profile>-<on|off>-run-<1|2|3>.{json,log}`.
Both profiles used 768 dimensions, Node v24.13.0 on darwin/arm64, a 900,000 ms
timeout, and the pinned source manifest
`212ffaf6670fc6b1c5477f1c04d2a51d131f9dabf29d03680907880ab3969374`.
Each report completed with all 22 correctness gates true. Within each profile,
enabled and disabled reports had identical environment, build, provider and query
identities, source digest, scenario names and non-timing scenario results, stored
counts, semantic head counts, occurrence digests, output oracle, and core observables.
The 10k source digest was
`822ac8dce2629647387b9f90eea2aca6980e90cc1355e5d5ef049af01436bff9`;
the large digest was `d34ca817aac3605e20960644c6dd1964f97ae9df3ef05aaca13a8fd5b1ded108`.
Enabled runs had identical ordered provider-batch digests across their three
samples. Disabled ordinary reports intentionally omit those digests, so their exact
batch sequences cannot be proven from these full-profile reports; the focused
on/off neutrality test checks exact ordered input batches on the small fixture.
Per-call promoted counts are likewise optional diagnostics, so the disabled reports
prove the resulting semantic head state rather than each promotion count.

The following values are medians of three independent enabled reports, in ms.
Ranges in the on/off columns are the observed paired differences (on minus off),
not confidence intervals.

| Profile               | Uncached prepare handler |  Prepare `exec` | First lookup + bounded selection |     Uncached on/off delta | Indexing-to-publication on/off delta |
| --------------------- | -----------------------: | --------------: | -------------------------------: | ------------------------: | -----------------------------------: |
| 10k (10,000 chunks)   |                  1,436.9 | 1,426.8 (99.3%) |                  1,416.1 (98.6%) |  +117.1 (+83.4 to +134.1) |             +103.8 (+40.4 to +191.1) |
| large (25,000 chunks) |                  9,535.8 | 9,510.1 (99.7%) |                  9,479.6 (99.4%) | +112.8 (−196.9 to +324.8) |             −60.9 (−352.0 to +508.5) |

The 10k uncached preparation had 79 calls per run; large had 196. First-input
lookup and bounded selection were respectively 680.7 and 734.0 ms at 10k, and
4,688.4 and 4,791.2 ms at 25k. The first productive calls took 4.0/7.6 ms;
middle productive calls had median per-call RPC spans of 17.8/49.6 ms; final
productive calls took 34.8/102.5 ms. Stable cached empty calls took 49.2/152.2
ms, and partial productive calls took 37.1/110.7 ms. The separate small fixture
confirmed first, middle, final, and terminal empty partial calls; cached productive
promotion without provider requests; and converged no-work. Its median no-work
prepare RPC span was 0.38 ms for both profiles' probes. These small-probe numbers
must not be scaled to the full lifecycle.

The median uncached prepare RPC-minus-handler totals were only 0.5 ms (10k) and
1.6 ms (large); they describe the in-process Node client boundary. SQL `exec`
includes binding, callbacks, and materialization, so the 99% shares do not isolate
engine CPU. Uncached commit RPC medians were 729.9/2,372.8 ms; its SQL `exec`
medians were 568.2/1,960.4 ms. Vector conversion took 11.2/28.7 ms for
30.7/76.8 MB of payload; known vector blob copying took 13.1/34.6 ms. The
deterministic provider took 149.3/365.6 ms in total. The large on/off timing
ranges cross zero, so the observer's total overhead is not separable from run
variability there; the 10k uncached paired differences were consistently positive.

| Rank | Candidate                                                                | Status and contribution                                                                                                    | Mechanism / confidence                                                                                               | Constraints and correctness exposure                                                                                                                     | Smallest validating experiment                                                                                                            |
| ---- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Combine first-input size validation with bounded missing-input selection | Measured: the two ordered probes account for 1,416.1/9,479.6 ms in uncached prepare (10k/large).                           | Repeated ordered missing-input search across 79/196 calls; high confidence in location, medium in achievable saving. | Preserve first oversized-input error, input order, byte/item bounds, continuation, generation and promotion; query-plan change could alter all of these. | Prototype one combined selection on the same fixtures; compare ordered requests, oversize/zero-limit cases, gates, and three paired runs. |
| 2    | Reduce per-result commit SQL work                                        | Measured: uncached commit `exec` 568.2/1,960.4 ms; setup/inserts and affected-note/cache upsert are sizable nested phases. | Many result inserts plus relational upsert; medium confidence.                                                       | Stale action-key validation, deduplication, atomic promotion, and resumability are exposed.                                                              | Isolate one bounded commit path and compare SQL calls, results, gates, and commit spans.                                                  |
| 3    | Avoid repeated no-work missing checks                                    | Measured: full cached empty prepare 49.2/152.2 ms, mostly first lookup, bounded selection, and remaining-work check.       | Three scans when no input remains; medium confidence, limited full-run contribution.                                 | Must still detect newly eligible or uncached inputs and report `hasMore` correctly.                                                                      | Compare an equivalent no-work query on cached and post-mutation cases.                                                                    |
| 4    | Retrieval materialization                                                | Static opportunity; no path timing here.                                                                                   | Potential row/vector materialization; low confidence.                                                                | Result identity, scores, ranking, and active-head semantics.                                                                                             | Add bounded retrieval phase measurements before changing code.                                                                            |
| 5    | Publication copying                                                      | Static opportunity; no copy attribution here.                                                                              | Potential snapshot/copy cost; low confidence.                                                                        | Atomic publication and adopted equivalence.                                                                                                              | Time snapshot generation, copy, and validation separately.                                                                                |
| 6    | Lexical per-row calls                                                    | Static opportunity; no lexical SQL-call attribution here.                                                                  | Potential JS/SQLite call overhead; low confidence.                                                                   | Bounded staging, receipts, FTS, and generation fencing.                                                                                                  | Count and time calls in one lexical batch without changing behavior.                                                                      |

Select only rank 1 for the next optimization experiment. These measurements justify
testing a combined ordered selection, not implementing it yet or changing batch
defaults. No source-manifest-covered file changed during this evidence phase, so the
pinned manifest was not repinned.
