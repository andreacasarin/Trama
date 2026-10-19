# ADR: LangChain and SQLite note index

- Status: Accepted
- Date: 2026-10-09
- Updated: 2026-10-19

## Context

The proof of concept prioritizes reducing owned code through LangChain primitives while retaining SQLite computation and Obsidian integration. It is a pre-release rewrite: preserving old APIs, schemas, ranking, settings, caches, or test goldens is not a requirement.

## Decision

### Native indexing and SQL retrieval

Use LangChain's vector-store interface, default Markdown splitter, native `index()` lifecycle, and a SQLite RecordManager. LangChain owns content/metadata hashing, record UIDs, unchanged-note skipping, record refresh, and stale cleanup. Do not retain a parallel custom source-hash, reread, or prune lifecycle, migration, or compatibility layer. Compatibility covers the Obsidian adapters only.

SQLite owns filtering, grouping, deduplication, ranking, and native vector scoring. Store note identity/path, embedding profile, chunk vectors, normalized note centroids, and contentless FTS data without raw Markdown bodies. Hydrate winning notes from the live vault. Hybrid search fuses body/path BM25 and maximum-chunk semantic ranking with reciprocal-rank fusion, using rank constant 60. Related-note lookup uses normalized centroids without provider access. LangChain defaults and these ranking values are approved V1 defaults; no separate tuning rationale was supplied.

The controller reserves a RecordManager run watermark, submits windows of up to 100 notes with cleanup disabled and `sourceIdKey: "path"`, then calls `index()` with an empty source and full cleanup after every input succeeds, including an empty vault. The adapter combines embeddings across notes into batches of up to 512 chunks; oversized notes use bounded batches too. Path and embedding profile are indexed metadata and affect the native hash.

Register each prepared note's UID, path, and logical-clock tick in the same SQLite transaction as its FTS and vectors. Timestamps must be strictly later than the reserved watermark; cleanup selects older records in stable UID pages of up to 1,000. Existence checks match the current note UID, and UID-guarded deletion cannot delete a newer note at the same path. A failed run stops and skips cleanup, retaining earlier committed notes and existing lexical data. Do not rewrite a failed note as lexical-only. Note changes during a run are picked up by a later successful update. Query-time semantic failure can fall back to lexical search.

### Vault and worker isolation

Each vault receives a version-1 random 32-byte token, encoded as 64 hexadecimal characters in `.trama/note-v1/identity.json`. It selects the isolated OPFS database `trama-note-v2-<token>/notes.sqlite3`; copying the identity also copies the namespace. There is no shared-storage fallback.

Initialize the worker before publishing services or UI. Process SQL requests in FIFO order, handle cancellation messages outside that queue, and yield between bounded SQL steps and before commit. Cancellation rolls back the active transaction while retaining earlier note commits. Closing aborts active work, waits for rollback, closes the database, and pauses the VFS non-destructively. Settings changes await close before reopening; each index instance owns its callbacks.

Serialize plugin loading, settings persistence, and reconfiguration through one promise chain. Resolve current services for UI consumers after reconfiguration. Check disposal after awaits and close a candidate created during unload. External settings changes reload normalized `data.json`, apply runtime changes, and invalidate stale settings drafts. Closing the settings form preserves pending valid text edits and accepted confirmations; external replacement still invalidates them.

### Agent and privacy boundaries

Use a native LangChain agent, Zod-validated read-only tools, native call limits, message text, and the experimental v3 event stream for this proof of concept. Keep session history ephemeral. Inject bounded turn attachments through `wrapModelCall` into copied user messages only for provider requests; agent input and stored history retain raw messages. Attachments remain available across tool calls in the same turn and cannot carry into later turns, including after failure or cancellation. Attached content is untrusted reference data.

Use the OpenAI-compatible Responses API with plain-text `text.format`, `store: false`, and non-strict tool calling. Guard private endpoints. Settings loading is offline; chat and search follow explicit actions, while eligible automatic indexing may call the embedding provider on cache misses. Each indexing or query embedding request uses a fresh `OpenAIEmbeddings` instance and abort signal so concurrent work cancels independently. Related-note scoring never calls a provider.

## Rationale

Native indexing removes owned lifecycle policy. The atomic note/record write closes the write-before-record-update orphan gap without adding a second lifecycle. SQLite adapters preserve bounded corpus computation and avoid moving vectors to JavaScript. Omitting raw note bodies limits stored corpus content, while live-vault hydration keeps Markdown authoritative. Stable vault identity isolates local indexes across reloads. Native agent middleware avoids bespoke history cleanup while preserving attachment privacy.

## Consequences

This is a simplification, not a claim of equivalent ranking or semantic quality. Failed runs can retain partial prior commits until a later successful update. The experimental agent stream and live-provider behavior require device-level validation. Older architecture notes describing JavaScript centroids, legacy schedulers, migration machinery, or structural passage ranking are historical and do not override these decisions.

The following extracted ADRs retain the previously accepted decisions; this documentation split changes no runtime behavior:

- [Embedding cache, vault sharing, and explicit clearing](embedding-cache-sharing-and-clear.md).
- [SQLite table storage layout](sqlite-table-storage-layout.md).
- [Automatic indexing and settings changes](automatic-index-maintenance.md).

See the [implementation reference](../../docs/langchain-sqlite-implementation.md) for component locations and verification evidence.

## Reconsideration

Revisit native defaults and ranking with representative quality and performance evidence. Revisit the rewrite boundary if compatibility or migration becomes a product requirement. Preserve bounded SQL computation, vault isolation, and privacy boundaries.
