---
tags: [ux, indexing]
---

# Maintenance without surprises

Background indexing is helpful only when it behaves predictably. It should respect consent, avoid overlapping operations, and give Stop a meaning that users can trust.

A quiet window lets a burst of edits settle before maintenance begins. A deadline prevents continuous activity from postponing useful work forever. These are scheduling decisions, distinct from the narrow functions that perform lexical preparation, embeddings, or publication.

Failure should be visible rather than creating an invisible retry loop. In a demo, I want to show Update, progress, and a clean stopped state. The interface is explaining ownership: the user decides when model-backed work is allowed to proceed.

Related: [[Incremental indexing]], [[Bounded batches]], [[journal/2026-09-28|A trustworthy assistant]].
