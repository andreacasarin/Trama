# Shared embedding cache shards

> **Historical design:** This document records a retired shared-cache design. V1 has no shared cache or publication path. See [the current implementation](langchain-sqlite-implementation.md) for approved behavior.

Each vault maintains its own local lexical index and semantic note heads. Shared
files carry reusable computed vectors only; they do not carry FTS data, note heads,
paths, or local IDs. Markdown in the current vault remains authoritative for which
notes can appear in search.

## Local indexes and compatibility

The local SQLite/WASM index keeps one full-note FTS entry for each visible note,
with body, path, filename, title, and heading weights of 1, 2, 3, 3, and 0.5;
headings are not counted twice. Lexical search works without an embedding provider.
Semantic input uses LangChain's default Markdown splitter. Each split's raw
Markdown text, including headings and frontmatter, is used for embeddings. While
changed inputs are prepared, the last complete compatible semantic head remains
searchable. Voce and Lente invoke indexed SQLite search through a shared
LangChain `RunnableLambda`, which returns Documents with status and degradation
context. SQLite/WASM continues to perform vector scoring, candidate ranking,
and reciprocal-rank fusion.

Frontmatter is retained in semantic embedding text and full-note lexical search.

A vault uses one active embedding model/version, dimensions, and preprocessing
identity. Model identifiers must identify the same version on all devices; endpoint
addresses are transport settings and do not change that identity. Query and document
tasks remain distinct, and vectors are reusable only for exact compatible inputs.
Changing model identity disables semantic retrieval and prompts an explicit rebuild;
lexical search stays available. A model-change rebuild atomically drops all local
semantic heads, document and query cache entries, and cache import/retirement bookkeeping,
then recalculates with the configured model. Recalculation is intentional; the rebuild
does not include a special shared-cache recovery step. Ordinary subsequent cache imports
and updates can reuse compatible entries. The rebuild deletes shared cache shards before switching the local model; a deletion failure leaves the model change pending for retry.
Late-arriving other-model shards are ignored during both import and compaction.
Incompatible prior local schemas reset and rebuild without migration.

The shared `EmbeddingResolver` uses SQLite cache lookup before provider calls.
Semantic preparation selects unique document misses across notes in SQL, filling
bounded provider batches by item and byte limits; cached passages consume no provider
batch slots. Query misses dispatch immediately, while cached queries work offline.
With no provider configured, the saved vault model can still use its cache.

Startup and synchronization import cache entries only: they never promote semantic
heads or call a provider as part of import. Imported entries make work eligible for
ordinary automatic maintenance when enabled; otherwise the next manual update uses
them. Automatic startup reconciliation still checks local Markdown. A providerless
device promotes complete cache hits during ordinary local indexing. A provider
failure preserves semantic backlog and retries after a one-minute delay; lexical
changes remain usable. Manual maintenance commands supersede active cancellable work
and queued commands. SQLite transactions and file installation finish their current
atomic step before yielding. Filo refreshes related notes after maintenance settles.
Stop during reset also cancels its follow-up cache import. Edits arriving during a
failed embedding request retain normal lexical scheduling instead of waiting for
the provider retry.

Vector dot products, candidate ranking, related-note reranking, and reciprocal-rank
fusion run inside SQLite/WASM. JavaScript prepares bounded query inputs and maps
final rows; it does not scan corpus vectors.
Dot products delegate to SQLite-Vector's maintained Float32 distance routine through
an SQL adapter, including bounded passage pairs. This avoids full cache scans and
connection-scoped dimension registration; model changes can rebuild on the same
connection. UTF-16 path ordering resolves deterministic ties. A maintained passage FTS index selects lexical excerpts using each note's own
BM25 statistics. Token counts are stored during lexical writes, and phrase document
frequencies are shared across the excerpt query instead of rebuilding FTS per note.

Related retrieval materializes source vectors once. Candidate discovery scans the
corpus for each distinct source passage, retaining up to 32 distinct candidate notes
per source passage and trimming the bounded pool to 128 after each source passage.
It groups each note's passage vectors in a streaming per-note query and removes
duplicate embedding inputs by digest without building a corpus-wide sorter. Candidate
note vectors are loaded into SQLite scratch tables for reranking. The
rerank compares every distinct indexed source passage against compatible target
passages in batches of 16 by 128. Its experimental score and endpoint rules are
described below. Scratch storage retains bounded per-passage
evidence summaries between batches rather than a corpus of vectors. Performance
diagnostics distinguish `sourcePassages`, `relatedCandidates`, and `relatedRerank`.
When the last consumer cancels a related request, its Worker request yields and checks
cancellation between SQL batches using an eight-millisecond yield budget; an
individual SQL step finishes before yielding. Remaining consumers share the work.
Scratch tables are removed on completion, cancellation, and error. Schema 16 adds the
maintained passage index; earlier disposable local schemas reset and rebuild using
ordinary shared-cache import and maintenance. Shared embedding shards do not change.

Duplicate shard imports still validate SHA but
skip profile reconciliation and unchanged local-state scans in both the Worker and
the plugin. Profile reconciliation after a new shard updates profile selection
without computing a discarded full corpus status. Semantic preparation is a separate
maintenance operation; cache checks only display import activity.

## Publish and receive

Cache contributions are immutable, standalone SQLite databases with a maximum final
export size of 4 MiB per shard. After candidate writes finish and the database is
quiescent, maintenance compacts it with `VACUUM` and exports bytes through the VFS.
`VACUUM INTO` is not assumed. Oversized output is split by rebuilding smaller
standalone databases; SQLite files are never divided into byte ranges. No full corpus
is materialized in memory.

Each shard is hashed with SHA-256, staged, read back, and byte-checked before atomic
rename into the shared publication area. The publisher does not reimport its own
export. On first receipt, Trama verifies the named SHA-256 and validates the shard schema, profile, keys, dimensions,
and finite vector values before merging. It records receipt atomically
with the conflict-safe merge. A repeated artifact digest skips file reading and merge through batched SQLite receipt lookup; vector keys
also deduplicate across different shard digests. Incoming data adds reusable vectors
and never replaces compatible local entries or current note visibility.

Only the current local database schema and cache-shard format are supported.
An incompatible disposable local index is reset and rebuilt; there is no migration
or whole-database import/publication workflow.

## Retention and recovery

Document vectors become eligible for shared-cache pruning only after 30 days of local
observation that an input is unreferenced by current notes, old semantic heads, and
active, pending, or in-flight work. An offline device's absence does not prove global
obsolescence. Pruning shared cache never deletes local index state. Query vectors use
a separate task identity and expire 30 days after calculation, with at most the 1,000
most recent per profile; receipt does not renew that age. A local cached query vector
can support offline semantic search. On a cache miss, Lente requests a query embedding
when a provider is available and falls back to lexical search if it is not.

When dirty, weekly compaction captures at most 16 MiB and runs if at least eight
eligible files are each no larger than 1 MiB, or if files contain eligible expired
rows. It emits standalone shards no larger than 4 MiB. All replacements are made
durable before the exact captured source files are retired after a separate 30-day
grace period. Uncaptured files that arrive during compaction are left alone. If a
source or replacement is already in that grace window, later compaction leaves it
alone and retains its original retirement deadline. Membership records preserve the
identity of dirty shards after their expired local vectors have been deleted. If a
contribution file disappears, repair republishes only still-needed active,
last-complete, pending, or in-flight document vectors and fresh query vectors.

**Reset local search data** preserves shared embeddings and imports them again
before rebuilding local heads. **Clear local search data and shared embeddings**
clears both local search data and shared contributions. Both actions preserve notes
and settings. The benchmark uses its generated-vault reset for a fresh fixture run.

## Retrieval behavior

Lente ranks at most 80 lexical notes and 80 semantic notes, then combines ranks with
reciprocal-rank fusion using k=60. The semantic query is one source passage. Related
scoring uses every distinct indexed source passage against each retained candidate's
compatible target passages. In both cases the shared experimental score is 0.75
times the strongest compatible passage-pair cosine plus 0.25 times the maximum of
zero and the strongest distinct compatible corroborating pair. When a side has at
least two distinct embedding inputs, its corroborating pair must use a different
endpoint from the anchor; a singleton side may reuse its only endpoint. If both
sides are singletons, there is no corroborator. Embedding-input duplicates within a
note count once. The winning target passage is retained as evidence. Related
candidate discovery compares every distinct indexed source passage against the
corpus, retaining up to 32 distinct notes per source passage and trimming the pool
to 128 after each source passage. Candidate discovery can miss notes whose
aggregate evidence would rank highly; reranking has quadratic comparison cost and
no bounded interactive-latency guarantee. This unaccepted experiment does not
establish relevance quality or mobile performance.

## Validation still required

Real-device indexing and query latency, provider compatibility guarantees, and
Obsidian Sync/iCloud delivery, conflict, file-type, storage, and recovery behavior
require their own validation. Desktop benchmark timings do not establish iPhone
performance. The current generated-vault benchmark measures 3,000 notes of roughly
400 characters each; it is not 10,000-note or device-performance proof.
