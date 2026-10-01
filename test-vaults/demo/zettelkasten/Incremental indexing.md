---
tags: [indexing, performance]
---

# Incremental indexing

Most writing sessions change a few notes, not the entire vault. Incremental indexing records those paths and limits work to the affected material.

A full reconciliation remains useful for recovery, but it should not be the default response to every edit. The difference becomes obvious as the collection grows: reading thousands of untouched files is expensive even before parsing or inference begins.

Rename and delete deserve explicit treatment. A rename changes identity at the path boundary; a deletion must remove searchable occurrences rather than leaving ghost results. I want demo notes that can exercise both actions, while keeping the fixed benchmark mutations separate from presentation edits.

Related: [[Generation fencing]], [[Maintenance without surprises]], [[Bounded batches]].
