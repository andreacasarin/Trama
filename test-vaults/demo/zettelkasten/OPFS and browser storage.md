---
tags: [storage, workers]
---

# OPFS and browser storage

The origin private file system gives a browser runtime storage that is not exposed as ordinary user-managed vault files. A SQLite database can use that space while the visible notes remain Markdown.

This distinction matters for diagnosis. The local working index and a synchronized publication are different objects with different lifecycles. Finding a publication file in the vault does not prove that the current working database has adopted it.

For benchmarks, a fresh storage identity helps avoid accidentally measuring reuse from an earlier run. For everyday use, persistent identity lets the index survive reloads. Both behaviors should be explicit in the report or the interface.

Related: [[Publication is a coherent snapshot]], [[Deterministic benchmark fixtures]], [[Local-first AI]].
