# Test vaults

These committed inputs are development material, not production plugin files.
The demo and benchmark sources are not CLI targets. Run mutation workflows only
in the marked generated benchmark vault under `.artifacts/test-vaults/`.

- `demo/`: fictional notes for interactive walkthroughs.
- `benchmark/`: generator inputs for the one fixed benchmark corpus.

Prepare the generated vault once from the repository checkout:

```sh
npm ci
npm run benchmark:prepare
npm run install:plugin -- --test-vaults
```

Register the printed generated benchmark path in Obsidian and enable the CLI. The
generated vault is `.artifacts/test-vaults/benchmark/Trama Benchmark Vault`. Every
CLI selector must prove that its first vault is **Trama Benchmark Vault** at this
exact path, before each operation and after reload. Never rely on the active vault
or target a personal vault.

Each run replaces only generated corpus Markdown, reloads the scoped window, and
waits for a fresh `performance.timeOrigin` before dispatch. It clears local indexes,
document and query caches, and shared cache files through the same visible plugin
Clear All handler; reset waits for active work. It runs the production rebuild,
Lente and Filo retrieval, related-note checks, publication, and Check. Only embedding
requests use a loopback mock; chat requests are not part of the benchmark. Obsidian
settings, plugin installation, and vault registration remain in place.

The compact report is `trama-simple-benchmark-report-v1`; production streaming capture
is the completeness authority, with raw JSONL and a supporting console tail. Two
consecutive normal runs passed all 12 gates: `e6a84c53-9ce0-4c6b-afa5-c88e51d544a0`
and `4c5357ca-7981-47ae-b0ad-a06f2b1336e6`. See the
[current benchmark guide](../docs/obsidian-benchmark.md) for evidence limits.

See [demo setup](../docs/demo-vault.md) for the interactive walkthrough.
