/**
 * Identity of the SQLite format and the statically bundled runtime.
 *
 * This is deliberately a literal, reviewable value.  It is stored in every
 * database so a synchronized file can never be opened by a different build
 * accidentally.
 */
export const SQLITE_BUILD_IDENTITY =
  "trama-sqlite-schema-15-protocol-13-heads-fullnote-fts5-cache-profiles-retention-compaction-vector-float32-cosine-opfs-sah-v1" as const;

export const SQLITE_SCHEMA_IDENTITY = "trama-sqlite-schema-15" as const;

export { TRAMA_RUNTIME_BUILD_ID } from "./runtime";

export function sqliteBuildIdentity(): string {
  return SQLITE_BUILD_IDENTITY;
}
