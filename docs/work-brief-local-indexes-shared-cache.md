# Work brief: local indexes and a shared embedding cache

Status: the current implementation uses schema 15/protocol 13, with the approved resolver, single-model reset, and deletion cleanup applied. Latest verification after test cleanup and Filo display fix: 581 tests passed, none skipped; build, lint, and formatting passed. The generated 3,000-note Obsidian CLI benchmark passed all 12 gates in 52.696s with a complete 2,655-record capture (`8103c46b-5ef8-4c76-a52c-a6f2cbe70533`). The prior current-design run took 53.594s: cold-run performance is comparable. The final repeated unchanged cache check took 0.8 ms. The final build reloaded with cache preserved and the fixture provider stopped, reaching idle in 2.273s including CLI verification; evidence is in `.artifacts/benchmarks/cleanup-cache-reload.json`. These generated-vault measurements do not establish personal-vault or mobile latency, or judged relevance quality.

## Approved deletion cleanup (6 October 2026)

Only the current schema (15) and protocol (13) are supported. Whole-database
publication/adoption and legacy extraction, schema migrations, profile selection modes,
write-only chunk copies, and the old generated-corpus installer upgrade were removed. Current
cache-shard VACUUM/SHA validation, local lexical/semantic heads, and providerless retrieval remain.
Cache checks look up SHA filename receipts in SQL batches of 512 before reading files.
Compaction reads at most eight artifacts and 16 MiB per check, reuses captured bytes,
and records weekly no-op checks. File-size metadata skips near-full artifacts before
reading them. Historical verification below predates this cleanup.
`tests/workloads/expected-results.ts` is the current frozen ranking reference, renamed
from `legacy-oracle.ts` without changing expected values. The source-manifest hash is
refreshed for the rename; fixture content and ranking gates remain unchanged.

## Test-suite cleanup (6 October 2026)

The retired in-memory benchmark runner, report generation, RSS/timing instrumentation,
and their tests were removed. `npm run benchmark` remains the single live Obsidian
CLI workflow. A focused `tests/workloads/retrieval.test.ts` integration test keeps the
frozen small-workload content hashes, semantic coverage, and lexical/hybrid/Filo/Voce
rankings checked against production indexing and retrieval after mutations and a local
restart. The independent ranking reference still checks all three fixture profiles.
Fixture bytes and expected result values are unchanged. The source manifest now covers
only maintained fixture/reference/test sources; obsolete baseline report metadata was
removed. An unused semantic oracle, obsolete snapshot payloads, and unused test-client
options/callbacks were removed. Tests observe actual production phase diagnostics
without duplicating the retired benchmark instrumentation or pinning incidental SQL
statement counts. The former skipped benchmark entry point is gone.

Filo retains the active note’s previous related results above maintenance progress and
while a refreshed lookup is pending. Successful retrieval replaces them; a failed
refresh keeps them with a warning. Switching notes clears retained results and aborts
the previous request. Initial indexing without prior results still shows progress only.

Settings commands wrap beneath their descriptions in narrow panels. Cache publication
and import are labeled explicitly; reset is local, while Clear also deletes shared
cache files. Folder, scheduled-maintenance, and model-change descriptions reflect
cache-only sharing. Publication status says “Publishing embedding cache”; its work
includes retention, periodic compaction, compact SQLite export, SHA validation and
file writes, and receipt recording. Settings show export size in MiB and duration
in seconds.

Updates, rebuilds, and automatic maintenance now refresh open Filo results after local
indexing settles and before sharing embeddings. The scheduler awaits that refresh;
no open Filo view means no retrieval work. A refresh failure does not block sharing,
and cancellation releases the wait so newer manual commands retain priority. Filo
allows lookups during the results stage, retains rows throughout sharing, and avoids
repeating a completed lookup afterward. Settings and palette labels distinguish local
search indexes from shared embeddings: Update search indexes, Rebuild embeddings,
Share embeddings, Import shared embeddings, Reset local search data, and Clear local
search data and shared embeddings. Existing command IDs remain unchanged; sharing
and importing have explicit palette commands.

## Approved resolver simplification (6 October 2026)

This follow-up supersedes the multi-profile selection and import-time semantic
promotion rules below. Each vault uses one active model/version, dimensions, and
preprocessing identity. Endpoints are transport configuration; all devices must use
identifiers for the same model version. Document and query tasks stay distinct.
A changed model requires explicit semantic rebuild while lexical search remains
usable. Incompatible prior local schemas are reset and rebuilt, without migration.
Model-change rebuild atomically clears all local semantic vectors and document/query
cache entries, plus import and compaction bookkeeping, and starts fresh with the configured
model. Recalculation is acceptable; there is no special reimport step during rebuild.
Lexical data remains usable. Model-change rebuild deletes shared cache shards before switching the local model; deletion failure can be retried.
Late-arriving other-model shared shards are ignored
and excluded from compaction and retirement. Filo keeps the required rebuild action
visible across idle stale, error, cancelled, and empty statuses.

Cache reception only validates and merges SQLite cache entries. It never indexes
notes, promotes heads, or calls the provider. The ordinary maintenance schedule
handles semantic preparation afterward; automatic maintenance remains opt-in.
`EmbeddingResolver` owns document cache selection and query cache/provider fallback.
SQL selects unique document misses across notes and packs bounded provider batches;
cache hits consume no provider slots. Query cache misses dispatch immediately.
Existing generation checks and short transactional commits remain in force.

## Agreed direction

- Markdown in the current vault is authoritative. Users may have any number of devices; providers may be unavailable, intermittent, or reachable from only some devices.
- Keep persistent local lexical and semantic indexes. Maintain them independently and reconcile changed notes rather than rebuilding the corpus on every sync. Lexical indexing and search must continue without an embedding provider.
- Provider requests are asynchronous and happen outside short local SQL transactions. Semantic coverage may lag. Preserve the last complete compatible semantic state as best-effort search state while new work is pending; publish results only after input and generation checks pass.
- Cache embedding computations by exact compatible input and embedding-space/task/preprocessing identity, not vault path or local row/revision ID. Endpoint reachability is not identity. Model alias plus vector dimensions alone do not prove compatibility. The phrase “same model” is not a settled identity rule.
- Treat shared embedding cache as additive contributions: deduplicate compatible inputs, union received contributions, and never let an incoming snapshot replace known-compatible local cache entries. Local indexes remain independently owned. Recomputing the same request on disconnected devices is acceptable; global coordination is not a goal.
- Current Markdown inventory controls visibility. A deleted or excluded note must not be restored into search from a cache contribution or stale publication. Shared-cache pruning must not delete local index state. Candidate retention policy may use a grace period and must preserve cache inputs still referenced by active or last-complete semantic state.
- Prefer full-note lexical indexing: one FTS entry per note with title, headings, and body distinguishable. Do not add section-level FTS entries without demonstrated need. Lexical retrieval can match across sections; its length-normalization tradeoff needs its own quality check.
- Keep lexical and semantic segmentation independent. For semantic input, prefer meaningful Markdown headings as outer boundaries, then coherent paragraph/list/table/code groups under the model-input budget. Group small adjacent blocks under the same heading; split oversized blocks on sentence or structural-element boundaries. Avoid whole-note, physical-line, and folder/type-specific embedding rules.
- Key embedding-cache entries by a digest of the exact final provider-input bytes, true embedding model/output space, task, and only input/output transforms that affect the vector but are not already represented in those bytes. Store chunk/input-recipe versions on semantic heads/blocks for reconciliation, not as blanket cache-key components: changing a segmentation cap/version must reuse byte-identical provider inputs. Heading or serialization edits that change the final bytes naturally miss. Unchanged inputs should remain reusable; edits should affect only relevant lexical notes or semantic blocks. Natural boundaries need no overlap; consider small sentence overlap only for forced splits. 256/512-token caps are evaluation points, not selected defaults.
- Prioritize relevance quality. Combine lexical note evidence with semantic passage evidence while preserving the supporting passage. A topic-specific match should beat an incidental mention when content supports it; broad multi-theme reviews can still be relevant. Repeated template headers alone are insufficient evidence. Conceptual bridges are desirable only when supported by note content, not titles or a hard-coded taxonomy. Avoid raw score sums or length/count bonuses and do not rely exclusively on one global centroid.
- Related-note retrieval is separate from free-text semantic search. Reuse compatible local vectors for offline related-note results. Free-text queries need query embeddings unless an exact compatible query-vector cache hit exists; on a miss or provider failure, fall back to lexical search. Query-vector caching is optional and has separate retention/size policy.
- Keep the standard plugin runtime. The approved D5 benchmark is one fixed generated corpus, documented below; it supersedes the prior profile matrix and 12-scenario/17-gate workflow. Do not add another runtime, device lease, quorum, global presence service, or new vault IDs.

## Approved contract and remaining validation

The V1 baseline in “Approved V1 implementation contract” was accepted for implementation. The local index model, cache-only SQLite contribution shards, identity and profile rules, migration constraints, merge and recovery behavior, retention, structural chunking, query-cache policy, and publication/compaction rules below are approved implementation direction, not unresolved design proposals. Exact record names are illustrative. Validate real provider/model guarantees and implementation behavior against this contract; do not reopen the settled baseline without evidence of a contract conflict.

The accepted indexing and ranking algorithms remain implementation requirements; D2 independently replaced obsolete expected rankings. D5 now supersedes the earlier benchmark fixtures and 12-scenario/17-gate workflow for benchmark acceptance. Its correctness sentinels are not a human relevance evaluation.

Remaining pre-adoption work is capability confirmation, implementation validation, judged relevance evaluation, and real-device performance measurement, as listed under “Remaining external validation before adoption.” These are evidence gates, not permission to substitute unapproved persistence, identity, retention, or transport designs.

## Current implementation and verification status

Builder reports B1/B2/B3 as implemented with schema 15/protocol 13. The local
SQLite/WASM database maintains full-note lexical FTS separately from structural
semantic blocks and current/last-complete semantic heads. Markdown remains the
visibility authority. The current semantic input cap is 384 canonical serialized
characters including heading context, with zero overlap.

- Full-note FTS weights are body 1, path 2, filename 3, title 3, and headings 0.5,
  without duplicate heading contributions. Lexical retrieval works without embeddings.
- Compatible vectors are cached/shared by exact provider-input bytes, task, and proven
  output space. Shards contain computed vectors only; receipt validates and merges
  additively. Ordinary reset preserves shared cache files.
- Lente ranks the maximum compatible passage cosine per note, top 80 per channel,
  with RRF k=60. Related notes use centroid plus three diverse probes for bounded
  candidate generation, then exact symmetric top-two reranking over all distinct
  compatible passages in both notes.
- Query-vector cache hits can support offline semantic search; a miss needs the
  embedding provider and falls back to lexical retrieval when unavailable.

Two normal D5 install/CLI runs passed all 12 gates in 53.027s and 56.603s, with
complete 2,684-record captures. The earlier 1,100-note/10,000-passage run belongs
to the superseded profile workflow and is historical only. These results do not
establish large-profile completion, mobile performance, or judged relevance quality.

## Current remaining acceptance work

1. The one-time generated-marker upgrade completed while preserving Obsidian settings,
   Trama installation, and vault registration, and replacing only known generated
   Markdown.
2. Two normal D5 runs completed through the marked generated vault and passed all
   12 gates with complete, matching-run captures. Real-device/provider validation and
   human relevance evaluation remain separate outstanding evidence gates.
3. Complete the final whole-diff review before shipping.

## Guardrails and references

- Markdown remains authoritative; an arriving snapshot or cache contribution must not redefine current note visibility.
- Shared-cache cleanup must not delete local index state. Preserve generation fences, transaction rollback, committed-batch resumability, and atomic publication/adoption guarantees.
- Obsidian CLI operations may touch only the marked generated vault under .artifacts/test-vaults. Use an explicit selector first and verify the exact selected path before every CLI operation. Never enumerate, access, or fall back to personal/active vaults.
- Relevant contracts: README.md; docs/sqlite-snapshots.md; docs/obsidian-benchmark.md; docs/lifecycle-benchmark-contract.md; MEMORY.md. Current task evidence is in .ai/work/maintenance-retrieval-performance.md; its newest design paragraphs supersede older assumptions. The earlier VACUUM/SHA proposal is not shipped.
- This brief records the accepted implementation plan. Implementation is authorized and underway; the brief does not claim migration or shipping is complete.

## Approved V1 implementation contract

The user accepted this concrete V1 contract for implementation. It records approved baseline behavior and parameters, while names explicitly described as illustrative remain examples. Ranking algorithm requirements below remain in force; only obsolete expected ranking outputs are superseded as described above. No product implementation or runtime result is claimed here.

### Local state and semantic preparation

- Accepted logical record roles: `note_current` (note ID, path, current digest, visibility); `lexical_note` (title, headings, body) with one external-content FTS entry per note; `semantic_note` (source digest, profile, preparation recipe, completion state); and `semantic_block` (note ID, ordinal, source line positions for display, heading, exact input key). Names are illustrative, not a prescribed schema.
- Maintain semantic block mappings for the last complete state while changed inputs are prepared. Build requests from current visible Markdown, check digest/profile/recipe and cancellation generation before promotion, then atomically promote complete current coverage and remove superseded mappings. Failed or cancelled work leaves last-complete state available; committed compatible vectors remain reusable.
- Provider requests stay outside SQL transactions. Persist successful compatible cache results in bounded transactions. Keep active work and old last-complete inputs protected from pruning. Derive pending work from current inputs versus cache/coverage; do not add a durable request queue or arbitrary revision history in V1.
- Use the existing single local DB worker/VFS, including candidate databases where needed; two separately maintained local databases are not a V1 requirement.
- The accepted initial semantic cap is 384 characters of canonical serialized input including its heading, with zero overlap. This is the currently exercised bound, not a claim that characters equal tokens or an ideal chunk size. Current adapters lack an exact tokenizer. Any later cap change requires verified provider limits and relevance-quality evaluation.
- Separate embedding model/output-space identity (verified model identity, dimensions, and provenance) from input-recipe metadata (chunking and semantic-head reconciliation). The exact cache key is the final provider-input bytes digest plus true model/output space, task, and any vector-affecting input/output transform not captured by those bytes. Pure segmentation or recipe-version changes do not force a miss when provider bytes are identical; changed headings/serialization miss when they change those bytes. Preserve the last-complete old-recipe head while refreshing chunks if the verified model space is unchanged; never mix changed model spaces. Current fingerprinting includes normalized-float32 preprocessing/input options rather than a direct chunk-algorithm version. Use the configured versioned model identifier, dimensions, and preprocessing. Do not infer equivalence between opaque aliases or migrate old fingerprints.

### Shared publication and cache lifecycle

- The accepted artifact is immutable, computed-vector cache data only: no FTS state, local note heads, or local IDs. Hard-cap each final exported SQLite binary shard at 4 MiB (4,194,304 bytes), below the documented Sync Standard per-file limit; the exported byte cap, not a vector-row limit, controls shard size. Flush when maintenance completes; zero new vectors is a no-op. These are accepted limits, not measured optima. Confirm plan, provider, and file-type behavior; Sync also has total storage quotas, so sharding does not bypass them. [Obsidian Sync plans](https://obsidian.md/help/sync/plans).
- Build cache-only candidate SQLite databases with known schema and ordinary shape checks; each published shard is a standalone SQLite database whose rows merge independently. Do not split a SQLite file into byte ranges that require full-file reassembly, and do not materialize the full corpus in memory. After writes finish and a candidate is quiescent, compact it with `VACUUM` and export bytes through the VFS. If final exported bytes exceed 4 MiB, split/rebuild into smaller standalone databases before staging; never publish an oversized file. Hash each shard with SHA-256, stage and read back the bytes to compare the hash, then atomically rename into publication. Fold first-seen schema/key/vector validation into row ingestion; do not add a separate full integrity scan, reimport, or deep duplicate pass. SQLite `VACUUM` creates a compact copy; `VACUUM INTO` is an alternative only if packaged SAH VFS support is proven before implementation. Even then, export the copy through the VFS. [SQLite VACUUM](https://www.sqlite.org/lang_vacuum.html).
- On first receipt of an unknown artifact, validate its header/schema, profile, keys, dimensions, and finite vector values before insertion. Merge in a transaction with conflict-safe deduplication and record artifact receipt atomically. Later receipt of the same artifact digest skips repeated merge work. Different artifact byte hashes may still contain logically duplicate vectors, so vector keys must deduplicate independently.
- A hash proves staged bytes match the named artifact; it is not SQL logical-integrity proof, authenticity, or proof of delivery. V1 does not require repeated full `integrity_check`, full rebuildFTS, deep coverage scans, or reimport of every candidate. SQL validity, receipt atomicity, and promotion checks remain required.
- Track artifact receipts against contributed input keys if needed to know when published shared coverage disappears. If an owned contribution file disappears, republish only still-needed active, old-semantic, pending/in-flight document vectors and fresh query vectors; never republish all orphaned cache rows merely because they remain locally stored.
- Accepted bounded compaction runs weekly only when dirty: select either at least eight undersized files (each <=1 MiB) or files with eligible expired rows, and cap captured input at 16 MiB per run. Emit standalone SQLite output shards <=4 MiB; leave already near-full immutable files alone unless they contain eligible expired rows. These thresholds are accepted parameters, not measured optima. Capture exact input digests; publish all replacements before retiring any captured old files, and never delete concurrently arriving uncaptured files. Use per-shard content hashes, not a mutable global manifest. If interrupted, retain old source files; retries are safe through row deduplication. Retire only replaced files after a 30-day grace period. This is limited compaction, not a weekly rewrite/repartition of the full cache. No global delivery acknowledgement is assumed.
- Accepted document-vector pruning age is 30 days after an input is observed unreferenced by current notes, old semantic heads, and active/pending work. Local absence while a device is offline does not prove global obsolescence; occasional re-embedding is accepted. Pruning shared cache must never delete local indexes.
- Accepted query-vector policy: same cache task-kind with query/document task identity kept distinct; 30 days from calculation and at most 1,000 latest query vectors per profile. Receiving a vector does not renew its calculation time. A separate query table is not mandatory. No result lists or lexical cache are shared in V1.
- Accepted profile selection is conservative: normalized endpoint, model ID, dimensions, and vector-affecting provider/output transforms not already captured by final input bytes. This preparation identity excludes chunk segmentation and canonical recipe version when the exact provider-input bytes are unchanged; chunk-recipe metadata remains on semantic heads/blocks, and a same-space old-recipe head can remain searchable during refresh. Keep one active profile per device while allowing offline use. If configured identity matches, use it; if no provider is configured and exactly one compatible imported profile exists, select it automatically; with multiple choices, require a profile selection while keeping lexical search available. Retain unused profiles if useful; never mix profiles. Cross-endpoint model equivalence is not automatic in V1.

### Approved retrieval baseline and remaining quality validation

- Preserve current searchable path terms and their existing weights (body `1`, path `2`, filename `3`). The accepted full-note FTS starting point may add headings at weight `0.5`, avoiding duplicate heading contributions. Do not disable path-only queries or otherwise change existing path-search semantics. These are accepted starting weights, not quality results.
- The approved free-text ranking algorithm remains: reciprocal-rank fusion with `k=60`, top 80 lexical notes and top 80 semantic notes; collapse passages to one candidate per note before fusion, using the maximum compatible passage cosine and retaining its passage as evidence; contribute each note once to semantic rank; and break ties deterministically by note/path/chunk ordinal. These are accepted algorithm requirements, not relevance results. Supersede only obsolete expected ranking outputs: derive and review expected rankings independently from the approved behavior, and never record implementation output as expected output merely to make failures pass. The fixed D5 corpus and its note-count, cold-state, retrieval-sentinel, and publication checks are the benchmark acceptance evidence; they make no claim about relevance quality. Assess human relevance separately.
- Accepted related-note algorithm: generate candidates from the source-note centroid plus three diverse source-block probes, selected deterministically by nearest-centroid then farthest-point selection. Retrieve up to 32 distinct notes per probe and union at most 128 candidates. For reranking, evaluate all compatible distinct semantic passages for each candidate note using the same structural semantic blocks and compatible vectors as free-text semantic search; do not cap eligible passages to the three candidate probes or use an approximate passage subset that changes the exact score. Score each candidate with the symmetric mean of the top two best passage matches in each direction; use the only available match when a direction has one, and deduplicate identical inputs. Free-text search retains its query-to-note maximum-passage cosine, top-80 semantic notes, and hybrid RRF with k=60; the related-note symmetric top-two score is a separate aggregator over the shared passage-scoring foundation. Candidate generation remains bounded and can miss relevant notes; all-passage reranking does not establish bounded interactive latency or mobile performance. Relevance and mobile latency are unmeasured.
- Validate the approved indexing and ranking, chunk cap, and related-note coverage on a small judged corpus that includes specific-topic notes, broad multi-theme reviews, repeated templates, paraphrases, and content-supported bridges. Keep relevance judgments separate from stable Markdown/query/provider fixtures and runtime gates. Do not claim a relevance win or iPhone performance result until measured.

### D5 fixed Obsidian benchmark (approved; supersedes former benchmark workflow)

- Use one pinned generated corpus: 3,000 notes of 400 characters each, 6,000 semantic
  passages with the existing 384-character chunker, and 768-dimensional embedding
  vectors. Apply the same chunking to every note; do not add type-specific chunks.
- For each run, replace only generated Markdown from the prepared corpus, select and
  reload the exact marked benchmark vault, then call the same visible Clear All
  handler in plugin settings or the command palette. It clears local indexes,
  document/query caches, and shared cache files. Ordinary user Reset all indexes
  preserves shared cache. Continue through normal lexical/semantic rebuild, Lente and
  Filo retrieval, publication, and Check handlers; preserve .obsidian settings,
  Trama installation, and vault registration.
- Use only the local HTTP embedding fixture. Do not issue chat requests or switch
  runtimes. Capture existing Performance console records and a compact
  trama-simple-benchmark-report-v1 correctness report. A report is complete only when
  start and end records share the same run ID and the console capture is not truncated.
- The meaningful correctness evidence is note counts, cold-state checks, retrieval
  sentinels, and publication checks. Do not aggregate phase durations into wall time
  or infer timing improvements from them.
- The former small/10k/large profiles and 12-scenario/17-gate workflow are superseded.
  The previous 1,100-note/10,000-passage report is historical only and cannot be
  compared with D5. Two normal D5 runs passed all 12 gates in 53.027s and 56.603s;
  their run IDs and capture evidence are recorded above. No mobile or judged relevance
  result is claimed.

### Scale estimates and operational limits (not measured)

- A raw-vector lower bound is notes × chunks per note × unique-input fraction × dimensions × 4 bytes for float32 vectors; keys, text, SQLite pages/indexes, and other metadata add overhead. With 10 unique 768-dimensional vectors per note, estimates are about 293 MiB / at least 74 files for 10,000 notes, 1.43 GiB / at least 367 files for 50,000 notes, and 2.86 GiB / at least 733 files for 100,000 notes, at a 4 MiB file cap. At 50% unique inputs, vector bytes are roughly half. A 4 MiB shard holds at most about 1,365 raw 768-dimensional float32 vectors before overhead (about 2,730 at 384 dimensions, or 682 at 1,536 dimensions); actual shard counts will be higher. These are arithmetic estimates, not corpus measurements or supported-vault limits.
- Sync plan documentation lists a 5 MB Standard per-file limit and 1 GB total for notes, attachments, and history; Plus lists 200 MB per-file and 10–100 GB total. Validate current account plan, actual provider, and SQLite file-type behavior. A 50,000-note raw-vector estimate alone exceeds Standard total storage. [Obsidian Sync plans](https://obsidian.md/help/sync/plans).
- Lossless compression is an optional transport experiment, not a V1 dependency or assumption: VACUUM removes free pages but is not general-purpose compression; float32 compressibility and resulting size are unmeasured and cannot guarantee the cap. If evaluated, hash the compressed payload and bound decompression. Quantization changes vector values and requires a separate quality evaluation; it is not equivalent to gzip.
- Query-time local cache lookup uses the local indexed database rather than transport files; ingest each shard incrementally and deduplicate in SQL. Receipt/import work scales with delivered files and rows. The 4 MiB limit is per published file, not total cache capacity. There is no measured claim that this design supports a particular “large vault” size.

### Remaining external validation before adoption

- Verify deployed providers expose enough identity/compatibility information to apply the accepted profile rules; treat unproven model equivalence as incompatible. Confirm actual provider limits and tokenizer availability before any cap change. Verify incompatible local schemas rebuild and incompatible shared shards are ignored.
- Validate the accepted SQLite/VFS artifact lifecycle, atomic receipt and merge, bounded batching, compaction/grace behavior, and recovery under delayed or duplicate sync using the unchanged standard runtime and generated-vault safety rules.
- Judge search quality and measure real-device initialization, query, sync, and maintenance costs. The iPhone 12 target and accepted numerical settings remain unmeasured. Physical table/record names are implementation details where the contract marks names illustrative.
