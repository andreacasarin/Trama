# V1 implementation: LangChain and SQLite

This document describes the approved and implemented V1 architecture. The matching durable decision is recorded in [the note-index ADR](../.ai/adrs/langchain-sqlite-note-index.md).

## Scope

V1 is a complete rewrite around LangChain's vector-store and default Markdown-splitting interfaces, OpenAI embeddings, a native LangChain agent, tools validated with Zod, and native call limits. Obsidian adapters handle vault and plugin integration. This rewrite does not preserve the former application's APIs, schemas, ranking, settings, caches, or test goldens; it adds no backwards-compatibility layer, migrations, shims, or parallel indexes. The implementation keeps indexed-data filtering, grouping, ranking, and vector scoring in SQLite using native SQLite/WASM functions; JavaScript orchestrates bounded inputs and presents results.

Each vault's storage identity is created once at `.trama/note-v1/identity.json` as a version-1 random 32-byte token encoded in hex. Trama validates it on reload and uses it for the isolated OPFS database `trama-note-v1-<token>/notes.sqlite3`. The identity keeps the same vault namespace stable across reloads; copying the identity file copies that namespace. There is no shared-storage fallback. The SQLite database is initialized in the worker before RPC requests are handled.

The local SQLite index stores note identity and path, source hash, embedding profile, chunk count, chunk vectors, normalized note centroids, and lexical search data. It does not store raw Markdown bodies. Search resolves winning notes against the live vault and hydrates their current content when needed. The Markdown splitter uses LangChain's default behavior.

The worker database has a note index keyed by note ID with path, source hash, embedding profile, chunk count, and a nullable centroid BLOB; chunk vectors are keyed by note ID and ordinal. Lexical search uses a contentless FTS5 index (`content=''`, `contentless_delete=1`, `unicode61`) over body and path text. Its worker RPC surface supports get, replace, delete, semantic lookup, reset, list, hybrid search, and related-note lookup. This is the V1 worker contract; it does not promise compatibility with the former schema or API.

Hybrid search combines SQLite BM25 lexical ranking and semantic ranking with reciprocal-rank fusion using rank constant 60. Semantic ranking uses each note's maximum chunk dot product. Related-note lookup scores normalized note centroids separately. Corpus computation stays in SQLite; vectors are not transferred to JavaScript for scoring.

## Index lifecycle

Only explicit **Update index** and **Rebuild index** actions prepare corpus data. For each note, Trama prepares the full index update and commits it atomically, then rereads the live source hash. If the note changed during preparation, Trama repeats preparation. Cancellation messages are handled outside the SQL request queue. The worker yields after each 16 chunk inserts and before commit, checking for cancellation at each yield. An abort rolls back the active note transaction; earlier completed note commits remain.

When embedding fails, the latest lexical index remains usable, semantic data for the affected note is cleared, and the profile is set to null. The next manual update can retry. If semantic querying is unavailable, the query falls back to lexical search and visibly reports degraded behavior. Embedding calls occur for note indexing and hybrid queries; related-note lookup uses SQLite centroid scoring and never calls a provider. Each indexing or query embedding request creates a fresh `OpenAIEmbeddings` instance with its own abort signal, so concurrent indexing and queries can be cancelled independently. Related-note results persist across restarts and refresh after an index update when the active note is opened.

## Worker and database lifecycle

The production worker processes SQL requests through a FIFO queue. RPC errors are bounded to `{name, message}`, and cancelled requests surface as `AbortError`. Indexing yields after every 16 chunk inserts; deleting note paths yields every 16 paths. Both check cancellation before commit. Reset checks between its two SQL statements and before commit. Cancellation rolls back the active transaction. Closing aborts active work, waits for transaction rollback, closes the database, and pauses the VFS non-destructively to release its storage pool. It acknowledges close before self-termination; the caller has a termination fallback. Settings changes await close before reopening the index. Each index instance owns its run callbacks so stale callbacks cannot affect a replacement instance.

The plugin awaits worker client initialization before publishing services or UI actions. Worker `error` and `messageerror` events reject initialization so the candidate client can close cleanly. Plugin loading, settings persistence, and configuration changes are serialized through one promise chain, with settings-updater work evaluated inside that chain. Disposed checks after awaits prevent stale clients or UI from appearing after unload; a client created by a pending run is closed if unload happens before that run finishes.

## Agent and privacy boundaries

Conversation history and turn attachments exist only for the current session or turn. Provider requests use `store: false`. Startup and settings loading work offline; provider access follows an explicit user action. Approved local private endpoints are guarded. Agent tools are read-only and return note links.

V1 has no shared cache or publication path, scheduled maintenance, automatic vault-event indexing, background indexing jobs, migrations, or legacy graph subsystem. Compatibility is limited to the Obsidian adapters needed to integrate with the plugin host.

## Verification and evidence

As of 2026-10-09, the implementation work reports 17 active files and 58 active tests, with build, strict-unused TypeScript, lint, SQLite, and formatting checks passing. Coverage includes production worker handling with real WASM, queued messages, cancellation rollback during indexing and reset, database isolation, search/reset, stable and malformed initialization, close/rebind behavior, stale callback isolation, independent indexing/query cancellation, related-note persistence and restart behavior, and tool payload privacy. The cleanup removed obsolete legacy test and helper code, benchmark-only fixtures, and formatter exclusions. Twenty-four Markdown notes remained byte-identical.

The implementation has 4,453 source lines across 28 files, compared with 17,956 lines across 73 files before the rewrite, roughly 75% fewer lines.

These counts describe repository checks, not device or live-provider validation.

A small workload used 24 committed Trama notes and 48 vectors: the latest run reported 174.4 ms indexing, 8.7 ms query time, and 20 hydrated results. Its SQLite database was 98,304 bytes. Timing varied between runs, so this is one workload observation, not a performance guarantee. The reported built artifact sizes are 1,990,847 bytes for `main.js` (499,244 bytes gzip) and 514,496 bytes for the worker (138,438 bytes gzip). Real desktop and mobile behavior, Obsidian integration on a device, and live LM Studio compatibility remain unverified.

Historical benchmark commands and reports describe earlier implementations. They are retained for context and do not define current V1 commands or performance guarantees.
