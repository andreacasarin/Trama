# Obsidian benchmark

For screenshots and interactive demos, use [Trama Test Vault](demo-vault.md)
instead. Both vaults load normal Trama with Voce, Filo, Lente, settings, and all
standard commands. Only their note content and benchmark inputs differ.

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

To create missing test vaults or update the plugin in both existing copies, use
`npm run install:plugin -- --test-vaults` (after `npm ci` on a fresh checkout).
It builds once and reuses the existing preparation scripts only for missing vaults.
Existing copies keep their settings, index data, and current benchmark corpus/run.
It does not run the benchmark or reload Obsidian. See
[the demo vault instructions](demo-vault.md) for safety and registration details.

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

The plugin always follows its standard startup path. A valid, exact-path
`.trama-benchmark-vault` marker adds the benchmark driver command; it never
disables normal commands, views, settings updates, or vault-event routing.
The driver rechecks the marker before operations and before report output.

The host starts a temporary deterministic fixture server on `127.0.0.1` at a
random port, with a run-specific model ID and verified server identity. It configures ordinary Trama settings to
use that endpoint for embedding and chat, enables Performance logging, and leaves
automatic maintenance off (the default) so explicit operations are repeatable.
The normal HTTP embedding adapter and streaming Responses adapter handle all
requests. No real model provider is contacted. The server closes when the run
ends; those fixture endpoints are not usable for interactive AI afterward.

The driver invokes the loaded plugin's normal Rebuild, Update, Publish, publication
Check, Lente, Filo, and chat/tool operations. Vault events populate the normal
mutation journal. There is no second index, fake chat session, in-memory publication,
or fresh benchmark-only OPFS identity. Rebuild establishes the measured initial
state in the vault's normal persistent OPFS store. Publication uses the real
`Trama/index` filesystem destination. All phase timing is emitted by production
code; the driver only aggregates those events and records scenario completion.
Phase records can be nested and must not all be summed as independent elapsed time.
Publication Check measures checking the current publication, not forced adoption
into a second empty index.
Live cache entries may include reusable historical vectors. Correctness gates
require complete current semantic heads, zero lag/missing vectors, and sufficient
compatible vector coverage, not a snapshot-only cache count.

The report schema is `trama-obsidian-report-v2`. It labels the standard runtime,
persistent vault storage, loopback HTTP fixture transport, and filesystem publication.
These measurements must not be compared directly with the old Obsidian v1
in-memory-publication reports or the historical Node reports. RSS and heap memory
are explicitly `unsupported`. Filesystem publication and provider HTTP transport
are included; fixture generation and app startup are excluded. A successful report appears as
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
