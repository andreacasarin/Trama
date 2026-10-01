---
tags: [embeddings, correctness]
---

# Embedding model identity

Vectors from different models do not automatically share a coordinate system. Equal dimensions are necessary for comparison, but they are not sufficient evidence of compatibility.

An index needs a model identity alongside its cached vectors. Changing the configured model should trigger appropriate new preparation rather than quietly mixing old and new representations.

The same caution applies to a provider that reuses a friendly model name for a different build. Configuration should describe compatibility as precisely as the provider permits. In a demo, I would rather show a clear “preparing semantic index” state than pretend a model switch is instantaneous and harmless.

Related: [[Cosine similarity]], [[Semantic convergence]], [[journal/2026-09-24|Provider boundaries]].
