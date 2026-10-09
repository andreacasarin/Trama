# ADR: LangChain and SQLite note index

- Status: Accepted
- Date: 2026-10-09

## Decision

Trama V1 is a complete rewrite built around LangChain's vector-store and default Markdown-splitting interfaces, OpenAI embeddings, a native LangChain agent, Zod-validated tools, and native call limits. Obsidian adapters provide host integration. The rewrite does not preserve the prior application's APIs, schemas, ranking, settings, caches, or test goldens, and adds no compatibility layer, migrations, shims, or parallel indexes.

SQLite is the source of indexed retrieval computation. It stores note path and identity, source hash, embedding profile, chunk count, chunk vectors, normalized note centroids, and lexical search data, but not raw Markdown bodies. Hybrid search fuses SQLite BM25 lexical ranking with semantic ranking based on maximum chunk dot product, using reciprocal-rank fusion with rank constant 60. Related-note lookup scores normalized note centroids separately; its results persist across restarts and refresh after index updates when the active note is opened, without provider access. Embedding provider calls are limited to note indexing and hybrid queries; each request uses a fresh `OpenAIEmbeddings` instance and abort signal so concurrent indexing and queries can be cancelled independently. Winning note content is hydrated from the current vault.

Each vault receives a version-1 random 32-byte storage token, represented as 64 hexadecimal characters in `.trama/note-v1/identity.json`. The token determines its isolated OPFS database path, `trama-note-v1-<token>/notes.sqlite3`. The worker initializes that database before handling RPC. Reloading the identity preserves the vault's namespace; copying the identity file copies that namespace too. There is no shared-storage fallback.

Indexing is manual through Update and Rebuild. Each note is prepared fully and committed atomically; afterward its live source hash is checked and changed notes are prepared again. The production worker processes SQL requests in FIFO order. Cancellation messages are handled outside the SQL request queue. Indexing yields after each 16 chunk inserts; deleting paths yields every 16 paths; reset checks between its two SQL statements. These operations check for cancellation before commit and roll back their active transaction on abort, retaining earlier completed note commits. On embedding failure the latest lexical index remains available, semantic data for that note is cleared, and its profile is null so a later manual update can retry. A failed semantic query falls back to lexical retrieval and reports degraded behavior.

Session history and turn attachments are ephemeral. Provider calls disable response storage. Startup and settings loading do not call providers. Tools are read-only and return note links. Worker initialization completes before UI/services are published; worker errors reject initialization and close the candidate. Plugin load, settings persistence, and configuration changes are serialized through one promise chain. Disposed checks after awaits prevent stale clients or UI after unload, and a client created by a pending run closes if unload happens before completion. Closing aborts active work, waits for rollback, closes the database, and pauses the VFS non-destructively to release its storage pool. Settings changes await close before reopening the index; each instance owns its run callbacks. Compatibility covers Obsidian adapters only. V1 excludes shared caches, publication, scheduled maintenance, automatic vault-event indexing, background jobs, migrations, and the legacy graph system.

## Context and rationale

The approved goal is a small, local V1 with a complete rewrite and no compatibility burden beyond Obsidian integration. Keeping retrieval computation in SQLite avoids moving corpus vectors into JavaScript and follows the repository's SQLite guidance. Omitting raw note bodies from the index limits stored corpus content, while hydrating winners from the live vault keeps current note text authoritative. Per-vault identity and isolated storage keep each vault's index separate; stable identity reload preserves that namespace. Manual preparation and atomic per-note commits bound work and let completed updates survive cancellation. The lexical fallback preserves a usable search path during embedding or vector-query failures.

The choice of LangChain defaults, rank constant 60, and the centroid plus maximum-chunk scoring are approved V1 defaults; no separate rationale for tuning those individual values was supplied. They can be reconsidered with measured evidence without changing the privacy and storage boundaries above.

## Consequences

V1 has no automatic freshness guarantee: users explicitly update or rebuild the index. Search results reflect indexed metadata and vectors but obtain displayed note content from the live vault. Embedding failures can leave semantic retrieval incomplete while lexical retrieval remains usable. Old architecture notes and memory that describe query-time JavaScript centroids, cache publication, schedulers, generations, or migration machinery are historical context and do not override this decision.

## Reconsideration

Revisit this decision when product requirements call for automatic indexing, shared or published data, migration support, or when representative workload measurements justify changing the storage or ranking design. Any change must preserve explicit privacy boundaries and keep corpus computation bounded.
