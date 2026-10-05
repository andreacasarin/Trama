/**
 * Identity of the SQLite format and the statically bundled runtime.
 *
 * This is deliberately a literal, reviewable value.  It is stored in every
 * database so a synchronized file can never be opened by a different build
 * accidentally.
 */
export const SQLITE_BUILD_IDENTITY =
  "trama-sqlite-schema-14-protocol-12-heads-fullnote-fts5-cache-profiles-retention-compaction-vector-float32-cosine-opfs-sah-v1" as const;

export const SQLITE_SCHEMA_13_BUILD_IDENTITY =
  "trama-sqlite-schema-13-protocol-12-heads-fts5-cache-profiles-retention-compaction-vector-float32-cosine-opfs-sah-v1" as const;

export const SQLITE_SCHEMA_12_BUILD_IDENTITY =
  "trama-sqlite-schema-12-protocol-11-heads-fts5-cache-profiles-query-vectors-vector-float32-cosine-opfs-sah-v1" as const;

export const SQLITE_SCHEMA_11_BUILD_IDENTITY =
  "trama-sqlite-schema-11-protocol-10-heads-fts5-cache-shards-vector-float32-cosine-opfs-sah-v1" as const;

export const SQLITE_SCHEMA_10_BUILD_IDENTITY =
  "trama-sqlite-schema-10-protocol-9-heads-fts5-vector-float32-cosine-opfs-sah-v1" as const;

export const SQLITE_SCHEMA_9_BUILD_IDENTITY =
  "trama-sqlite-schema-9-protocol-9-heads-fts5-vector-float32-cosine-opfs-sah-v1" as const;

export const SQLITE_SCHEMA_IDENTITY = "trama-sqlite-schema-14" as const;

export { TRAMA_RUNTIME_BUILD_ID } from "./runtime";

export function sqliteBuildIdentity(): string {
  return SQLITE_BUILD_IDENTITY;
}
