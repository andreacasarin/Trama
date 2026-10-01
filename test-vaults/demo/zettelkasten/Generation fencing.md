---
tags: [indexing, concurrency]
---

# Generation fencing

A note can change while an index operation is still processing its previous contents. Without a guard, the slower result could overwrite newer information.

Generation fencing attaches work to the revision it belongs to. When the result returns, the system checks whether that revision is still eligible to become active. An obsolete result is discarded rather than promoted.

This is not only an embedding problem. File reads, chunk preparation, and database staging can all overlap with edits. A test that changes a note during an operation is more revealing than a test that only measures a quiet corpus. Correctness lives at these boundaries.

Related: [[Atomic index promotion]], [[Incremental indexing]], [[Refactoring-resistant tests]].
