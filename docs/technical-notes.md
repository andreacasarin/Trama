# Trama technical notes

[← Back to the README](../README.md)

For setup and a feature overview, start with the [README](../README.md#get-started).
This reference covers storage, maintenance, and the details behind Voce's behavior.

## Storage and retrieval

Trama uses LangChain for embeddings, indexing lifecycle, agents, and tools, with
LangGraph owning the active conversation's in-memory checkpoints. Note passage
preparation uses LangChain's recursive character splitter, with a small adapter
for UTF-8 byte sizing and source-position mapping.

Each vault has a stable identity in
`<storage-folder>/identity.json`; the storage folder defaults to `.trama` and
can be changed in Settings. Its SQLite database lives in that identity's local
OPFS namespace. Copying the identity file also copies the namespace identity; it
does not copy the database itself. Changing the storage folder selects its
identity and OPFS namespace without moving or migrating files from the previous
folder.

SQLite stores note metadata, passage vectors with source positions, lexical
search data, and normalized note centroids. It performs filtering, ranking, and
vector scoring. Vectors are normalized on ingestion, and the native dot product
implements cosine similarity. Filo compares the stored note centroid, so opening
a note does not trigger an embedding request. Its **Similarity** rating is
approximate and model-dependent. Vector search is exact; approximate search is
deferred.

### Passage and metadata indexing

Trama uses Obsidian's frontmatter boundary to exclude the entire YAML block from
semantic passages, including recognized malformed frontmatter. The note basename
is indexed as its title; Obsidian-parsed aliases and frontmatter tags remain
searchable metadata. The original Markdown, including frontmatter text, remains
in lexical search.

Passages use LangChain's `RecursiveCharacterTextSplitter` 1.0.2 with recursive
paragraph, newline, and space separators, `keepSeparator: true`, a 1,000-byte
target, and no overlap. A code-point-safe adapter handles the empty-separator
fallback, and a monotonic mapping preserves half-open UTF-16 offsets into the
original Markdown. The splitter identity is
`body-recursive-utf8-1000-codepoint-v1` and is part of both the note embedding
profile and cache identity. Whitespace between passages may be trimmed or omitted; all
non-whitespace source text is covered exactly once. Passage metadata does not
include parsed Markdown structure: `sectionPath` is empty and
`sectionStartOffset` is null. These fields do not promise heading-aware sections,
breadcrumbs, or a Markdown syntax tree.

The 1,000 UTF-8 byte limit is the conservative input bound used across compatible
providers. With the standard `cl100k_base` encoding, it bounds ordinary passage
inputs to at most 1,000 tokens. The configured OpenAI batch size is 256, so the
combined conservative bound is 256,000 tokens per request, below 300,000 and the
8,191-token per-input limit. These are byte-derived bounds, not automatic native
SDK token-budget enforcement or guarantees for arbitrary local tokenizers,
provider prefixes, or server-side truncation. Other compatible servers use the
same byte limit without a context-window claim. Smaller batches can increase
request count and do not necessarily improve indexing speed.

The original Markdown body, including frontmatter text, remains in the lexical
search field, together with path and structured metadata. Search keeps the
existing BM25 body/path ranking, maximum
passage semantic score, and reciprocal-rank fusion constant of 60. It does not
add a reranking stage.

The index does not persist raw Markdown bodies. Result lists use metadata without
reading note bodies; tool excerpts and full-note reads load current content from
the vault. Search falls back to lexical results when semantic retrieval cannot
run and reports the degraded state.

Voce model-facing note search is exposed through a thin native LangChain retriever
that delegates once to the existing SQL retrieval path. SQL filtering, ranking,
and scoring remain in SQLite; the retriever adds candidate document identity and
metadata without changing the public candidate envelope. Zero-result status and
cancellation signals are preserved. Live note hydration remains lazy, so evidence
freshness checks and Filo’s cached related-note path are unchanged. Native local
callback handling preserves tool-child parentage and agent stream summaries.

The new local structural trace events record fixed operation names and types, run
and parent IDs, operation outcome/status (success, failure, or cancellation),
duration, and counts. Status here describes the operation result, not retrieval
mode or degraded state. Those events omit query
text, paths, prompts, model configuration, tool arguments or results, raw errors,
and secrets. This describes the new trace events only; existing ConsoleDebug
logging is separate and may retain its existing fields. Trama supplies no tracing
credentials, clients, exporters, activation, or settings. With no externally
supplied tracing configuration there are no trace network requests. Host-supplied
LangSmith flags, exporters, or configuration remain effective and can cause
unauthenticated network attempts; absence of a key does not guarantee that upstream
tracing will not attempt a connection.

### Search and related-note evidence

Lente keeps its existing lexical body/path BM25, maximum-passage semantic score,
and reciprocal-rank fusion (RRF-60). Filo also keeps its existing ranking. Search
results retain the existing semantic score labels and thresholds. Keyword-only
Lente results retain the “Keyword match” label and title navigation, but do not
show an excerpt. A semantic Lente result can be expanded to show its actual
semantic winner passage as a plain block quote. The command-palette Lente picker
shows that semantic passage in its existing two-line quote when one is available.
Neither surface adds keyword highlighting or explanations of matched metadata
fields. Filo shows its related-note title and similarity label without an excerpt
or disclosure. Both views retain Obsidian title hover previews and ordinary title
opening, including modifier-key behavior.

Before showing a stored semantic quote, Trama verifies the source UID and profile
against the current index and checks the live note content. If the source is no
longer current, the quote is not shown. Quote text is noninteractive; title
opening remains the route to the full note. No exact-position navigation or
forced editor context is offered from excerpts.

These displays use the existing index and profile without an embedding-provider
call, schema or profile change, reindex, or embedding-cache rebuild. SQLite
retains the semantic winner and tie order. Lente's lexical BM25 retrieval and
metadata indexing remain unchanged.

## Index maintenance

Manual **Update index** and **Rebuild index** share the same indexing pipeline.
After the vault layout is ready, automatic updates run only when the local index
already contains notes and an embedding model is configured:

- Once on startup.
- After relevant Markdown changes, coalesced for about 20 seconds.
- Every five minutes to catch missed changes and shared cache arrivals.

A fresh, cleared, or empty index stays paused across restarts until a manual run
creates notes. One pending event is coalesced during a run and followed after
success. Failure, Stop, Clear, and unload do not trigger an immediate restart;
unload also cancels the pending debounce.

Persisted file revisions include modification time, creation time, and size.
Startup and file-event updates skip body reads for matching revisions. Manual
Update and the five-minute backstop reread content to catch changes whose metadata
did not change. Revisions are not remembered if the file changes during its read.
Changed content still goes through LangChain hashing and cleanup. The body-passage
preprocessing and splitter identity are part of both the note embedding profile
and embedding-cache identity. The new identity prevents stale passage cache
entries from being reused; the index needs a refresh/re-embedding under the
current profile. Matching passage embeddings can still be reused from
the current shared cache, while changed passage text needs new embeddings.
Metadata and source-position changes alone do not require new embeddings when
passage text is unchanged. Existing database fields remain compatible; no
destructive migration is needed. Until a note is refreshed, its existing lexical
entry remains available.

Notes enter LangChain in batches of up to 100. Embedding inputs are sent in
groups of up to 256 chunks. Each note commits atomically, and full cleanup runs only
after every input succeeds, including for an empty vault. Cancellation rolls back
the active transaction while retaining earlier completed commits. Failures skip
cleanup and leave previously indexed lexical data available. Changes during a run
are picked up by a later update.

User-configured folder exclusions apply to indexing a folder and its descendants
on the next successful update. They do not purge shared embedding files or
restrict chat attachments and note reads. Separately, the configured storage
folder and its descendants are excluded from indexing and vault-reading tools.
Filo refreshes after index updates without a provider call.

## Shared embedding cache

Updates import compatible document embeddings before indexing and publish them
after indexing and cleanup succeed. Files are immutable SQLite shards stored at:

```text
<storage-folder>/embeddings/<profileHash>/<contentHash>.sqlite3
```

They contain document vectors and cache metadata, never note text, queries, chat,
or attachments. Your ordinary vault sync service can carry them between devices;
each device maintains its own local index. Query embeddings remain local, with
up to 1,000 entries per profile for 30 days.

Cache keys use the trimmed model ID, dimensions, and a hash of the exact input.
Ordinary endpoint changes do not split the shared cache. Reuse therefore assumes
that matching model IDs and dimensions identify compatible vectors; Trama does
not verify the model weights. URLs containing userinfo, a query, or a fragment
add a SHA-256 endpoint fingerprint to distinguish those variants. Serialized
note profiles omit those raw URL components.

Invalid or unreadable shards are skipped. A cache-directory import failure does
not prevent local indexing. If indexing or cleanup fails or is cancelled, no
cache files are published. If publication is interrupted after indexing succeeds,
completed files remain and Trama reports sharing as incomplete or cancelled.
A later eligible automatic run or manual Update retries; there is no separate
startup uploader.

### Clear behavior

**Clear index and embedding cache** is available in Settings and the command
palette, without requiring a configured model. It clears:

- The local note index and document/query embedding caches.
- Local cache import and publication receipts.
- Known managed cache files, including temporary files, across profiles in the
  configured storage folder's `embeddings/` directory.

It preserves notes, settings, vault identity, the OPFS namespace, unrelated files,
and other devices' local caches. Rebuild and ordinary index reset retain caches.

The local SQL reset commits before shared-file removal starts. Cancellation before
commit preserves the prior local state; file removal afterwards is not atomic.
An interrupted cleanup reports that the local index was cleared but shared-cache
cleanup is incomplete. Automatic indexing stays paused and Clear can be retried.

Clear writes `.cleared` markers before deleting published shards. Other devices
use these to avoid restoring deliberately cleared files through automatic cache
reconciliation. A fresh publication can reuse a cleared checksum and remove its
marker. Deletion follows the vault's sync service and cannot guarantee that every
copy has disappeared from other devices, particularly during out-of-order sync.

## Models and settings

Chat and embedding endpoints are separate OpenAI-compatible base URLs, including
any provider-required prefix such as `/v1`. Chat uses the Responses API and tool
calling. URLs pass directly to the SDK: Trama does not apply application-level
host, IP, path, redirect, or origin filtering.

Loading settings does not call a provider. Chat and search requests follow user
actions; eligible automatic indexing can call the embedding provider on cache
misses. Trama requests disabled response storage from the provider; the server's
own data handling still depends on that provider.

### Chat tool contract

The chat endpoint must support `/responses`, streamed function-call arguments,
and function-call outputs. Support for `/chat/completions` alone is insufficient.
Trama sends native JSON Schema function definitions through LangChain, with
`strict: false` for servers without strict decoding. Optional arguments remain
optional, while local validation rejects unknown fields and invalid arguments.
The server is responsible for applying the loaded model's tool-aware chat
template and parsing its output into API function calls; Trama does not insert
model-specific tool markup into prompts.

The tools separate known-note reads (`read_notes`), outgoing-link discovery
(`discover_links`), and vault-wide discovery (`vault_search`). Their descriptions
and the system prompt specify when each applies and defer to the current request
and skill's source restrictions. Known paths and supplied links need no preliminary
search. These restrictions guide model behavior; they are not runtime access
controls derived from skill prose.

Executed vault tools return JSON strings: `{ "ok": true, "data": ... }` or
`{ "ok": false, "error": { "code": ..., "message": ..., "retryable": ... } }`.
A successful `read_notes` batch can contain per-note errors in `data.results`;
callers must inspect each entry. Provenance artifacts remain local. Every tool
result is paired with its function call ID, including failures and parallel
calls. Link discovery does not read target notes, and search excerpts do not
count as full-note reads. Invalid arguments and unknown tools are rejected by
the native agent before the vault operation and returned as error tool messages
so the model can correct its call.

Provider-boundary regression tests check serialized schemas, optional arguments,
fragmented streaming arguments, call/result pairing across parallel rounds,
Unicode links, partial and complete tool failures, and recovery from invalid
arguments and unknown tools. These tests use synthetic
responses; they do not establish instruction-following quality for a particular
model or verify a server's chat template.

Settings are grouped under Voce (chat), Filo (shared embeddings and exclusions),
and Maintenance (Update, Rebuild, Stop, Clear, and Console debugging). Each model
selector has a Discover control; selecting a model saves it. Reasoning effort
offers Auto, None, Minimal, Low, Medium, High, and XHigh.

Settings save automatically, with one confirmation case: a local change to the
effective embedding endpoint, model, or dimensions while an index exists or
indexing is active. Cancel preserves settings and indexed data without stopping
an active run. Save changes saves the settings and recommends Clear followed by
manual Update/Rebuild. First configuration, an idle empty index, chat-only
changes, and equivalent effective embedding settings do not prompt. Externally
synced settings are retained with nonblocking advice instead.

All settings are stored in the plugin's `data.json`, follow Obsidian Sync's
plugin-settings sync when enabled, and reload after external changes.
Changes to chat or embedding settings reconfigure services and reset the active
Voce conversation. Applying a storage-folder change, including one received through
external settings sync, reconfigures storage to use that folder’s identity and
OPFS namespace.

Console debugging is off by default. When enabled, it records operation timings,
counts, and caught errors locally. Startup timing records use the `Startup <phase>`
label and an integer `elapsedMs`: settings, namespace, worker-ready,
index-presence, service-compose, services, ui, onload, layout-ready, and
first-chat. Startup spans use wall-clock time across awaited work, not CPU or
main-thread profiling. The services span contains service-compose; phase values
may overlap and must not be added. The layout-ready value is elapsed from the
start of onload. The first-chat phase appears when Voce first opens and constructs
the shared chat session. Enabling Console Debug before reloading captures startup
phases; see the [startup timing procedure](obsidian-benchmark.md#startup-phase-timings).

Voce diagnostics report turn/tool status, durations, tool names and ordinals, and
anonymous read counts; they omit prompts, arguments, note paths and bodies, raw
tool JSON, secrets, and raw errors. When disabled, Trama emits no console
diagnostics, including errors. The timing labels do not measure module parsing
before onload or establish main-thread blocking. When enabled, the worker reports
six initialization phases after its first successful initialization: the combined
WASM load/compile span, SQLite bootstrap, OPFS pool install, OPFS capacity reserve,
database open, and schema setup. The combined WASM span runs from before embedded WASM byte
materialization through compile settlement. Its two child timings cover materializing the embedded WASM bytes through the
bundled lazy initializer and `WebAssembly.compile`; the compile child overlaps
SQLite glue import. SQLite bootstrap combines glue import with SQLite initialization, excludes the wait for
compile settlement, and can overlap that compile. These overlapping spans are not
additive. SQLite initialization waits until both WASM compilation and SQLite glue
import have settled. The load timing includes generated byte materialization, whose internal cost is
not isolated. The timings travel in the init response, are not persisted, and later
initialize calls do not replay them; they describe the existing overlapped load and
initialization sequence. See the [startup timing procedure](obsidian-benchmark.md#startup-phase-timings).
Cache imports emit debug-only aggregate timings and work counts. If the profile
folder is absent, import checks once, skips listing, reconciles an empty inventory,
and does not create it; publication creates folders as needed. See the
[cache import diagnostics](obsidian-benchmark.md#embedding-cache-import-diagnostics)
for field definitions and limits.

## Voce skills

A skill is a readable Markdown note with explicit frontmatter:

```markdown
---
trama-voce-skill: true
trama-voce-command: weekly-review
trama-voce-description: Find themes and open questions in my weekly notes.
---

Read the notes I attach. Identify recurring themes, unfinished decisions,
and one useful question for the coming week. Cite the notes behind your answer.
```

Type `/` at the start of the composer or after whitespace and choose the skill.
Commands use lowercase letters, numbers, and hyphens; filenames do not supply
commands. The optional description appears in the picker and is searchable.
Only one skill can be invoked per turn.

For example:

```text
/weekly-review [[Journal/This week]]
```

At send time, Voce rereads the skill, validates its marker and command, and uses
its current body without frontmatter as instructions for that request. Missing,
invalid, duplicate, changed, inaccessible, or empty skills preserve the draft and
prevent the model call. Editing the draft, closing Voce, or rebinding its session
cancels an in-progress skill read.

Skill content is used as written. Placeholders such as `{activeNote}` and `{#tag}`
are not substituted, and links inside a skill do not automatically attach notes.
Add the required notes explicitly. A skill can direct the agent to inspect links
and read notes, within the skill's source, depth, and retrieval limits. This guides
the agent without guaranteeing a particular tool call or an exhaustive review.

## Conversation and context

Voce keeps conversation checkpoints in memory for the active session, without
saving them to disk. New chat stops active work and clears the conversation,
draft, attachments, and expanded-turn state. Closing the last Voce pane resets
the session too. Attachments and selected skill content apply to the current
provider turn and do not become persistent sources.

Edit loads a user prompt and its attachments into the composer while leaving
history intact. Sending the revision replaces that prompt and later messages,
restoring model context to before the edited turn. Cancel edit clears the edit
draft without changing history. Stop or finish the current response before editing.

The composer uses plain Markdown text. `[[` opens note suggestions, `/` opens
skill suggestions, and `@` or the plus button opens the note picker. Escape
closes suggestions without changing the draft. Enter sends when suggestions are
closed; Shift+Enter inserts a newline. Pasted content stays plain text.

Sources start collapsed. The latest response starts expanded, while older long
responses collapse; Show more/Show less overrides those choices. Copy, Edit,
and local message times appear on hover or keyboard focus. A provider-returned
reasoning summary, when available, appears separately above the answer; Trama
does not add a summary request field manually to prompts.

**Context window tokens** defaults to 4,096: an approximate usable request budget
including reserved output space. It does not change the provider's context limit
or a local model server's memory allocation. Trama supplies the full current
request, selected skill, and attachments. Before provider calls, it counts tools,
skill, attachments, and the retrieval ledger against the budget.

LangGraph summarizes older history as the budget fills, retaining recent working
context. Trama subtracts current request context and the retrieval ledger from
the summarizer allowance. Voce shows “Condensing earlier conversation…” during
summarization and confirms when the summary was used. The visible transcript
stays unchanged; the generated summary is not displayed. Failed or cancelled
unfinished compaction clears the running status; a successful compaction stays
disclosed even if a later step fails.

If the assembled request cannot fit, Trama stops with an actionable limit message
instead of silently clipping content. Provider context errors are reported
separately. Long runs can also reach LangGraph's default recursion limit,
currently 25 graph steps. This counts agent steps, not notes or tool calls.
Limit failures mark the turn incomplete, preserve partial answers and provenance,
and retain the last completed conversation context. Cancellation remains available.

## Read-only vault tools

| Tool             | Purpose                                             | Limits                                                                                                                                          |
| ---------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault_search`   | Ranked notes with excerpts and canonical paths.     | Default 10 results; up to 1,000. Query up to 4,096 characters. Excerpts up to 1,000 characters; serialized search data up to 12,000 characters. |
| `discover_links` | Outgoing frontmatter links, body links, and embeds. | Default 25 links; up to 1,000. Uses Obsidian's metadata cache.                                                                                  |
| `read_notes`     | Full content for selected notes.                    | 1–100 paths per call, with up to four concurrent reads.                                                                                         |

Paths are limited to 4,096 characters. `read_notes` accepts exact vault-relative
`.md` paths, unique visible titles, or complete `[[wikilinks]]`. Optional
`sourcePath` resolves titles and wrapped links relative to that note. Canonical
`.md` paths are always read exactly, including root-level paths. Order and
duplicates are preserved; unreadable entries return individual errors without
discarding successful reads. Contextual links carry source-link and target-note
provenance, while exact paths carry target-note provenance.

Search's `candidateCount` describes the ranked SQL candidate pool;
`hydratedCount` counts successful live-note reads attempted, including a preview
that did not fit; `returnedCount` counts included previews; and `omittedCount` is
candidate pool size minus returned previews. Each excerpt has a `contextTruncated`
flag. Hydration skips missing notes and stops when the next preview would exceed
the serialized output cap. Provenance covers included results. Link discovery
probes one extra link when possible to report truncation.

Attachments and full note reads have no fixed character cap, and attachments
have no fixed count cap. Batching reduces tool-call rounds, not content or token
use; a large batch can still exceed context limits. Cancellation stops later
read chunks without reporting a partial batch as completed.

The user message and selected skill supply instructions. Attached and retrieved
notes are untrusted evidence. Voce does not crawl unrelated branches or activate
linked skills. The skill appears as a separate Skill source; attachments and
successfully read notes appear under Sources. Discovering a link alone does not
add a source. Sources deduplicate by note and range, rather than by call count.

Successful reads contribute turn-local progress containing paths, read counts,
and available ranges or truncation details, without note bodies. Batch progress
is recorded after the call returns, including successful entries alongside
per-note errors. This ledger is reattached to provider-request copies after
summarization and stays outside checkpointed history. Search snippets and link
discovery alone do not count as full reads; successful reads do not prove the
model fully assessed the material.

## Build, packaging, and architecture

Development uses Node.js 24 and Docker for the pinned SQLite/WASM build. `npm test`
builds the production assets, verifies SQLite, type-checks, and runs the tests.
CI also checks formatting, lint, versions, license metadata, and production and
development dependency advisories. Build identities hash source and locked inputs
deterministically.

The build bundles the worker, SQLite's JavaScript module, and its WASM bytes into
`main.js`. Sources remain separate; `.cache/sqlite.worker.js` is a generated
intermediate. At runtime a module worker starts from a Blob URL, with no sidecar
file reads or runtime downloads. Worker termination releases that URL. The SQL
queue, cancellation protocol, and OPFS namespace are unchanged.

Release archives contain `main.js`, `manifest.json`, `styles.css`, `LICENSE`, and
`THIRD-PARTY-NOTICES.txt`. GitHub releases also attach `main.js`, `manifest.json`,
and `styles.css` individually for the community installer. The full project license
and third-party notices are embedded in `main.js` too, so standard installation
retains them. The local installer builds and validates that same ZIP under
`.artifacts/releases/`, installs its entries, and verifies the installed bytes.
It removes the former managed runtime sidecars and installer receipt, preserves
notes, settings, local index data, and unrelated files, and does not back up or swap directories. If an
installation is interrupted, rerun it before loading the plugin.

For a safe development walkthrough, use the [generated demo vault](demo-vault.md).
For repeated timing measurements, use the [Obsidian benchmark guide](obsidian-benchmark.md).
Historical ADR measurements describe their workloads and are not performance guarantees.

Accepted decisions:

- [LangChain and SQLite note index](../.ai/adrs/langchain-sqlite-note-index.md)
- [Embedding cache sharing and Clear](../.ai/adrs/embedding-cache-sharing-and-clear.md)
- [SQLite storage layout](../.ai/adrs/sqlite-table-storage-layout.md)
- [Automatic index maintenance](../.ai/adrs/automatic-index-maintenance.md)
- [Test boundaries and native validation](../.ai/adrs/testing-boundaries-and-native-validation.md)

Trama is MIT licensed. SQLite is public domain; native vector helpers use Trama's
MIT license. Other components retain their own terms, with applicable notices
included in releases. See the [dependency inventory](../vendor/sqlite-wasm/LICENSES.md).
