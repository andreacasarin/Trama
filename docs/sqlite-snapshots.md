# SQLite publications

Trama's index is a mutable SQLite WASM database backed by the official OPFS SAH
pool. A publication is a closed, consistent copy used to synchronize that index
through Obsidian's `DataAdapter`. It is not a separate search backend, backup
catalog, or recovery mechanism.

## One file and one configured folder

There is exactly one mutable synchronized artifact:

```text
<publicationDirectory>/index.sqlite3
```

The default `publicationDirectory` is the vault-relative folder `Trama/index`,
so the default target is `Trama/index/index.sqlite3`. Settings normalize
backslashes, `./`, empty segments, and whitespace while preserving case.
Absolute paths, drive-letter paths, NUL characters, `.`/`..`, and the vault root
are rejected. Changing the setting creates a new publication target; it does
not move or delete files in the old folder. The active folder is automatically
excluded from Markdown indexing.

All current Trama settings are synchronized for this proof of concept, including
chat/embedding endpoints, model IDs, dimensions, search settings, exclusions,
and approved origins. There is no device-local endpoint override or second
settings store. A loopback endpoint such as `127.0.0.1` normally points to the
device running Obsidian, so it will not reach LM Studio on another device. A LAN
endpoint must be explicitly approved and should be used only on a trusted
network; synchronized settings can otherwise cause another device to trust that
origin. Trama stores no provider credentials.

Temporary staged files are reserved siblings named with the `.trama-tmp-`
prefix. They are read back and byte-checked before replacement, and are never
discovered as publications. Trama does not create or read a manifest, sidecar,
checksum, hash-named file, device head, timestamp ordering, merge catalog,
compressed file, chunked transfer, or `VACUUM INTO` output. The publication ID
inside the SQLite copy is opaque and is used only for equality.

## Publish and adopt

After unified Update or Rebuild converges lexical and configured semantic work,
the maintenance scheduler starts a publication fence. Trama then:

1. prepares a consistent candidate with a fresh publication ID;
2. stages it and validates the read-back SQLite copy;
3. replaces exactly `index.sqlite3`; and
4. stamps the same ID into the live OPFS database before unblocking writes.

A failed or cancelled local operation is not published. A failed publication
does not roll back successful committed local work: the index remains searchable,
the error is displayed, pending intent is preserved, and automatic maintenance is
suspended without a retry timer. A later explicit Update republishes the current
converged state without discarding it. Local index mutations cannot
intervene between copying and ID finalization. The previous vault file is
retained until finalization and restored if that step fails.

On startup, an exact publication-file event, or explicit **Check synchronized file**,
Trama inspects only the exact configured file. A missing file is ignored. A valid file with the same ID is
ignored. Any valid file with a different ID is adopted, regardless of UUID
shape, age, timestamp, local change counter, or perceived ordering. Adoption
does not reconcile Markdown, contact AI, change settings, or publish again.

The synchronized provider therefore chooses the winning file version. The
supported operating model is single-writer-in-time: finish indexing and
publication on device A, wait for Obsidian Sync or iCloud to converge, then
index on device B. Concurrent publication can lose derived work, and a provider
conflict that exposes an older valid corpus may require another Update/Rebuild
and configured semantic work.

## Freshness and compatibility

An adopted database remains searchable immediately and reports **snapshot loaded
— not locally reconciled** until the user explicitly runs Update or Rebuild.
Trama never silently reconciles on adoption. The candidate must match the
current SQLite schema/build/protocol, corpus fingerprint, embedding fingerprint,
dimensions, required FTS/vector invariants, foreign keys, and integrity checks.
Invalid, incomplete, oversized, or incompatible candidates leave the live OPFS
database and its publication ID untouched, with an actionable warning.

Lexical corpus identity includes extraction/chunking parameters and effective
exclusions (including the publication folder), but not embedding endpoint/model
settings. Embedding identity includes the normalized endpoint, model,
dimensions, and preprocessing identity. Changing corpus settings requires
Update/Rebuild; changing embedding settings makes existing vectors incompatible
without removing lexical notes. Keyword search remains available in either case.

## Manual validation (not automated claims)

Automated tests cover the lifecycle with an in-memory adapter and packaged-file
assertions. Real-device validation remains pending:

- clean iOS plugin load and Worker/WASM/SQLite-Vector/OPFS startup;
- offline lexical Build and restart persistence with no publication/provider;
- desktop publication and mobile adoption through both Obsidian Sync and iCloud;
- same-ID ignore, differing-ID adoption, search before reconciliation, and no
  adoption republish;
- mobile-to-desktop publication after sync convergence;
- reachable LAN embedding Update, Hybrid, Filo, and Voce;
- unreachable-AI lexical fallback;
- interrupted, invalid, and incompatible synchronized files;
- sequential device handoff and provider conflict behavior; and
- observed snapshot size, timings, temporary storage, and memory pressure.

Actual iOS, Sync/iCloud, LAN, publication-size, and two-device behavior is
pending user testing and must not be inferred from the automated suite.
