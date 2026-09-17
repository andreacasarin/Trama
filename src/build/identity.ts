/**
 * Identity of the SQLite format and the statically bundled runtime.
 *
 * This is deliberately a literal, reviewable value.  It is stored in every
 * database so a synchronized file can never be opened by a different build
 * accidentally.
 */
export const SQLITE_BUILD_IDENTITY =
  "trama-sqlite-schema-5-protocol-4-fts5-vector-float32-cosine-opfs-sah-v1" as const;

export const SQLITE_SCHEMA_IDENTITY = "trama-sqlite-schema-5" as const;

export function sqliteBuildIdentity(): string {
  return SQLITE_BUILD_IDENTITY;
}
