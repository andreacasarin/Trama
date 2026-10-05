# Obsidian benchmark

The benchmark uses one fixed, prepared corpus and the normal production Obsidian
plugin runtime. It contains 3,000 notes of about 400 characters each. Do not use
the superseded profile matrix or historical report as a current benchmark result.

## Prepare once

From the repository checkout, prepare the corpus and install Trama in the generated
vault:

```sh
npm ci
npm run benchmark:prepare
npm run install:plugin -- --test-vaults
```

Register the printed generated-vault path in Obsidian and enable the CLI. Preparation
and plugin installation are one-time steps. The generated vault is
`.artifacts/test-vaults/benchmark/Trama Benchmark Vault`.

Every CLI selector must prove that its first vault is **Trama Benchmark Vault** at
that exact registered path. Verify the selected vault before each CLI operation,
including after reload; never rely on the active vault or access a personal vault.
The benchmark evaluates the registered palette command and requires a synchronous
invoked/running receipt. Obsidian's internal command-manager API is not available
through this CLI.

## Run

Run the fixed benchmark command:

```sh
npm run benchmark
```

Each run replaces only generated corpus Markdown, reloads the scoped vault window,
and waits for a fresh `performance.timeOrigin` before dispatching work. It invokes
the same visible plugin Clear All handler used by settings or the command palette;
the shared reset waits for active work. That handler clears local indexes, document
and query caches, and shared cache files. The benchmark then runs the normal
production lexical and semantic rebuild, Lente and Filo retrieval, related-note
checks, publication, and Check. Obsidian settings, plugin installation, and vault
registration remain in place. Only embedding requests use a loopback HTTP mock;
the benchmark does not issue chat requests or use an alternate runtime.

Production diagnostic streaming capture is the completeness authority. It is
bounded to 10,000 records and 8 MiB and saved as raw JSONL. The `dev:console` log
is a supporting tail, not a complete start-to-finish stream. The artifact pair is
`.artifacts/benchmarks/trama-simple-<runId>.performance.jsonl` and
`.artifacts/benchmarks/trama-simple-<runId>.console.log`. The compact correctness
report is `trama-simple-benchmark-report-v1`.

Two consecutive normal runs passed all 12 gates:
`e6a84c53-9ce0-4c6b-afa5-c88e51d544a0` and
`4c5357ca-7981-47ae-b0ad-a06f2b1336e6`. Each captured 2,684 raw timing records:
adoption 4, semantic 1,914, lexical 753, publication 2, retrieval 8, and related
notes 3. Cache publication validates actual non-empty bytes up to 4 MiB, then
checks stable inventory and generations after a normal warning-free Check. Treat
these as correctness evidence; do not add phase durations into wall time or infer
speed, mobile behavior, or judged relevance.

The former small/10k/large profile matrix, 12-scenario/17-gate workflow, and
1,100-note/10,000-passage report are historical and cannot be compared with this
benchmark. The benchmark is not a mobile performance test or relevance evaluation.
Committed test-vault source directories are inputs only; run mutation workflows
only in the marked generated benchmark vault after verifying its exact path.
