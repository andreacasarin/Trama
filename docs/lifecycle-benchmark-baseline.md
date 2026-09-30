# Lifecycle benchmark run and comparison guide

This guide describes how to collect and compare lifecycle benchmark observations.
It does not publish a machine-specific performance baseline. See the
[lifecycle benchmark contract](lifecycle-benchmark-contract.md) for the stable
workload, output oracle, report identities, and change policy.

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
`.artifacts/trama-benchmark/<profile>.json` on each run. If keeping a local sample
set, copy each report before the next run to the next unused
`.artifacts/trama-benchmark/archive/lifecycle-v1/<profile>/run-N.json`. Check that
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
allocated by an individual scenario; sampling can miss short peaks. RPC latency
includes worker/RPC and implementation costs. In particular,
`prepareSemanticWork` is not pure SQL selection timing. SQL statement-level timing is
unsupported.

The fixture uses a deterministic, instantaneous inference provider. Browser
Worker/OPFS behavior, real Obsidian vault/UI latency, and real inference-provider
latency are outside this Node harness's support. Treat the results as workload- and
environment-specific observations, not product performance guarantees.
