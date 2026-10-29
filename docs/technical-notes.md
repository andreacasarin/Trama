# Trama technical notes

[← Back to the README](../README.md)

For setup and a feature overview, start with the [README](../README.md#get-started).
This reference covers storage, maintenance, and the details behind Voce's behavior.

## Storage and retrieval

Trama uses LangChain for embeddings, Markdown splitting, agents, and tools, with
LangGraph owning the active conversation's in-memory checkpoints.

Each vault has a stable identity in `.trama/note-v1/identity.json`. Its SQLite
database lives in that identity's OPFS namespace. Copying the identity file also
copies the namespace identity; it does not copy the database itself.

SQLite stores note metadata, chunk vectors, lexical search data, and normalized
note centroids. It performs filtering, ranking, and vector scoring. Vectors are
normalized on ingestion, and the native dot product implements cosine similarity.
Filo compares note centroids; its **Similarity** rating is approximate and
model-dependent. Vector search is currently exact; approximate search is deferred.

The index does not persist raw Markdown bodies. Lexical search data still derives
from note content. Result lists use metadata without reading note bodies; tool
excerpts and full-note reads load current content from the vault. Search falls
back to lexical results when semantic retrieval cannot run and reports the
degraded state.

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
Changed content still goes through LangChain hashing and cleanup.

Notes enter LangChain in batches of up to 100. Embeddings are flushed in groups
of up to 512 chunks. Each note commits atomically, and full cleanup runs only
after every input succeeds, including for an empty vault. Cancellation rolls back
the active transaction while retaining earlier completed commits. Failures skip
cleanup and leave previously indexed lexical data available. Changes during a run
are picked up by a later update.

Folder exclusions apply to a folder and its descendants on the next successful
update. They do not purge shared embedding files or restrict chat attachments
and note reads. Filo refreshes after index updates without a provider call.

## Shared embedding cache

Updates import compatible document embeddings before indexing and publish them
after indexing and cleanup succeed. Files are immutable SQLite shards stored at:

```text
Trama/embedding-cache-v2/<profileHash>/<contentHash>.sqlite3
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
  vault's `Trama/embedding-cache-v2` folder.

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
Voce conversation.

Console debugging is off by default. When enabled, it records operation timings,
counts, and caught errors locally. Voce diagnostics report turn/tool status,
durations, tool names and ordinals, and anonymous read counts; they omit prompts,
arguments, note paths and bodies, raw tool JSON, secrets, and raw errors. When
disabled, Trama emits no console diagnostics, including errors.

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

Release archives contain exactly `main.js`, `sqlite-worker.mjs`, `sqlite3.mjs`,
`sqlite3.wasm`, `manifest.json`, `styles.css`, `LICENSE`, and
`THIRD-PARTY-NOTICES.txt`. The local installer copies those files, preserves
settings and unrelated files, and does not back up or swap directories. If an
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
