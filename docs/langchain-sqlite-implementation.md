# V1 implementation reference: LangChain and SQLite

The accepted architecture is recorded in ADRs. This reference maps those decisions to the implementation; it does not define a second architecture contract.

## Accepted decisions

| ADR                                                                                                       | Scope                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [LangChain and SQLite note index](../.ai/adrs/langchain-sqlite-note-index.md)                             | Complete rewrite, native indexing and retrieval, vault/worker isolation, agent and attachment privacy. |
| [Embedding cache, vault sharing, and explicit clearing](../.ai/adrs/embedding-cache-sharing-and-clear.md) | Cache identity, local queries, document-only SQLite shards, `VACUUM INTO`, Rebuild and Clear.          |
| [SQLite table storage layout](../.ai/adrs/sqlite-table-storage-layout.md)                                 | Rowid choice per table, retained centroids, storage evidence and no migration.                         |
| [Automatic indexing and settings changes](../.ai/adrs/automatic-index-maintenance.md)                     | Debounce/backstop, empty-index pause, settings sync and confirmation, folder exclusions.               |

## Component map

| Component                                                                                                                    | Responsibility                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [ManualIndex](../src/index/ManualIndex.ts)                                                                                   | Cache import, bounded native `index()` calls, final full cleanup, publication.                                       |
| [SqliteNoteRecordManager](../src/index/SqliteNoteRecordManager.ts)                                                           | LangChain RecordManager interface and run watermark.                                                                 |
| [SqliteNoteVectorStore](../src/index/SqliteNoteVectorStore.ts)                                                               | Default Markdown splitting, cross-note embedding batches, atomic prepared-note writes.                               |
| [SQLite database](../src/index/note-sqlite/database.ts)                                                                      | Schema, record/cache operations, FTS5, vector scoring, transactions, shard validation and `VACUUM INTO`.             |
| [Worker](../src/index/note-sqlite/worker.ts) and [client](../src/index/note-sqlite/client.ts)                                | Isolated OPFS storage, FIFO RPC, cancellation, bounded errors and shutdown.                                          |
| [VaultRetrieval](../src/index/VaultRetrieval.ts)                                                                             | Shared search runnable, live-note hydration, related-hit reuse and pending-search cancellation.                      |
| [SqliteEmbeddingCache](../src/index/SqliteEmbeddingCache.ts) and [VaultEmbeddingCache](../src/plugin/VaultEmbeddingCache.ts) | LangChain document cache, local query cache, validated immutable shard import/publication and managed-file clearing. |
| [TramaPlugin](../src/plugin/TramaPlugin.ts) and [SettingsTab](../src/ui/settings/SettingsTab.ts)                             | Serialized configuration, current UI services, update triggers, native settings controls and maintenance feedback.   |
| [ChatSession](../src/chat/ChatSession.ts) and [VaultTools](../src/tools/VaultTools.ts)                                       | Native agent, read-only tools, private turn middleware and provenance.                                               |
| [LocalModels](../src/model/LocalModels.ts)                                                                                   | OpenAI-compatible Responses and embeddings configuration, per-request cancellation and guarded discovery.            |

The contentless FTS5 table uses `content=''`, `contentless_delete=1`, and `unicode61` over body and path text. No raw Markdown bodies, custom `source_hash`, or `chunk_count` are persisted. Current file modification dates come from Obsidian metadata rather than another indexed field.

Shards use application ID `0x54524D41`, user version 1, one metadata row, a hash/vector table, and the known empty `_sqliteai_vector` bookkeeping table. SQL validates schema, profile, task, dimensions, hashes, BLOB size, finite values, and integrity. These format details remain in the adapter; their architectural constraints are in the cache ADR.

Lente and Filo use the shared native search-result presentation. Filo and Voce share bounded related-note hits; Voce offers the current note and up to five related paths as optional suggestions. Lente has no relevance rating; Filo's qualitative similarity is approximate and model-dependent. These UI details remain implementation and usage documentation rather than separate ADRs.

## Verification and evidence

At implementation commit `4679a33` (2026-10-19), the recorded verification passed 189 tests across 22 files, the production build, lint, and formatting checks. No tests or live-app checks were rerun for this documentation consolidation.

Relevant regression coverage includes native indexing skip/refresh and cleanup, UID-safe writes/deletion, cancellation and rollback, cache profile isolation and shard import/publication, explicit Clear and partial cleanup, pending-search cancellation without cache repopulation, settings confirmation after tab closure, external settings replacement, and private turn attachments.

Historical test counts, bundle sizes, workloads, and retired-runner results are retained in the [performance assessment](langchain-performance-assessment.md#historical-implementation-verification-snapshots). They do not describe current performance. Use the [current-app benchmark guide](obsidian-benchmark.md) for new measurements. Live Obsidian interaction, cross-device sync, desktop/mobile behavior, and a live agent tool roundtrip are not established by repository tests.
