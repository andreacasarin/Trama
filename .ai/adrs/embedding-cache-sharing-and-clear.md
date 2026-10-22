# ADR: Embedding cache, vault sharing, and explicit clearing

- Status: Accepted (extracted from the note-index ADR; no new decision)
- Recorded: 2026-10-19
- Related: [LangChain and SQLite note index](langchain-sqlite-note-index.md)

## Context

Repeated inputs should reuse embeddings locally and across devices, including devices whose LM Studio endpoints have different addresses. The shared artifacts must exclude note text, paths, chat, and query history. SQLite and LangChain should own as much of the work as possible.

## Decision

### Cache identity and ownership

Use LangChain `CacheBackedEmbeddings` and `EncoderBackedStore` with a local SQLite store for document embeddings. Keep the minimal custom `SqliteEmbeddingCache.embedQuery` extension for query caching. Cache identity uses exact input, task, trimmed model ID, and dimensions. For ordinary URLs, endpoint details are excluded to allow cross-endpoint reuse. URLs containing userinfo, a query, or a fragment additionally use an opaque SHA-256 endpoint fingerprint to separate those variants; their raw components are omitted from the serialized note profile. Equal trimmed model IDs and dimensions are assumed to imply equal weights across ordinary endpoints; Trama does not verify this assumption. The fingerprint is a cache discriminator, not encryption or proof of model compatibility. The separate endpoint-sensitive `noteEmbeddingProfile` still governs index invalidation.

Query vectors remain local, with a 1,000-entry limit per model/dimension profile and 30-day expiry. Document entries survive Rebuild. Local values win deduplication. Model or dimension changes select a separate cache profile; old profiles remain reusable if settings switch back. No settings change automatically clears data.

### Document-only SQLite shards

Share immutable document-only files at `Trama/embedding-cache-v2/<profileSHA>/<artifactSHA>.sqlite3`. Each file contains hashed Float32 vectors and profile/dimension/task metadata, no input text, endpoint, or query vectors. Validate checksums, SQLite schema and integrity, metadata, dimensions, and finite vectors before importing. Ignore old JSON artifacts and receipts without migrating or deleting them.

Use native SQL to select and copy entries into file-backed scratch databases, `VACUUM INTO` to create compact shards, and the SQLite VFS pool for export/import. Bound each shard to 128 entries and less than 4 MiB. Import into the device-local cache and record receipts transactionally; record publication hashes with a bounded native `INSERT ... SELECT`. Keep cancellation checks between SQL steps and before commit.

Import compatible shards before manual or eligible automatic indexing. Publish after indexing and full cleanup succeed. Failed or cancelled indexing publishes nothing. File installation and SQL receipts are separate steps; multi-file publication is not atomic. A sharing failure or cancellation may leave completed immutable files and reports “Index updated; sharing incomplete/cancelled.” A later eligible automatic run or manual Update retries outstanding work, without an immediate failure retry loop.

The user's vault-sync transport carries these files; never share the mutable local index. Obsidian Sync requires “Sync all other types” on each device. There is no separate startup uploader, third-party cache service, custom transport, or credential sharing. A device with a compatible cache profile can rebuild from complete document-cache hits without a working provider; a cache miss still requires its configured provider. No provider-health preflight is added.

### Rebuild and explicit Clear

Ordinary reset and Rebuild clear indexed state and RecordManager state while retaining document/query caches, receipts, and shared files. **Clear index and embedding cache** additionally clears all local document/query profiles, import/publication receipts, and known managed SQLite artifacts and temporary files under the shared cache root across profiles. It needs no configured model.

Clear leaves notes, settings, vault identity, the OPFS namespace, unrelated files, and other devices' local caches intact. Shared-file deletion follows vault sync and cannot guarantee deletion on every device. Cancel pending searches and reset submitted Lente results before clearing, so existing requests cannot repopulate the deleted cache and Clear does not replay a query.

The SQL clear commits or rolls back before shared-file removal starts. Cancellation before commit preserves prior local state. Failure or cancellation afterward reports local clearing with shared cleanup incomplete, leaves automatic indexing paused, and permits retrying Clear. Cross-store clearing is not atomic.

## Rationale

LangChain's document cache removes custom cache policy; SQLite shards avoid serializing every vector through JavaScript. For ordinary URLs, endpoint-independent identity permits cross-device reuse; fingerprinting opaque URL variants keeps those variants separate. Keeping query vectors local prevents vault sync from publishing query history. Immutable bounded files and transactional receipts make retries idempotent without sharing a live index. Explicit Clear keeps destructive maintenance under user control.

## Consequences

Embedding hashes and vectors remain derived data; absence of raw text is not a claim of anonymity. Incorrect model equivalence can reuse incompatible vectors, so users must configure matching weights. For URLs containing userinfo, a query, or a fragment, the opaque SHA-256 endpoint fingerprint is only a cache discriminator; it does not encrypt credentials or prove model compatibility, and raw URL components are omitted from the serialized note profile. Sync configuration and delivery remain external dependencies. Completed files can survive interrupted publication; other devices can retain local copies after Clear.

The former `docs/work-brief-local-indexes-shared-cache.md` (“Agreed direction” and “Approved V1 implementation contract”) required verified model/output-space identity and said an alias plus dimensions alone does not prove compatibility or cross-endpoint equivalence. This ADR's accepted cache decision instead assumes equal trimmed model IDs and dimensions imply equal weights across ordinary endpoints, while URL variants containing userinfo, a query, or a fragment are separated by the fingerprint described above. The transition reason is not recorded. This migration preserves the current accepted decision and flags the earlier contract as conflicting historical provenance; it does not establish that the equivalence assumption is true.

## Evidence and reconsideration

The following workload-specific evidence was recorded in the former `docs/langchain-performance-assessment.md`, in “SQLite embedding-cache comparison — 2026-10-13,” “Production OPFS shard comparison — 2026-10-14,” and “OPFS receipt batching comparison — 2026-10-14.” It is historical and does not measure actual vault-sync latency or establish current performance:

- A 2026-10-13 synthetic 3,000-note cache bootstrap using an in-memory vault adapter completed with zero provider requests in a median 5,725.15 ms. This demonstrates cache-hit behavior for that snapshot only; it does not validate real sync or live-provider latency.
- In a 2026-10-14 production-worker OPFS comparison at 3,000 notes (three samples after warmup), the pre-optimization SQLite-shard snapshot measured median cold indexing of 24,337.27 ms and publication of 15,255.30 ms, versus 9,478.29 ms and 1,045.95 ms for the JSON snapshot. SQLite artifacts were 13,844,480 bytes versus 12,502,544 bytes. The run used Brave 154, SQLite WASM, a deterministic 768-dimensional provider fixture, and an in-memory vault adapter; it did not measure sync.
- A separate 2026-10-14 paired receipt-batching comparison at 3,000 notes (three samples) measured median cold indexing at 31,905.10 ms before and 14,675.80 ms after batching, and publication at 18,169.12 ms and 802.04 ms. It used Brave 154, the production OPFS worker, a deterministic 768-dimensional provider fixture, and an in-memory vault adapter; the cache held 24 artifacts. This pair isolated receipt-write batching in the SQLite-shard path; absolute timings are not comparable with the JSON comparison above and do not establish broad Obsidian performance.

Reconsider the format, retention, or equivalence assumption when requirements or representative evidence change, preserving document-only sharing and explicit clearing.
