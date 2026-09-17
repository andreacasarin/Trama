# Trama

Trama is an Obsidian plugin for local AI conversation and semantic connections on desktop and mobile. **Voce** is the agent chat that can navigate linked notes, **Filo** discovers semantically related notes, and **Lente** searches indexed visible Markdown notes. Chat and embedding requests go only to a user-approved LM Studio endpoint. Trama performs no network requests at startup; provider access is triggered only by an explicit chat, search, or semantic-preparation action.

## Setup

1. Install and start [LM Studio](https://lmstudio.ai/) **0.3.29 or newer** on a device that can reach the configured endpoint, load a chat model and (when desired) an embedding model, and enable its local OpenAI-compatible server.
2. Configure the chat model, embedding model, and optional publication folder in plugin settings. The default synchronized file is `Trama/index/index.sqlite3`.
3. Use **Update lexical index** from the command palette for the initial explicit lexical index. This step makes no AI request. Use **Update semantic index** when embeddings are available, then open **Voce**, **Filo**, or **Lente**.

The live index is one mutable SQLite WASM database persisted through the official
OPFS SAH pool. Trama publishes exactly one synchronized artifact,
`<publication folder>/index.sqlite3`, through Obsidian's `DataAdapter`. The
folder is vault-relative, case-sensitive, and defaults to `Trama/index`; changing
it affects future publications and does not move or delete the old folder. The
publication folder is automatically excluded from Markdown indexing.

Build, Update, and Rebuild reconcile lexical notes/chunks/FTS without embeddings.
**Update semantic index** is explicit and resumable: it adds compatible vectors
in bounded batches and can be retried after an interruption or provider failure.
Search remains available while semantic coverage is none or partial. A loaded
publication is immediately searchable and reports **snapshot loaded — not locally
reconciled** until a user-triggered Update or Rebuild converges it with Markdown.
The publication ID is used for equality only; there is no manifest, hash filename,
device ordering, merge, compression, chunking, or sidecar metadata.

For synchronized vaults, use a single-writer-in-time handoff: finish indexing and
publication on device A, wait for Obsidian Sync or iCloud to converge, then index
on device B. The provider chooses the last/authoritative file version (including
its conflict behavior); Trama adopts any differing valid file and does not compare
timestamps or invent a merge. Concurrent writers can lose derived work and may
need a new lexical or semantic Update.

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
processed as per-note incremental updates. **Update lexical index** is the normal offline lexical
reconciliation mode: it scans the current vault, compares committed content identities,
updates notes/chunks/FTS, and removes deleted paths without contacting an AI service.
**Rebuild lexical index** is the explicit forced lexical reconciliation for recovery or
configuration refresh. **Update semantic index** requests vectors for missing or
incompatible chunks. **Rebuild semantic index** discards existing vectors and regenerates
them; **Rebuild lexical and semantic indexes** runs both rebuilds in that order. If a note is moved or deleted during
lexical indexing, that stale path is logged and skipped, then the queued vault event
is reconciled without failing the whole operation. Semantic preparation finishes against
the committed SQLite notes even if vault notes change during the run. It then reports
the index as stale; a lexical Update followed by semantic Update processes only changed
notes and missing vectors, without rebuilding everything. An interrupted or failed pass may leave
the searchable index incomplete; a later Update or Rebuild reconciles it deterministically
while search remains available.

During a full lexical rebuild, status reports note and estimated chunk progress with time
estimates. Hashing and chunking run in the SQLite Worker. **Update semantic index** reports whole-job vector progress and
keeps already committed batches when a provider request fails or is cancelled.

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

`package.json` is the source for the release version. To bump it, run
`npm version 0.4.0 --no-git-tag-version` (using the intended version). The npm
version hook updates `manifest.json` and `package-lock.json`; commit all three
files before tagging that commit. CI checks that the derived versions match.

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

The pinned SQLite source, SQLite-Vector source, Emscripten image, flags, and
build inputs are recorded in the repository's supply-chain metadata. Generated
assets are reused only while their input fingerprint and checksums match.
Release verification checks the pinned inputs, compiled capabilities,
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

The single 10,000-chunk Trama workload reports lexical rebuild, semantic preparation,
unchanged-update time, mutation timings, search latency, process RSS delta, package
bytes, deterministic feature-path results, and publication byte/copy metrics. Metrics
unavailable to the in-memory Node
harness are explicitly reported as `unsupported`. It never reads a real Obsidian vault.
CI renders the metrics as a GitHub Actions job summary and retains the complete JSON
report as a downloadable workflow artifact.

Do not run `npm run dev`; Obsidian loads the production `main.js`. Current
limitations include the cost of exact SQLite vector scans and maintaining FTS5 on large
corpora. Hybrid retrieval uses reciprocal-rank fusion (RRF) over exact semantic and
lexical candidates; there is no ANN/HNSW backend.
The conservative 384/64 chunking is fingerprinted, so changing it requires an explicit
full reindex. Filo and Voce use native (rather than React) UI. Trama is an independent,
clean-break plugin with no compatibility guarantees for other plugins or earlier identities.

## Mobile and synchronized publication checklist

The mobile lifecycle and packaged asset URLs are covered by automated tests, but actual
iOS WebView, OPFS, SQLite-Vector, LAN inference, and provider delivery still require
manual validation. Before relying on a synchronized vault, check the following:

- On a clean iOS install, load the plugin, confirm Worker/WASM/SQLite-Vector/OPFS startup,
  and verify there are no startup network requests.
- Offline, build a lexical index, restart Obsidian, and confirm keyword Lente search still
  works without a publication or embedding provider.
- On desktop, publish through both Obsidian Sync and iCloud; record publication size,
  timing, temporary storage, and observed memory pressure.
- On mobile, verify a same-ID file is ignored and a differing valid ID is adopted without
  prompting, AI calls, Markdown reconciliation, or republishing. Search before local
  reconciliation and confirm the freshness message.
- After provider convergence, publish from mobile back to desktop. Test reachable LAN
  Prepare/Hybrid/Filo/Voce, unreachable-AI lexical fallback, interrupted/invalid/
  incompatible files, and sequential two-device handoff.

These real-device, Obsidian Sync/iCloud, LAN, publication-size, and two-device conflict
checks are pending user validation; automated tests do not claim them as successful.

See [SQLite publication details](docs/sqlite-snapshots.md) for the file, adoption,
retry, compatibility, and crash-boundary contract.
