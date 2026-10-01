---
tags: [embeddings, indexing]
---

# Semantic convergence

“Ready” should mean that the configured semantic index has compatible coverage for its eligible inputs. It should not mean merely that the last provider request succeeded.

Preparation can happen in several batches. Notes may change between them, and cached vectors may cover some inputs but not others. Convergence is the point where those pieces agree with the current indexed material.

A status interface should make partial progress legible without promising completeness early. During a model change, I would rather see a clear preparation state and retain useful prior results than watch an optimistic progress bar conceal missing coverage.

Related: [[Embedding model identity]], [[Atomic index promotion]], [[Embedding cache reuse]].
