# Trama

Trama is a desktop-only Obsidian plugin for local AI conversation and semantic connections. **Voce** is the agent chat that can navigate linked notes, **Filo** discovers semantically related notes, and **Lente** searches indexed visible Markdown notes. Chat and embedding requests go only to a user-approved local LM Studio endpoint. Trama performs no network requests at startup; connection and model discovery are triggered by sending a message or indexing the vault.

## Setup

1. Install and start [LM Studio](https://lmstudio.ai/) **0.3.29 or newer**, load a chat model and an embedding model, and enable its local OpenAI-compatible server (normally `http://127.0.0.1:1234/v1`).
2. Configure the chat model and embedding model independently in the plugin settings.
3. Use **Update index** from the command palette for the initial explicit index, then open **Voce** with **Open Voce**, **Filo** with **Open Filo**, or **Lente** with **Open Lente**.

The live semantic index is one mutable SQLite WASM database persisted through the
OPFS SAH pool. `.trama/sqlite/v1/` stores only the opaque vault identity and
explicit manual snapshot files; configure this generated directory in your sync
tool's exclusions. Each note mutation is transactional, while a longer Update
or Rebuild may temporarily expose an incomplete mixed state. Every Worker open
also fences the state incomplete; Update or Rebuild re-establishes completion
from fresh vault truth. The monotonic change counter invalidates UI caches; it
is not a publication generation. Trama reads Markdown notes only and has no
note-write, edit, or save-as-note capability. Voce messages remain in memory
and are not persisted.

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
matching and labels the result degraded. Its derived FTS5 lexical index is maintained
inside the mutable SQLite backend.

Indexing is explicit the first time. After a usable index exists, visible Markdown
create, modify, delete, and rename events are coalesced for about 1.5 seconds and
processed as per-note incremental updates. **Update index** is the normal synchronization
mode: it scans the current vault, compares committed content identities, and embeds only
new or changed notes while removing deleted paths. **Rebuild index** remains the explicit
forced rebuild for recovery or configuration refresh. If a note is moved or deleted while
either pass is running, that stale path is logged and skipped, then the queued vault event
is reconciled without failing the whole operation. An interrupted or failed pass may leave
the searchable index incomplete; a later Update or Rebuild reconciles it deterministically
while search remains available.

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
they may include paths, counts, timings, change-counter/status information, and safe
errors, but never note or chunk text, vectors, hashes, exact embedding inputs, or
serialized index data. Enable the setting only when you are comfortable with the
console-visible chat data.

## Development

The normal build produces the plugin's six runtime files from the pinned SQLite
inputs and the fingerprinted local build cache. The generated root assets
(`main.js`, `sqlite-worker.mjs`, `sqlite3.mjs`, and `sqlite3.wasm`) are ignored;
they are build products, not source-controlled runtime copies. The cache is
repository-local and ignored as well.

Build and install the plugin into a vault with one command:

```sh
npm run install:plugin -- "/path/to/your/vault"
```

Alternatively, set the vault path through the environment:

```sh
OBSIDIAN_VAULT_PATH="/path/to/your/vault" npm run install:plugin
```

The production package has six runtime files: `main.js`, `sqlite-worker.mjs`,
`sqlite3.mjs`, `sqlite3.wasm`, `manifest.json`, and `styles.css`. The installer
verifies that the target is an Obsidian vault, then copies exactly those six
files into `<vault>/.obsidian/plugins/trama/`. Restart or reload Obsidian after
installation. Production startup is network-silent: it loads the packaged
SQLite WASM assets and never downloads them at runtime.

The pinned SQLite source, sqlite-vec source, Emscripten image, flags, patches,
and build inputs are recorded in the repository's supply-chain metadata. A
cache entry is reusable only when its fingerprint and output verification
match those inputs. Release verification checks the pinned inputs, manifests,
version agreement, and the exact six-file package inventory. The generated
bytes are not promised to be identical across build environments; reproducible
verification is based on the pinned inputs and recorded digests.

Run the development checks separately with:

```sh
npm install
npm run format
npm run lint
npm test
npm run build
```

### Optional performance workloads

Performance measurements are opt-in and use deterministic synthetic Markdown passed
through the production chunker. Results are written to the ignored
`.artifacts/trama-benchmark/` directory; no vault is read or modified.

```sh
npm run benchmark
```

The single 10,000-chunk Trama workload reports rebuild and unchanged-update time,
mutation timings, search latency, process RSS delta, package bytes, deterministic
feature-path results, and snapshot size. Metrics unavailable to the in-memory Node
harness are explicitly reported as `unsupported`. It never reads a real Obsidian vault.

Do not run `npm run dev`; Obsidian loads the production `main.js`. Current
limitations include the cost of exact SQLite vector scans and maintaining FTS5 on large
corpora. Hybrid retrieval uses reciprocal-rank fusion (RRF) over exact semantic and
lexical candidates; there is no ANN/HNSW backend.
The conservative 384/64 chunking is fingerprinted, so changing it requires an explicit
full reindex. Filo and Voce use native (rather than React) UI. Trama is an independent,
clean-break plugin with no compatibility guarantees for other plugins or earlier identities.
