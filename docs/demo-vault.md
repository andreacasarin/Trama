# Trama Test Vault

The demo vault is separate from the fixed benchmark corpus. It contains fictional
development notes: 10 daily entries in `journal` and 30 linked topic notes in
`zettelkasten`, covering retrieval, embeddings, SQLite, and Trama workflows.
The source notes live in `test-vaults/demo/`; the runnable copy is ignored by Git.

From a fresh clone, use Node.js 24 and install dependencies once:

```sh
npm ci
```

Before a demo, build and generate/install the runnable copy:

```sh
npm run build
npm run demo:prepare
```

These commands recreate missing ignored artifacts from committed sources. Obsidian
does not need to be running during preparation. Rerun them after code changes;
if the vault is already open, reload Trama (or reopen the vault) to load the new build.

Open `.artifacts/test-vaults/demo/Trama Test Vault` as a vault in Obsidian. Enable
community plugins and Trama **in that vault only**. The normal commands are
`Trama: Open Lente`, `Trama: Open Voce`, and `Trama: Open Filo`. This vault has a
`.trama-demo-vault` marker, not the benchmark marker, so it starts the normal UI
and does not register the benchmark command.

The preparer only writes to that exact marked path, refuses symlinks, preserves
plugin settings, and refuses to overwrite edited demo notes. It neither accesses
personal vaults nor modifies benchmark vaults. Any CLI interaction must first
prove the exact demo path with `verifyDemoCliTarget`; there is no active-vault
fallback. A new vault requires manual registration once.

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
