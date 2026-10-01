# Obsidian benchmark

For screenshots and interactive demos, use [Trama Test Vault](demo-vault.md)
instead. Its realistic notes and normal UI are intentionally separate from the
fixed benchmark fixture and cold startup below.

## Generate before running

From a fresh clone, use Node.js 24 and install dependencies once with `npm ci`.
Then generate and install the small benchmark vault without starting Obsidian:

```sh
npm run benchmark:prepare
```

Preparation builds Trama, checks the fixed inputs, creates the ignored runnable
copy, installs the plugin, and prints its exact folder path. It sends no Obsidian
CLI commands and performs no benchmark measurements. You do not need a separate
`npm run build` for this command.

1. Open the printed folder as a vault through Obsidian's vault switcher.
2. Enable community plugins and Trama in **that generated vault only**.
3. Enable Obsidian's CLI in Settings > General and leave Obsidian running.
4. Run `npm run benchmark` to reuse that prepared vault and collect measurements.

For a larger profile, use the same profile for both commands:

```sh
TRAMA_BENCHMARK_PROFILE=trama-10k TRAMA_BENCHMARK_TIMEOUT_MS=900000 npm run benchmark:prepare
# Open the printed vault and enable Trama, then:
TRAMA_BENCHMARK_PROFILE=trama-10k TRAMA_BENCHMARK_TIMEOUT_MS=900000 npm run benchmark
```

Use `trama-large` for the 25k profile. All profiles use one stable vault:
`.artifacts/test-vaults/benchmark/Trama Benchmark Vault`. Register it once, not
once per run. Until a report exists, preparation reuses the current run; complete
a pending run before switching profiles. After a completed or failed report,
preparation archives the old generated corpus and creates a fresh run inside the
same folder, preserving `.obsidian` and plugin settings. Unexpected files, edited
fixture content, or symlinks cause it to refuse a reset rather than overwrite data.
Run IDs remain in the marker and reports, not the vault name. Reports are written to
`.artifacts/benchmarks/obsidian-<profile>-<run-id>.json`.

## Runtime and safety

`npm run benchmark` is the actual Obsidian benchmark harness. It creates a new
dedicated vault at `.artifacts/test-vaults/benchmark/Trama Benchmark Vault`, builds and
installs Trama in that vault, reloads the plugin using the Obsidian CLI, invokes
`trama:run-obsidian-benchmark`, and checks the report. A pending run reuses its
exact generated vault path after registration. Prior generated corpus data is
archived only when its marker and contents validate; an unmarked directory is never moved. Generated
artifacts are ignored by Git. Stable inputs live in `test-vaults/benchmark/`: the
small profile's Markdown is committed byte-for-byte, and the versioned generator,
profile definitions, and output contract define all three workloads. The harness
checks the committed small fixture before preparing a writable copy. Never run
the mutation lifecycle against the committed source directory.

Obsidian must be running with its CLI enabled in Settings > General. Register the
exact generated vault path through Obsidian's vault switcher. The harness installs
only the current runtime files in that generated vault and writes its
`.obsidian/community-plugins.json` with `trama` enabled. This file does not turn off
Obsidian's restricted mode: if restricted mode is on, turn on community plugins in
that exact generated vault and rerun. The name and path remain stable across runs.
Before any plugin CLI command, the harness asks the CLI
for that vault's path with `vault=<generated-name> vault info=path`; it aborts unless
the response exactly matches the validated generated path. The targeted restricted
mode check, plugin enable, reload, and benchmark command follow that proof. If the
CLI is unavailable, the runtime remains installed in the generated vault and the
pending run can be retried. The harness never lists vaults or falls back to the
active vault. Do not register or target a personal vault for this command.

Profiles are `trama-small` (24 notes, 128 chunks), `trama-10k` (1,100 notes,
10,000 chunks), and `trama-large` (2,750 notes, 25,000 chunks). The default is
small. Example:

```sh
TRAMA_BENCHMARK_PROFILE=trama-10k TRAMA_BENCHMARK_TIMEOUT_MS=900000 npm run benchmark
```

The plugin reads the versioned `.trama-benchmark-vault` through Obsidian's adapter,
checks the vault name and fixture identity, and starts without loading the normal
index or scheduling maintenance. The command rechecks the marker before mutations
and before report output. Each run uses a fresh random OPFS identity, the production
Worker/WASM runtime, actual Obsidian Vault APIs, deterministic local embeddings,
scoped Performance diagnostics, and in-memory publication. No provider network call
is made. The report schema is `trama-obsidian-report-v1`, separate from the older
Node `trama-benchmark-report-v2` schema. It identifies the Obsidian app and plugin
versions, build, storage/transport/publication boundaries, fixture digests,
scenario outcomes, phase aggregates, and correctness gates. RSS and heap memory are
explicitly `unsupported`. Publication filesystem adapter time, fixture generation,
and app startup are excluded. A successful report appears as
`.trama-benchmark-report.json` inside the generated vault and as a run-ID archive
under `.artifacts/benchmarks/`. The hidden vault report is the runtime-to-host
handoff; reports and compiled generator caches are collected
in `.artifacts/benchmarks/`, separately from runnable vault state. Failures and timeouts have distinct
statuses and do not emit `benchmark_completed`.

`.artifacts/test-vaults/archive/` is recoverable history, not an active vault or
committed fixture. It holds corpora replaced between runs and legacy generated
vaults preserved during layout changes. You never need to open it to run a benchmark.

The older Node runner is retained as historical local evidence until small, 10k,
and 25k Obsidian runs pass the corresponding fixture and output oracles. Its reports
cannot be compared as Worker/OPFS measurements. CI and release run ordinary tests;
the GUI benchmark is manual.
