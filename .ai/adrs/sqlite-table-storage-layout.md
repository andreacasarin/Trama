# ADR: SQLite table storage layout

- Status: Accepted (extracted from the note-index ADR; no new decision)
- Recorded: 2026-10-19
- Related: [LangChain and SQLite note index](langchain-sqlite-note-index.md)

## Context

`WITHOUT ROWID` avoids a separate rowid index for some non-integer keys, but large vector BLOBs have different storage costs from small UID and receipt rows. A global rowid policy is inappropriate for this schema. Keep centroids because related-note scoring uses them and multiple chunk vectors per note remain supported.

## Decision

| Table                                 | Storage                                        | Reason                                                                    |
| ------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| `note_index`                          | Ordinary rowid; integer primary key            | Keep centroid and note metadata together.                                 |
| `note_vectors`                        | Ordinary rowid; composite key constraints      | Large vector BLOB rows benefit from this layout on the measured workload. |
| `note_records`                        | `WITHOUT ROWID`                                | Small metadata rows keyed by text UID.                                    |
| `note_record_clock`                   | Ordinary rowid; singleton integer primary key  | Integer primary key already aliases rowid.                                |
| `note_fts`                            | Native FTS5 virtual-table storage              | Keep the contentless lexical index.                                       |
| `embedding_cache`                     | Ordinary rowid; unique `(profile, task, hash)` | Float32 vector BLOBs, with a partial age index for local query retention. |
| `embedding_cache_sqlite_imports`      | `WITHOUT ROWID`; `(profile, checksum)`         | Small receipt rows with a composite key.                                  |
| `embedding_cache_sqlite_publications` | `WITHOUT ROWID`; `(profile, hash)`             | Small receipt rows with a composite key.                                  |
| Shared-shard vectors                  | Ordinary rowid; unique content hash            | Large Float32 vector BLOBs, without changing cache identity.              |

Keep the existing centroids, vector payloads, logical keys, constraints, and SQL scoring. No migration or automatic reset is introduced: `CREATE TABLE IF NOT EXISTS` does not convert an existing table.

## Rationale and evidence

In the paired fresh 3,000-note experiment dated 2026-10-12, using the same corpus and deterministic zero-delay 768-dimensional provider, removing `WITHOUT ROWID` only from `note_vectors` reduced exported size from 41,312,256 to 25,583,616 bytes (38.1%) and eliminated vector overflow pages. The centroid-bearing `note_index` and vector payload were unchanged. The 3,000-note profile used three samples after one warmup. This is workload-specific evidence, not a general claim that rowid is faster or smaller.

The historical source was `docs/langchain-performance-assessment.md`, “Vector rowid experiment — 2026-10-12.” The paired fresh-database experiment retained the centroid-bearing `note_index` and vector payload; its measurements above are workload-specific, not a general performance claim. See [SQLite's storage tradeoffs](https://www.sqlite.org/withoutrowid.html).

## Consequences and reconsideration

Fresh databases use the selected layout; existing databases can retain their earlier layout. Storage comparisons must record how the database was created. Reconsider individual tables when representative BLOB sizes, key sizes, or access patterns change; do not replace logical IDs or remove centroids merely to impose a uniform layout.
