# Trama

Trama is a desktop-only Obsidian plugin for local AI conversation and semantic connections. **Voce** is the agent chat that can navigate linked notes, **Filo** discovers semantically related notes, and **Lente** searches indexed visible Markdown notes. Chat and embedding requests go only to a user-approved local LM Studio endpoint. Trama performs no network requests at startup; connection and model discovery are triggered by sending a message or indexing the vault.

## Setup

1. Install and start [LM Studio](https://lmstudio.ai/) **0.3.29 or newer**, load a chat model and an embedding model, and enable its local OpenAI-compatible server (normally `http://127.0.0.1:1234/v1`).
2. Configure the chat model and embedding model independently in the plugin settings.
3. Install the standard plugin artifact (including the TalaDB worker/WASM assets), reload Obsidian, and use **Rebuild index** once on first use. Then open **Voce**, **Filo**, or **Lente**.

The semantic index is stored at `<vault>/.trama/index/taladb-v1/`. The first explicit rebuild creates and persists a per-vault opaque Tala database identity; tests provide an identity explicitly. Legacy `.trama/index` files are inert and are never migrated or deleted. TalaDB is the sole production backend, using a mutable `ready`/`dirty` state and normalized exact `Float32` vectors. Configure this generated directory in your sync tool's exclusions. Trama reads Markdown notes only and has no note-write, edit, or save-as-note capability. Voce messages remain in memory and are not persisted.

## Filo related notes

Filo always shows the seven strongest unique visible Markdown notes related to the
active note, then extends the list up to twenty for additional notes with cosine
similarity of at least 0.30. It opens a result with Obsidian's native navigation. Ranking uses the active note's
signal against conservative 384-character chunks with 64-character overlap; chunk
scores are aggregated to unique notes. The same ordered results appear as optional
suggestions in Voce after the active-note suggestion. Suggestions never attach
themselves to a prompt. Filo presents results as a native disclosure list: the note
title opens the note, the caret reveals the winning indexed passage and source lines,
and cosine similarity is summarized as High (at least 0.72), Medium (at least 0.50),
or Low using constants owned by the view.

## Lente search

Lente searches indexed visible Markdown only after Enter or Search is pressed.
Results are unique notes with their winning passage. Relevant uses deterministic
hybrid vector/BM25 ranking; Updated uses live note modification times. If query
embeddings are unavailable, Lente retries lexical filename, path, and body
matching and labels the result degraded. Lexical fields and vectors are persisted
in TalaDB; searches use its native FTS and flat cosine indexes.

Indexing is explicit the first time. After a usable index exists, visible Markdown
create, modify, delete, and rename events are coalesced for about 1.5 seconds and
processed as per-note incremental updates. **Update index** is the normal synchronization
mode: it scans the current vault, compares committed content identities, and embeds only
new or changed notes while removing deleted paths. **Rebuild index** remains the explicit
forced rebuild for recovery or configuration refresh. If a note is moved or deleted while
either pass is running, that stale path is logged and skipped, then the queued vault event
is reconciled without failing the whole operation. Searches continue while writes are in
progress and may observe dirty or partial rows; an interrupted operation remains marked
dirty and converges on the next explicit Update/Rebuild. Exact-row hydration skips rows
that disappeared after ranking.

Checkpoint export/import is an explicit lifecycle operation on `IndexManager`; it is
never performed during startup or automatically after an update. Checkpoint bytes are
stored by the DataAdapter below `.trama/index/taladb-v1/checkpoints/`, and import validates
the complete payload, replaces the mutable store under an exclusive writer, then validates
and publishes `ready` once.

During a full rebuild, Filo estimates the number of embedding texts from file-size
metadata calibrated by a deterministic sample of at most 32 notes passed through the
real chunker. This keeps estimation fast while accounting for the vault's line and
overlap patterns. Its single status row shows the current step, a stable approximate
progress bar, and a throughput-based ETA; the final count is corrected when embedding
finishes.

## Voce chat

Voce uses LM Studio's `/v1/responses` endpoint with streaming enabled. Each
request includes the complete local conversation history and `store: false`,
so LM Studio does not hold the conversation. Chats are kept only in memory and
are not persisted.

The visible transcript stays clean and compact: it shows only user and
assistant conversation bubbles, a generic working state while Voce is busy,
compact source chips for accessed notes, and user-actionable error text. Raw
protocol roles, tool calls, tool arguments/results, and attached note contents
are not rendered in the chat view. Each completed assistant response has an
action row with a copy button; the row can accommodate additional response
actions later without changing message rendering. Message bodies use
Obsidian's reading-mode Markdown renderer, so their internal links follow the
same navigation behavior as links in a rendered note.

Use Obsidian wikilinks such as `[[Daily/Today]]` in the composer to attach one
or more visible Markdown notes to the next turn, including unopened notes.
Typing `@` opens the note picker as a shortcut and inserts the selected note as
a visible wikilink. Full paths, aliases, headings, and unique note names are
resolved deterministically; missing or ambiguous citations produce an error
instead of silently omitting context. Attached notes also appear as removable
chips, are sent only with that turn, and clear as soon as the send begins. Voce
does not fall back to the active note automatically. A compact context strip
above the composer suggests the most recently active visible Markdown note;
indexed related-note suggestions follow it in relevance order. Click a tag to
toggle it, or use the Plus button for the full picker. Enter sends the message,
while Shift+Enter inserts a newline. Long
messages are collapsed by default and can be expanded in place.

The settings page provides these chat controls:

- **Temperature**: a required slider from **0** through **1** in **0.1**
  increments, with a default of **0.7**.
- **Maximum generated-output tokens**: **0** means **Auto**; larger values use
  **1K** increments through **128K**. Reasoning tokens count toward this limit
  where applicable.
- **Reasoning effort**: **Auto**, **None**, **Low**, **Medium**, or **High**.
  Auto leaves the value unset, while the explicit levels are sent to LM Studio
  when selected.

Voce's tools run in the plugin and are read-only: they can search the vault,
read notes, and discover or follow links. Answers show the accessed note paths
and line ranges as provenance. Wikilinks inside an attached note can therefore
lead Voce to related notes when the question requires them; traversal remains
bounded by the existing tool-round and read limits rather than eagerly loading
an entire link graph. Trama does not use Remote MCP or hosted tools; embeddings
continue using LM Studio's existing `/v1/embeddings` endpoint.

The settings page also includes **Detailed debugging**, which is off by default.
When enabled, Trama writes one `[Trama]` console stream using the current
committed setting; no diagnostic file is created. Rich chat diagnostics can
contain full sensitive prompts, selected-note contents, requests, SSE events,
tool arguments/results, and errors. Index and Filo diagnostics are metadata-only:
they may include paths, counts, timings, generation/status information, and safe
errors, but never note or chunk text, vectors, hashes, exact embedding inputs, or
serialized index data. Enable the setting only when you are comfortable with the
console-visible chat data.

## Development

Build and install the plugin into a vault with one command:

```sh
npm run install:plugin -- "/path/to/your/vault"
```

Alternatively, set the vault path through the environment:

```sh
OBSIDIAN_VAULT_PATH="/path/to/your/vault" npm run install:plugin
```

The installer verifies that the target is an Obsidian vault, then copies
`main.js`, `manifest.json`, `styles.css`, and the local `@taladb/web/worker/` and
`@taladb/web/pkg/` assets into `<vault>/.obsidian/plugins/trama/`. Restart or reload
Obsidian after installation. Agents did not run this installer or launch Obsidian;
the manual checklist below is user-run.

The build anchors TalaDB's public `openDB` worker URL to the installed plugin resource
URI via Obsidian's public `VaultAdapter.getResourcePath`, so the worker, glue, and WASM
files remain local to the ordinary plugin artifact. TalaDB's public `openDB` owns the
dedicated Worker and Web-Lock writer isolation; Trama does not add a second dispatcher.

Run the development checks separately with:

```sh
npm install
npm run format
npm run lint
npm test
npm run build
npm run artifact:verify
npm run taladb:gate0
```

Do not run `npm run dev`; Obsidian loads the production `main.js`. Current
limitations include the cost of flat cosine scans and native FTS candidate retrieval
on large corpora. Hybrid retrieval uses reciprocal-rank fusion (RRF) over semantic
and lexical candidates; there is no ANN backend.
The conservative 384/64 chunking is fingerprinted, so changing it requires an explicit
full reindex. Filo and Voce use native (rather than React) UI. Trama is an independent,
clean-break plugin with no compatibility guarantees for other plugins or earlier identities.

### Optional scale benchmark

The raw exact-only scan probe from earlier revisions is retired. The maintained,
opt-in benchmark is `npm run taladb:benchmark`; it exercises the repository's TalaDB
profiles without implying ANN or production-scale guarantees. The committed evaluation
candidate is supported through the representative 25,000-chunk native profile; 50,000
chunks is unsupported after an actual Worker/WASM `Error: unreachable` (and an earlier
approximately 1.93 GiB restart), while 100,000 chunks was not run and is unsupported.
Validate startup, restart, RSS, cancellation, and real-vault behavior separately with
focused tests and the manual Obsidian/LM Studio smoke test below.

### Manual Obsidian checklist (user-run)

1. Install the standard artifact with all local Tala worker/WASM assets and reload the plugin.
2. Run **Rebuild index** once. Confirm startup is silent, then confirm partial search remains available while an index is dirty and that a later **Update index** reaches convergence.
3. Create, edit, rename, and delete visible Markdown notes; verify live results and Filo/Voce refresh after the write completes.
4. Cancel and restart an index operation; verify the dirty state recovers on the next explicit update.
5. Verify legacy `.trama/index` files remain inert and untouched.
