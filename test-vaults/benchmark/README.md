# Fixed benchmark material

`trama-small/` contains the 24 exact initial Markdown inputs for the small v1
workload. Do not reformat them: trailing whitespace and the absence of a final
newline are part of the pinned source bytes.

`config.ts` defines the small, 10k, and 25k profiles. `generator.ts` deterministically
defines notes, mutations, queries, and provider fixtures for every profile;
`contract-v1.ts` pins input digests and expected observable outputs. Larger
corpora are generated on demand rather than committing thousands of repeated notes.
Tests check that the small Markdown snapshot and every profile's pinned input
digest match the generator. Changes to this material require a deliberate contract
decision, not a refresh to make a new implementation's benchmark pass.

The host harness copies material into `.artifacts/test-vaults/benchmark/` before
installing Trama and running mutations. Reports are collected separately under
`.artifacts/benchmarks/`. Neither this directory nor the demo fixture is included
in the plugin release archive.
