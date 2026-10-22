# Trama Test Vault

The demo vault is separate from the fixed benchmark corpus. It contains fictional
daily journal entries and linked topic notes in `zettelkasten`, covering retrieval,
embeddings, SQLite, and Trama workflows.
The source notes live in `test-vaults/demo/`; the runnable copy is ignored by Git.

From a fresh clone, use Node.js 24 and install dependencies once with `npm ci`.

Run this one-time setup to create the generated demo vault and install or update
Trama in it:

```sh
npm run install:plugin -- --test-vaults
```

It builds once, prepares the generated demo vault if needed, and installs or updates
Trama there. The command validates the generated path before writing, prints the
path, and instructs you to add the demo vault to Obsidian and enable Trama.
Setup sends no Obsidian CLI commands or model requests; no manual vault ID is
needed for the standard flow.

Open `.artifacts/test-vaults/demo/Trama Test Vault` as a vault in Obsidian. Enable
community plugins and Trama **in that vault only**. The normal commands are
`Trama: Open Lente`, `Trama: Open Voce`, and `Trama: Open Filo`. This vault has a
`.trama-demo-vault` marker, not the benchmark marker, so it starts the normal UI
and does not register the benchmark command.

## Real Obsidian checks

Use this generated vault for checks that depend on Obsidian's actual UI or runtime;
simulated DOM tests do not verify native behavior. Keep unit and integration tests
focused on Trama-owned logic and contracts. Do not report a check as passed until
you have performed it in Obsidian.

- Change a harmless setting, close and reopen Settings, and confirm the value persists.
- In Lente, search for `embedding cache` and open a result. Keyword search works
  without a provider; semantic or hybrid search requires a configured embedding model.
- Open a note and check that Filo shows related notes. After editing a demo note,
  run Update and confirm the refreshed results reflect the index update. This check
  requires a configured embedding model.
- In Voce, type `[[Embeddings` and choose a visible note suggestion;
  confirm the link is inserted into the draft. For skill suggestions, use the demo
  fixture `zettelkasten/Voce demo skill.md`: type `/demo`, choose `demo-guide`, and
  confirm the command is inserted.
- When a chat provider is configured, send a message, stop a response, and start a
  new chat. If the provider supports streaming, confirm text appears as it arrives;
  check that the view follows new text while at the bottom and preserves your reading
  position after you scroll up.

The setup validates each exact marked path before writing, refuses symlinks, and
preserves plugin settings. The demo-note preparer refuses to overwrite edited demo
notes and writes only to the marked demo path. Setup never accesses personal vaults.
Any CLI interaction must first prove the exact demo path with
`verifyDemoCliTarget`; there is no active-vault fallback. A new vault requires manual registration once.

For a first demo, run Update to index the notes, then use keyword search in the
available search interface.
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
demo material, not measured performance evidence.
