# Trama

Trama is an Obsidian plugin for local AI conversation and semantic connections on desktop and mobile. **Voce** is the agent chat that can navigate linked notes, **Filo** discovers semantically related notes, and **Lente** searches indexed visible Markdown notes. Chat and embedding requests go only to a user-approved endpoint. The current OpenAI-compatible transport is tested with LM Studio 0.3.29+ and does not yet support API-key-authenticated services such as OpenAI or OpenRouter. Trama performs no network requests at startup or while loading settings. Provider access is triggered by an explicit chat/search/index action, or by vault-event maintenance after the separate **Scheduled maintenance** consent is enabled.

## Setup

1. Install and start [LM Studio](https://lmstudio.ai/) **0.3.29 or newer** on a device that can reach the configured endpoint, load a chat model and (when desired) an embedding model, and enable its local OpenAI-compatible server.
2. Configure the chat and embedding models in plugin settings. Embeddings are optional; lexical indexing and search work without a provider.
3. Use **Update index** to build the local indexes and, when configured, prepare and share reusable semantic vectors. With no embedding model, indexing remains network-silent. Then open **Voce**, **Filo**, or **Lente**.

The local SQLite/WASM index keeps one full-note lexical FTS entry per visible note
and structural semantic blocks. Markdown remains authoritative. Semantic blocks use
at most 384 characters of canonical serialized input, including heading context,
with zero overlap. While changed inputs are prepared, the last complete compatible
semantic state remains available; search stays available during indexing.

Only reusable computed vectors are shared. Immutable standalone SQLite cache shards
are merged additively and deduplicated, without sharing FTS state, note heads, paths,
or local IDs. Cache identity uses exact provider-input bytes and a proven compatible
model/output space and task; endpoint reachability or matching dimensions alone do
not establish compatibility. The complete cache and profile lifecycle is described
in [SQLite cache details](docs/sqlite-snapshots.md).

## Filo related notes

Filo generates candidates from the source-note centroid and three diverse semantic
block probes, retrieves up to 32 distinct notes per probe, and unions at most 128
candidates. It then reranks each candidate against all compatible distinct semantic
passages using the symmetric mean of the top two passage matches in each direction.
This exact rerank can consider passages beyond the candidate probes; candidate
generation remains bounded and can miss notes, and exact passage comparisons have no
bounded-latency guarantee. Filo shows the seven strongest unique visible Markdown
notes, then extends the list up to twenty for notes with cosine similarity of at
least 0.30. The winning passage and source lines remain available in the disclosure
list. The same ordered results appear as optional Voce suggestions and never attach
themselves to a prompt.

## Lente search

By default, Lente searches indexed visible Markdown only after Enter or Search is
pressed. The separate **Automatic searches** toggle uses a fixed 500 ms debounce.
Results are limited to twenty unique notes with their winning passage. Relevant uses
hybrid ranking with up to 80 lexical and 80 semantic notes fused by reciprocal rank
with k=60; each semantic note is ranked by its maximum compatible passage cosine.
Updated uses live note modification times. Lente first checks the local query-vector
cache; on a miss it requests a query embedding when a provider is available, and
falls back to lexical filename, path, and body matching if that request is unavailable.
The local FTS index weights body 1, path 2, filename 3, title 3, and headings 0.5
without counting heading text twice.

Indexing is explicit the first time. **Update index** runs finite lexical passes to
convergence, finishes configured semantic work, then publishes. **Rebuild index**
performs fresh lexical construction, clears configured semantic vectors once, resumes
vector batches after safe-boundary interruptions, and publishes only after convergence.
Queuing Rebuild never destroys the currently committed searchable generation. If a note is moved or deleted during
lexical indexing, that stale path is logged and skipped, then the queued vault event
is reconciled without failing the whole operation. An interrupted or failed pass may leave
the searchable index incomplete; a later Update or Rebuild reconciles it deterministically
while search remains available.

During a full lexical rebuild, status reports note and estimated chunk progress with time
estimates. Hashing and chunking run in the SQLite Worker. The semantic phase reports whole-job vector progress and
keeps already committed batches when a provider request fails or is cancelled.

Scheduled maintenance is opt-in. After vault changes, it automatically updates the
lexical index, prepares semantic vectors when an embedding model is configured, and
publishes reusable cache contributions for synchronization. Semantic preparation sends structural note blocks to the configured embedding
endpoint and may incur provider cost. Its adaptive quiet windows are 3, 9, then 20 seconds,
with a 60-second maximum wait for an outstanding edit generation. Stop preserves pending
intent, suspends automatic starts, and lets an already-started cache publication or ingestion
fence settle. Failures display an error and suspend automatic work; there is no hidden
failure retry timer. Advanced settings expose **Update**, **Rebuild**, **Publish**,
**Stop**, **Check**, and **Reset all indexes**. The **Reset all indexes** command
and Advanced settings button use the same confirmation and clear only this vault's
local lexical and semantic state while preserving reusable shared-cache contributions.
It preserves notes, settings, credentials, and vault identity.
Reset refuses while work is active; pending scheduled work alone does not prevent it.
The Automatic maintenance setting is preserved: when enabled, reset schedules the
usual recovery; when disabled, the index stays empty until Update, Rebuild, or
re-enabling scheduled maintenance. If reset fails, the current runtime remains
blocked until a retry succeeds.

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

The settings page offers **Off**, **Performance**, and **Detailed** diagnostics.
Off is the default. Performance writes bounded timing and count events to the
developer console without note text, prompts, provider bodies, tool data,
vectors, hashes, or serialized index data. Detailed includes the existing rich
chat diagnostics, which may contain full prompts, selected-note contents,
requests, SSE events, tool arguments/results, and errors. Normal diagnostics do not
create a file; the optional benchmark's bounded streaming capture is documented
below. Worker phase durations are inclusive wall times; nested phases overlap
their parent, so add SQL calls and callback rows only across top-level phases.
Diagnostic operation IDs are unique per Worker incarnation; semantic and publication
phases share parent/batch IDs across main-thread and Worker spans. Temporary
Performance capture waits for Worker configuration acknowledgements and restores
the selected mode afterward. Its 512-record collector fails on overflow; a
streaming consumer can aggregate every record without retaining the stream.

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

### Optional performance workload

The Obsidian benchmark uses one fixed, preprepared corpus of 3,000 notes with
about 400 characters each. It uses the same chunking for every note; there are
no note-type-specific rules.

Prepare and install the generated benchmark vault once:

```sh
npm ci
npm run benchmark:prepare
npm run install:plugin -- --test-vaults
```

Register the printed generated-vault path in Obsidian and enable the CLI there.
Each CLI selector must prove the first vault is **Trama Benchmark Vault** at the
exact registered path. Each run replaces only corpus Markdown, reloads the scoped
window, and waits for a fresh `performance.timeOrigin` before dispatch. The same
visible plugin clear-all handler resets local indexes, document and query caches,
and shared cache files; reset waits for active work. The normal production lexical
and semantic rebuild, Lente and Filo retrieval, related-note checks, publication,
and Check then run. Obsidian settings, plugin installation, and vault registration
remain in place. Only embedding requests use a loopback mock.

Run the single benchmark command:

```sh
npm run benchmark
```

The benchmark uses the normal production plugin runtime and does not run chat
requests or an alternate runtime. The CLI evaluation calls the registered palette
command and requires a synchronous invoked/running receipt; Obsidian's internal
command-manager API is not available through this CLI. The compact correctness
report is `trama-simple-benchmark-report-v1`. Production diagnostic streaming
capture is the completeness authority, bounded to 10,000 records and 8 MiB, and
is saved as raw JSONL. The `dev:console` log is a supporting tail, not a complete
start-to-finish stream. Each artifact pair is saved as
`.artifacts/benchmarks/trama-simple-<runId>.performance.jsonl` and
`.artifacts/benchmarks/trama-simple-<runId>.console.log`.

Two consecutive normal runs passed all 12 gates:
`e6a84c53-9ce0-4c6b-afa5-c88e51d544a0` and
`4c5357ca-7981-47ae-b0ad-a06f2b1336e6`. Each captured 2,684 raw timing records:
adoption 4, semantic 1,914, lexical 753, publication 2, retrieval 8, and related
notes 3. Cache publication checks actual non-empty bytes up to 4 MiB, then verifies
stable inventory and generations after a normal warning-free Check. Interpret these
as correctness evidence; do not sum operation or phase durations into wall time or
claim speed or mobile results. See the [Obsidian benchmark guide](docs/obsidian-benchmark.md).
Do not run `npm run dev`; Obsidian loads the production `main.js`. Current
limitations include the cost of exact SQLite vector scans and maintaining FTS5 on large
corpora. Hybrid retrieval uses reciprocal-rank fusion (RRF) over exact semantic and
lexical candidates; there is no ANN/HNSW backend.
Semantic blocks use a 384-character serialized-input cap with zero overlap; changing
segmentation requires a semantic refresh and relevance evaluation. Filo and Voce use native (rather than React) UI. Trama is an independent,
clean-break plugin with no compatibility guarantees for other plugins or earlier identities.

## Mobile and shared cache checklist

The mobile lifecycle and packaged asset URLs are covered by automated tests, but actual
iOS WebView, OPFS, SQLite-Vector, LAN inference, and provider delivery still require
manual validation. Before relying on a synchronized vault, check the following:

- On a clean iOS install, load the plugin, confirm Worker/WASM/SQLite-Vector/OPFS startup,
  and verify there are no startup network requests.
- Offline, build a lexical index, restart Obsidian, and confirm keyword Lente search still
  works without a publication or embedding provider.
- On desktop and mobile, verify Obsidian Sync or iCloud delivers standalone cache shards;
  record transfer size, timing, temporary storage, and observed memory pressure.
- Verify first receipt validates and merges compatible vectors, duplicate delivery is
  harmless, incompatible profiles remain isolated, and local note visibility stays
  controlled by current Markdown. Test offline lexical search, a cached query-vector hit,
  query-provider failure fallback, and related-note search from the last complete head.
- After provider convergence, test bidirectional contribution delivery, delayed or
  duplicate shards, interruption recovery, deletion/exclusion without resurrection,
  and sequential device use.

These real-device, Obsidian Sync/iCloud, LAN, publication-size, and two-device conflict
checks are pending user validation; automated tests do not claim them as successful.

See [SQLite cache details](docs/sqlite-snapshots.md) for shard validation, merge,
retention, compaction, and recovery behavior.
