# Historical Node lifecycle benchmark contract

This document records the former deterministic Node lifecycle benchmark. It is kept
only to interpret historical Node reports and tests. It does not define current
benchmark commands, profiles, correctness gates, or performance claims. See the
[current V1 implementation and evidence](langchain-sqlite-implementation.md); no
active benchmark workflow is documented.

The old report-v2/workload-v1 contracts, expected-outputs-v2 oracle, source manifests,
12-scenario/17-gate suite, and profile matrix are superseded for current benchmark
acceptance. Historical output expectations remain in
`tests/workloads/legacy-oracle.ts` for legacy tests only. Do not compare the former
1,100-note/10,000-passage report or other profile timings with the current runs.

The current report is `trama-simple-benchmark-report-v1`. Two consecutive normal
runs passed all 12 gates: `e6a84c53-9ce0-4c6b-afa5-c88e51d544a0` and
`4c5357ca-7981-47ae-b0ad-a06f2b1336e6`. Completeness and evidence limits are
documented in the Obsidian benchmark guide. These runs establish correctness gates,
not speed, mobile, or relevance claims.
