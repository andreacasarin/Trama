# Lifecycle benchmark contract

This document defines the interpretation and evolution rules for the deterministic
index lifecycle benchmark. The report schema is `trama-benchmark-report-v2`; the
input workload is `trama-workload-contract-v1`. The versioned expected-output oracle
is the authority for correctness, not timing.

## Stable evidence

Every ordinary report identifies report and workload contract versions, deterministic
source digest, profile, seed, note and occurrence counts, SQLite build identity,
provider behavior version/dimensions/fingerprint/challenge digest, ordered query-vector
digest, reference base revision/tree status/source-manifest digest, runtime/OS/
architecture, timeout, and repetitions. It records lifecycle boundaries, named
scenario durations, indexing-through-publication duration, process RSS window and
sample count, provider calls/texts, observable initial and final occurrence
digests/counts, semantic counts, retrieval result identities, and correctness gates.
The fixture starts from a fresh empty index and publication store; each invocation
constructs fresh fixture state. Millisecond durations are elapsed wall-clock
measurements.

The occurrence-content digest is SHA-256 over UTF-8 `JSON.stringify` of the ordered
active occurrence tuple array. Each tuple is `[path, ordinal, kind, startLine,
endLine, displayText, headingContext, body, embeddingInput]`. Rows are ordered by
binary path, then occurrence ordinal; only active occurrences from each note's active
lexical revision participate. The separate per-path count digest is SHA-256 over
`JSON.stringify` of ordered `[path, activeOccurrenceCount]` pairs. This pins the
complete active occurrence content and inputs, not only count or identity.

Provider identity includes behavior version
`trama-deterministic-provider-v1`, the fixed 768-dimensional provider, and challenge
digest `da609bed7a65f51e21ed579971f02dab7d70eb60dbeecc34dc72a3e441983747`. The
ordered query vectors have pinned digest
`7b0fa73abfdf474642ea98dac60e72c29c5566e5814f760c8365c5e3b3fe118b`. Changing the
provider challenge behavior or query inputs/vectors requires a new identity/oracle;
do not interpret matching dimensions alone as provider equivalence.

The source-manifest provenance identifies base revision
`17455e78f3654a2033999e786dad527f8a463e3c`, tree status `uncommitted contract
implementation`, and manifest SHA-256
`f23e819ce17c8e00e892ad4d16fad19129ca889a418dd6cc6cb4e42933d3c0d1`. The manifest
covers these relative paths, sorted by UTF-8 byte order: `scripts/benchmark/run.mjs`,
`tests/sqlite-test-client.ts`, `tests/workloads/benchmark-lifecycle.ts`,
`test-vaults/benchmark/config.ts`, `test-vaults/benchmark/contract-v1.ts`,
`tests/workloads/evidence.test.ts`, `test-vaults/benchmark/generator.ts`,
`tests/workloads/instrumentation.ts`, and `tests/workloads/trama-benchmark.ts`. For
each path, SHA-256 receives the 8-byte little-endian path byte length, UTF-8 path
bytes, 8-byte little-endian source byte length, and source bytes, in that order. To
avoid a self-referential hash, normalize only the literal in the declaration
`export const REFERENCE_SOURCE_MANIFEST_SHA256 = "…";` in `contract-v1.ts` to 64
zeroes before hashing; hash all other bytes unchanged.

Those hash and path values describe the historical Node evidence. The retained
legacy runner now re-exports its output oracle from `src/benchmark/Oracle.ts` for
the browser-safe Obsidian runner; its current source manifest includes that file
and is pinned to `01f909a7145b1891e94cd945b1116f7997dddefa80b379ee206f6dde9cc62474`.

The suite-level `beforeAll` runner gate recomputes this source manifest before any
workload is created or benchmark test executes. A successful observation is reused by
the suite; reports include `referenceManifest.expectedSha256`, `observedSha256`, and `status`
(`match`, `mismatch`, or `error`), plus the correctness gate
`referenceManifestMatches`. A normal baseline observation is retainable only when
expected and observed hashes equal the pinned value, status is `match`, and the
correctness gate is true. In ordinary non-capture mode, a mismatch or read error
writes an error report, exits nonzero, and stops before workload creation/timing; it
is diagnostic evidence, not a performance baseline. Capture mode may allow a mismatch
for oracle maintenance and is not an ordinary baseline procedure. A partial benchmark
failure after the gate can retain the matching manifest metadata with its partial
lifecycle evidence.

Optional diagnostics add RPC latency distributions, phase counts, instrumented
counters, and `semanticAttribution`. They may be absent when diagnostics are disabled;
their absence must not change core evidence or correctness. `semanticAttribution`
contains scenario-tagged prepare/commit calls from the stable lifecycle and separate
small-fixture progression probes. The probes run after the stable lifecycle, on a
different SQLite client, and do not contribute to stable scenarios, counts, memory
window, provider totals, or oracle. Productive first/middle/final and empty positions
are classified within each tagged scenario, not across the global RPC sample list.

Each call records RPC and in-process handler elapsed time, their nonnegative difference,
request count and UTF-8 input bytes, submitted vector payload bytes and bytes actually
copied by `vectorBytes` after validation and deduplication,
progress callbacks, continuation and result counts. Phase observations record elapsed
wall time, SQLite `exec` call count, callback row count, elapsed time within `exec`
(including binding, execution, row callbacks, and materialization), and a remaining
JavaScript estimate. Transaction statements are counted. Nested phases overlap their
parent transaction wall time and must not be summed indiscriminately. Handler time
minus top-level phase wall time estimates surrounding work; RPC minus handler time is
unattributed test-client/queue boundary time, not browser transport. Provider duration
and input digests, and number-array to `Float32Array` conversion time/bytes/count,
are diagnostic-only. The Node client invokes the handler in-process; it does not
measure browser Worker messaging or OPFS behavior. These are elapsed wall-clock spans,
not isolated SQLite engine CPU or exact per-operation allocation measurements.

The published/adopted semantic-state comparison covers semantic eligible count, head
count, lag count, missing count, compatible vector count, and readiness. It also
requires matching active occurrence content and per-path counts. Separately, the
versioned output oracle pins retrieval probes for lexical, hybrid, Filo, and Voce
results. The report's `publishedSemanticMatchesAdopted` and `outputOracleMatches`
gates must pass; publication/adoption success flags alone are insufficient.

RSS is process resident memory sampled every 25 ms and at instrumented boundaries.
Completed reports include `memory.rssWindow` with `start: "before-full-build-call"`,
`end: "after-successful-publish"`, and the exact exclusions `fixture-generation`,
`manager-construction`, `adoption`, `retrieval-queries`, and `chat-tool-turn`. The
window starts immediately before the full-build invocation and ends at successful
publication, before adoption and subsequent retrieval/chat work. The fields
`memory.processRssObservedPeak` and `memory.processRssSampleCount` record the maximum
sample and number of samples in this window. The peak is not an allocation total,
per-scenario attribution, or a guarantee that shorter spikes were observed.

Failure and timeout reports preserve whatever partial lifecycle evidence is available.
Their `memory.rssWindow` retains the same `start` and `excludes` values but omits `end`
unless successful publication completed. Do not compare an unended partial window's
peak with completed-run peaks as if their boundaries matched. Browser Worker/OPFS,
real Obsidian, and real inference-provider behavior are outside this Node fixture's
support.

Generated success, error, timeout, and diagnostic reports are local-only under
`.artifacts/benchmarks/`. The runner writes the current report to
`.artifacts/benchmarks/<profile>.json`, replacing that profile's prior output.
For a local sample set, copy reports before they are overwritten to the next unused
`.artifacts/benchmarks/archive/lifecycle-v1/<profile>/run-N.json` path. Harness
code, versioned oracles, and contract documentation are tracked; generated reports
are not retained in the repository.

## Change and comparison policy

The same generated Markdown inputs and chunking implementation feed every compared
implementation. The source digest and output oracle must match the pinned workload
contract. Do not compare timing when workload digest, contract, provider, runtime, or
measurement boundary differs without explicitly describing the difference. Chunking
changes alter workload semantics and require a new workload-contract version and
oracle; do not silently refresh v1 expected outputs.

Additive optional diagnostics can be added without changing the report version when
existing fields retain their meaning and ordinary reports remain usable without them.
Changes to stable field meaning, units, lifecycle scenarios/boundaries, correctness
oracle semantics, or required identity require a new report or workload contract
version as applicable. Preserve versioned oracles; never rewrite historical evidence
to fit a new schema. No numerical performance target is implied.

For a baseline, use `TRAMA_BENCHMARK_PROFILE=trama-10k` or `trama-large`,
`TRAMA_BENCHMARK_REPETITIONS=1`, and a documented timeout with `npm run benchmark`.
Run independent invocations and preserve each local report before the next run
overwrites the profile output. Multiple observations per profile help reveal
variability but do not provide a universal statistical guarantee. Keep failures and
timeouts with their statuses when reporting a run set. Never use capture mode for
ordinary comparisons. Validate JSON, identity/digest, status, correctness, units, and
publication/adoption outcomes before interpreting timings; recompute summaries from
the local raw reports.

Prefer integration-first verification for changes to benchmark/report behavior because
the lifecycle contract spans indexing, semantic work, publication, adoption, and
retrieval. Focused unit tests can supplement that evidence. Do not infer product
performance from the in-memory deterministic provider or treat reports with different
identities as directly comparable.
