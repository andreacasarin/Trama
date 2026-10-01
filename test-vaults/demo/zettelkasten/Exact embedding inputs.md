---
tags: [embeddings, caching]
---

# Exact embedding inputs

An embedding cache should be keyed by the text actually sent to the model, not by a convenient approximation such as the note's modification time.

If a title or heading is included in the model input, changing it can change the vector even when the paragraph stays the same. Conversely, reopening a file or touching its timestamp should not force another provider call when the input bytes are unchanged.

This distinction makes cache behavior understandable. We can explain reuse in terms of exact input and model identity rather than hidden heuristics. It also gives benchmarks a concrete invariant: an unchanged semantic pass should do no new embedding work.

Related: [[Embedding cache reuse]], [[Embedding model identity]], [[Chunking preserves useful context]].
