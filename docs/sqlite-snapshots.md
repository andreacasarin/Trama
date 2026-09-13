# SQLite snapshots

Snapshots are explicit maintenance backups for the mutable SQLite index. Trama
does not create them automatically, scan for them at startup, or use them for
publication or crash recovery.

Export briefly marks the index busy, drains serialized SQLite work, exports the
database, reopens and checks it, then verifies the SHA-256 digest on the main
thread. The immutable artifact is written through the vault adapter at
`.trama/sqlite/v1/snapshots/<sha256>.sqlite3`; its optional sidecar contains
only size, schema, dimensions, digest, and the incomplete flag.

Import is explicit and bounded at 2 GiB. The selected bytes are checksum- and
size-checked, loaded into a temporary SQLite database, and checked for
application/schema/backend compatibility, dimensions, SQL/FK/FTS integrity,
and vector consistency before the live database is replaced. A successful
import always reopens with `incomplete=1` and a strictly advanced change
counter. Users must run **Update index** or **Rebuild index** to reconcile it.

Failed validation before replacement leaves the live index untouched. During
maintenance search and new indexing work report a retryable busy status. Error
messages are deliberately metadata-only and do not include snapshot bytes,
paths outside the fixed namespace, hashes, note identities, SQL, text, or
vectors.
