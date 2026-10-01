---
tags: [indexing, performance]
---

# Bounded batches

Batching reduces repeated overhead, but an unlimited batch simply moves the problem into memory. A useful batch has a bound in bytes as well as a count of items.

A single dense note can contain more text than dozens of short notes. Treating those cases identically makes a note-count limit misleading. Complete-note boundaries also matter when promotion must remain atomic.

The aim is not the biggest possible request. It is steady throughput with understandable memory use, progress, and safe cancellation points. Measurements should include both ordinary notes and unusually large ones, because the latter often reveal assumptions that a tidy demo collection never exercises.

Related: [[Worker transport has a cost]], [[Chunking preserves useful context]], [[Maintenance without surprises]].
