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
  confirm the command is inserted. Confirm the picker shows the command and its
  description without the skill's file path; filter by a word in the description.
- When a chat provider is configured, send a message, stop a response, and start a
  new chat. If the provider supports streaming, confirm text appears as it arrives;
  check that the view follows new text while at the bottom and preserves your reading
  position after you scroll up.
- Send at least three prompts. Check that the latest long response is expanded
  and older long responses are collapsed by default; manually expand and collapse
  them. Open **Sources (count)**, follow a note link, and confirm the disclosure
  retains its open/closed choice while that response updates.
- Hover over assistant and user messages and check the icon-only Copy and Edit
  controls use small icons with padded click targets and a muted local message
  day/time beside them. Confirm both the actions and time disappear off hover.
  Hover the empty space across the footer beneath the message: it should reveal
  and retain the actions without moving back over the bubble. Confirm assistant
  actions align right, user actions align left, and the working indicator uses
  compact dots without stretching to fill the message width.
  Check short messages do not clip the timestamp. Tab to each control and
  activate it by keyboard. Paste a copied response into the composer to verify its
  full text, then clear the draft.
- Edit the second prompt: confirm it returns to the composer with its attachments,
  and the second prompt and all subsequent messages disappear. Send a revision
  and confirm the conversation continues from the first exchange. Edit the first
  prompt and confirm the transcript becomes empty before resending.

## Voce UX delivery assessment

Documentation changes are required: README documents the optional skill description
frontmatter, collapse defaults, padded actions, and destructive rewind semantics.
The real-host checklist above covers these interactions.

The existing LangChain/SQLite ADR is updated to document native checkpoint rewind
for message edits. A separate ADR is not needed: the change retains the accepted
in-memory LangGraph history owner and adds no storage format, dependency, or
parallel message history implementation. The native-validation ADR remains unchanged.

Automated verification on 2026-10-26: `npm run build` passed, ESLint passed for
the changed TypeScript sources and tests, and Prettier passed for the updated
documentation. Vitest passed all 80 tests across `voce-view`, `voce-session`,
`template-references`, `demo-vault`, and `v1-plugin`. Session regressions confirm
that rewinding removes later messages from the next model request and that
editing the first prompt removes all earlier model context. Proposed commit:
one focused **Improve Voce conversation UX** commit containing the implementation,
tests, demo skill, README, checklist, and existing ADR update.

The compact hover-action and timestamp follow-up on 2026-10-27 passed the build,
changed-file ESLint, and all 81 tests in the same five suites. Message creation
times remain in the session projection, outside provider messages and persisted
storage; this presentation change needs no additional ADR.

Native UI validation is blocked as of 2026-10-26: Computer Use returned
“Computer Use was not approved to use Obsidian.” No host checks are recorded as
passed. Simulated-element tests cover Trama-owned state and rendering contracts;
they do not validate native layout, pointer targets, clipboard, keyboard navigation,
disclosure events, or streaming scroll behavior. Complete the checklist in the
marked generated demo vault when Obsidian access is available.

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
