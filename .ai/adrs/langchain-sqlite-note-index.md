# ADR: LangChain and SQLite note index

- Status: Accepted
- Date: 2026-10-09
- Updated: 2026-10-21

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

Use a native LangChain agent, Zod-validated read-only tools, native message text, and the experimental v3 event stream for this proof of concept. Keep per-session message history in LangGraph's native in-memory checkpointer rather than a manually maintained message array or persistent store; keep the visible transcript and cancellation state as separate UI/session projections. Replace the in-memory saver on reset so a new session cannot inherit writes from an older in-flight run. Promote a checkpoint only after a completed turn has visible answer text and no pending tool-call request; otherwise retain the last completed context. Rely on LangGraph's default recursion limit; do not add custom model-call or tool-call counters or override the graph limit. This finite native graph-step bound preserves batching and native agent behavior without introducing application-specific count policy. Inject turn-scoped skill and attachment context through `wrapModelCall` into copied user messages only for provider requests; the visible invocation remains in history rather than the fetched skill body. Attachments remain available across tool calls in the same turn and cannot carry into later turns, including after failure or cancellation. Treat attached and retrieved note content as untrusted evidence on every turn, including turns without selected skills or attachments. For skill-based analysis, provide the selected skill and shared-note paths as source roots, inspect relevant links from both, and follow source-relative links only for necessary evidence or continuation. Do not crawl unrelated branches or automatically activate linked skills. Resolve a bare `read_note` title only when it uniquely matches a visible Markdown note; return ambiguity instead of choosing a vault path implicitly. Use `follow_link` for source-relative resolution.

Use the OpenAI-compatible Responses API with plain-text `text.format`, `store: false`, and non-strict tool calling. Pass configured OpenAI-compatible chat and embedding base URLs through to the SDK without application-level host, IP, origin, path, or redirect filtering. Treat entering the URL as the user’s endpoint choice, with no separate origin-approval registry or approval step; users may include the path prefix required by their provider, while the existing /v1 defaults remain. Keep ordinary URL parsing, request cancellation, and embedding-vector validation. For embedding-cache identity, preserve cross-endpoint reuse for ordinary URLs; when a URL contains userinfo, a query, or a fragment, include a SHA-256 endpoint fingerprint to separate variants and strip those raw components from the serialized note profile. The fingerprint is a cache discriminator, not encryption. This removes duplicate endpoint filtering while leaving provider request handling to the SDK; it does not add authentication settings or promise support for every provider. Settings loading is offline; chat and search follow explicit actions, while eligible automatic indexing may call the embedding provider on cache misses. Each indexing or query embedding request uses a fresh `OpenAIEmbeddings` instance and abort signal so concurrent work cancels independently. Related-note scoring never calls a provider.

### Ephemeral Voce composer

Keep Voce drafting as ephemeral plain text in a `contenteditable="plaintext-only"` surface, using Obsidian's `AbstractInputSuggest` for inline note and skill suggestions. A small adapter handles text, caret, and token replacement; submitted Markdown renders in the transcript. Do not add a rich editor, CodeMirror layer, or persisted draft store just to support inline suggestions. This uses Obsidian's public suggestion UI while keeping the composer and session history lightweight.

## Rationale

Native indexing removes owned lifecycle policy. The atomic note/record write closes the write-before-record-update orphan gap without adding a second lifecycle. SQLite adapters preserve bounded corpus computation and avoid moving vectors to JavaScript. Omitting raw note bodies limits stored corpus content, while live-vault hydration keeps Markdown authoritative. Stable vault identity isolates local indexes across reloads. Native agent middleware avoids bespoke history cleanup while preserving attachment privacy. Keeping selected skills as explicit current-turn instructions and linked notes as untrusted evidence gives the agent useful source-relative context without granting reference notes instruction authority or crawling unrelated vault branches.

## Consequences

This is a simplification, not a claim of equivalent ranking or semantic quality. Failed runs can retain partial prior commits until a later successful update. The experimental agent stream and live-provider behavior require device-level validation. The legacy `MEMORY.md` described query-time JavaScript centroids and adaptive scheduler windows of 3→9→20 seconds with a 60-second deadline; the current table and maintenance ADRs record retained centroids and the current schedule. The earlier reason for those changes is not recorded. The “Approved V1 implementation contract” in `docs/work-brief-local-indexes-shared-cache.md` described section-aware structural chunks and a different ranking contract; that brief says the shared-cache direction was superseded by the V1 rewrite but does not preserve a reason for each change. Its schema 16/protocol 13 and `MEMORY.md`'s schema 6 and coupled runtime identity v9 are historical version notes, not current compatibility claims. These older details are provenance, not current behavior or rationale.

Retain the existing 5a clock SQL; do not adopt `UPDATE RETURNING`. In the 2026-10-19 profile-off comparison, a 3,000-note candidate was tested with two warmups per side and 12 balanced rounds across three sessions. It beat both controls in only 4/12 rounds for no-op and delete, and its paired median gains (0.29% and 2.45%) failed the predeclared gate for both operations. This result was offline-validated from preserved browser output, not a clean successful runner result: the original identity guard failed on workspace-path comments in emitted bundles, and original bundle hashes were not retained. Offline checks found equal input closures and rebuilt workload bytes after only that comment normalization; executable-byte differences were rejected. No rerun occurred, and this evidence does not establish behavioral equivalence.

The following extracted ADRs retain the previously accepted decisions; this documentation split changes no runtime behavior:

- [Embedding cache, vault sharing, and explicit clearing](embedding-cache-sharing-and-clear.md).
- [SQLite table storage layout](sqlite-table-storage-layout.md).
- [Automatic indexing and settings changes](automatic-index-maintenance.md).

The former `docs/langchain-sqlite-implementation.md` reference mapped this decision to the source tree. The concise current map is:

| Area                             | Components                                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Indexing                         | `src/index/ManualIndex.ts`, `SqliteNoteRecordManager.ts`, and `SqliteNoteVectorStore.ts`                                                                        |
| SQLite and Worker                | `src/index/note-sqlite/database.ts`, `worker.ts`, and `client.ts`                                                                                               |
| Retrieval and cache              | `src/index/VaultRetrieval.ts`, `SqliteEmbeddingCache.ts`, and `src/plugin/VaultEmbeddingCache.ts`                                                               |
| Plugin and settings              | `src/plugin/TramaPlugin.ts` is the Obsidian lifecycle root and constructs `ManualIndex` and `VaultRetrieval`; `src/ui/settings/SettingsTab.ts` owns settings UI |
| Agent and provider configuration | `src/chat/ChatSession.ts`, `src/tools/VaultTools.ts`, and `src/model/LocalModels.ts`                                                                            |

Historical verification counts and benchmark snapshots are not current performance claims. The [generated demo vault guide](../../docs/demo-vault.md) documents actual-host checks; the [Obsidian benchmark guide](../../docs/obsidian-benchmark.md) documents current-app measurements.

## Reconsideration

Revisit native defaults and ranking with representative quality and performance evidence. Revisit the rewrite boundary if compatibility or migration becomes a product requirement. Preserve bounded SQL computation, vault isolation, and privacy boundaries.
