# Test vaults

These committed inputs are development material, not production plugin files.

- `demo/`: ten fictional daily notes and thirty linked Zettelkasten notes.
- `benchmark/`: fixed workload definitions and the byte-exact small Markdown fixture.

Do not install Trama or run mutation benchmarks in these source directories.
`npm run demo:prepare` and `npm run benchmark:prepare` prepare writable copies under
`.artifacts/test-vaults/`. Reports and logs live under `.artifacts/benchmarks/`.
Generated Obsidian settings and index state are ignored, not committed here.

From a fresh clone (Node.js 24):

```sh
npm ci
# Demo: build, copy the notes, and install the plugin.
npm run build
npm run demo:prepare
# Benchmark: build and install without touching Obsidian.
npm run benchmark:prepare
```

Open only the generated folder printed by the command in Obsidian and enable
Trama there. Run Update in the demo vault before searching; use `npm run benchmark`
after registering the prepared benchmark vault. Preparation never copies personal
notes or provider settings. Existing generated demo edits are not overwritten.

The runnable benchmark is always `.artifacts/test-vaults/benchmark/Trama Benchmark Vault`.
Register it once; UUIDs identify reports and fixture-provider models, not vault folders.
Both generated vaults load standard Trama with all commands and tabs. Benchmark
runs use its normal persistent index and filesystem publication with Performance
logging and a temporary local HTTP model fixture; there is no benchmark-only startup.
Prior generated corpora are preserved in `.artifacts/test-vaults/archive/` and
are not used by subsequent runs.

See [demo setup](../docs/demo-vault.md) and [benchmark setup](../docs/obsidian-benchmark.md).
