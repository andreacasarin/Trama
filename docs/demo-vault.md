# Trama Test Vault

The demo vault is separate from the fixed benchmark corpus. It contains fictional
development notes: 10 daily entries in `journal` and 30 linked topic notes in
`zettelkasten`, covering retrieval, embeddings, SQLite, and Trama workflows.
The source notes live in `test-vaults/demo/`; the runnable copy is ignored by Git.

From a fresh clone, use Node.js 24 and install dependencies once with `npm ci`.

Run this one-time setup to create both generated test vaults and install or update
Trama in them:

```sh
npm run install:plugin -- --test-vaults
```

It builds once, prepares only missing generated copies, and installs or updates Trama
in both the demo and benchmark vaults. Existing generated vaults are reused rather
than regenerated; their benchmark corpus/run and reports are preserved. The
command validates the exact generated paths before writing, prints both paths, and
instructs you to add both vaults to Obsidian and enable Trama in each. Enable the
Obsidian CLI in Settings > General > Command line interface for benchmark runs.
Setup sends no Obsidian CLI commands or model requests; no manual vault ID is
needed for the standard flow.

Open `.artifacts/test-vaults/demo/Trama Test Vault` as a vault in Obsidian. Enable
community plugins and Trama **in that vault only**. The normal commands are
`Trama: Open Lente`, `Trama: Open Voce`, and `Trama: Open Filo`. This vault has a
`.trama-demo-vault` marker, not the benchmark marker, so it starts the normal UI
and does not register the benchmark command.

The setup validates each exact marked path before writing, refuses symlinks, and
preserves plugin settings. The demo-note preparer refuses to overwrite edited demo
notes and writes only to the marked demo path. Setup never accesses personal vaults.
Any CLI interaction must first prove the exact demo path with
`verifyDemoCliTarget`; there is no active-vault fallback. A new vault requires manual registration once.

For a first demo, use keyword search in Lente, then run Update to index the notes.
For semantic/hybrid retrieval and Filo suggestions, configure an embedding model
in this vault's Trama settings and Update again. Voce responses require a chat
model. Provider settings are not copied from another vault; no model calls are
made by the preparer. Do not present benchmark fixtures as real AI responses.

The first preparation creates an empty runtime index: run `Trama: Update index`
before searching. The preparer preserves existing model settings and index data.
If you have edited a generated demo note, it stops rather than overwriting that
note; save those edits elsewhere or deliberately reconcile them with the source
before preparing again. Do not delete generated vaults as a routine refresh step.

Suggested walkthrough:

1. Search Lente for `embedding cache` and open a source note.
2. Open `Embedding cache reuse` and explore Filo's related notes.
3. Ask Voce: “Why do we keep lexical search alongside embeddings?”
4. Follow a reference from the answer back to its source.

The journal entry `2026-09-30` rehearses this sequence. Treat the notes as editable
demo material, not measured performance evidence. Use `npm run benchmark` for the
separate versioned workload.
