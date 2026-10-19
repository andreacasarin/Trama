# ADR: Embedding cache, vault sharing, and explicit clearing

- Status: Accepted (extracted from the note-index ADR; no new decision)
- Recorded: 2026-10-19
- Related: [LangChain and SQLite note index](langchain-sqlite-note-index.md)

## Context

Repeated inputs should reuse embeddings locally and across devices, including devices whose LM Studio endpoints have different addresses. The shared artifacts must exclude note text, paths, chat, and query history. SQLite and LangChain should own as much of the work as possible.

## Decision

### Cache identity and ownership

Use LangChain `CacheBackedEmbeddings` and `EncoderBackedStore` with a local SQLite store for document embeddings. Keep the minimal custom `SqliteEmbeddingCache.embedQuery` extension for query caching. Cache identity uses exact input, task, trimmed model ID, and dimensions; exclude the endpoint. Equal model IDs and dimensions are assumed to imply equal weights across endpoints; Trama does not verify this assumption. The separate endpoint-sensitive `noteEmbeddingProfile` still governs index invalidation.

Query vectors remain local, with a 1,000-entry limit per model/dimension profile and 30-day expiry. Document entries survive Rebuild. Local values win deduplication. Model or dimension changes select a separate cache profile; old profiles remain reusable if settings switch back. No settings change automatically clears data.

### Document-only SQLite shards

Share immutable document-only files at `Trama/embedding-cache-v2/<profileSHA>/<artifactSHA>.sqlite3`. Each file contains hashed Float32 vectors and profile/dimension/task metadata, no input text, endpoint, or query vectors. Validate checksums, SQLite schema and integrity, metadata, dimensions, and finite vectors before importing. Ignore old JSON artifacts and receipts without migrating or deleting them.

Use native SQL to select and copy entries into file-backed scratch databases, `VACUUM INTO` to create compact shards, and the SQLite VFS pool for export/import. Bound each shard to 128 entries and less than 4 MiB. Import into the device-local cache and record receipts transactionally; record publication hashes with a bounded native `INSERT ... SELECT`. Keep cancellation checks between SQL steps and before commit.

Import compatible shards before manual or eligible automatic indexing. Publish after indexing and full cleanup succeed. Failed or cancelled indexing publishes nothing. File installation and SQL receipts are separate steps; multi-file publication is not atomic. A sharing failure or cancellation may leave completed immutable files and reports “Index updated; sharing incomplete/cancelled.” A later eligible automatic run or manual Update retries outstanding work, without an immediate failure retry loop.

The user's vault-sync transport carries these files; never share the mutable local index. Obsidian Sync requires “Sync all other types” on each device. There is no separate startup uploader, third-party cache service, custom transport, or credential sharing. A device with the same model ID and dimensions can rebuild from complete cache hits without a working provider; a cache miss still requires the provider. No provider-health preflight is added.

### Rebuild and explicit Clear

Ordinary reset and Rebuild clear indexed state and RecordManager state while retaining document/query caches, receipts, and shared files. **Clear index and embedding cache** additionally clears all local document/query profiles, import/publication receipts, and known managed SQLite artifacts and temporary files under the shared cache root across profiles. It needs no configured model.

Clear leaves notes, settings, vault identity, the OPFS namespace, unrelated files, and other devices' local caches intact. Shared-file deletion follows vault sync and cannot guarantee deletion on every device. Cancel pending searches and reset submitted Lente results before clearing, so existing requests cannot repopulate the deleted cache and Clear does not replay a query.

The SQL clear commits or rolls back before shared-file removal starts. Cancellation before commit preserves prior local state. Failure or cancellation afterward reports local clearing with shared cleanup incomplete, leaves automatic indexing paused, and permits retrying Clear. Cross-store clearing is not atomic.

## Rationale

LangChain's document cache removes custom cache policy; SQLite shards avoid serializing every vector through JavaScript. Endpoint-independent identity permits cross-device reuse. Keeping query vectors local prevents vault sync from publishing query history. Immutable bounded files and transactional receipts make retries idempotent without sharing a live index. Explicit Clear keeps destructive maintenance under user control.

## Consequences

Embedding hashes and vectors remain derived data; absence of raw text is not a claim of anonymity. Incorrect model equivalence can reuse incompatible vectors, so users must configure matching weights. Sync configuration and delivery remain external dependencies. Completed files can survive interrupted publication; other devices can retain local copies after Clear.

## Evidence and reconsideration

See the dated cache, production OPFS, and receipt-batching experiments in the [performance assessment](../../docs/langchain-performance-assessment.md). Those workload-specific results do not measure actual vault-sync latency. Reconsider the format, retention, or equivalence assumption when requirements or representative evidence change, preserving document-only sharing and explicit clearing.
