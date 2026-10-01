---
tags: [testing, performance]
---

# Deterministic benchmark fixtures

A stable benchmark changes the implementation while holding the workload still. The notes, mutations, queries, and provider responses should not be rewritten to suit each new optimization.

Deterministic embeddings remove model-server variability from a lifecycle measurement. They test orchestration and storage, not the relevance quality of a real embedding model. That limitation belongs beside the numbers.

Demo notes have a different job. They should feel like a notebook someone would actually use, and their examples should be readable in screenshots. Separating the two collections lets us improve the presentation without corrupting the evidence used to compare implementations.

Related: [[Retrieval evaluation]], [[Structured timing events]], [[journal/2026-09-30|A useful demo sequence]].
