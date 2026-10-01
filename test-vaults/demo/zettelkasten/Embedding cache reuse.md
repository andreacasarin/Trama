---
tags: [performance, embeddings]
---

# Embedding cache reuse

The fastest embedding request is the one that does not need to happen. Reusing vectors for unchanged exact inputs reduces latency, provider load, and unnecessary network traffic.

Caching does not mean that all semantic work disappears. The index still has to discover eligible inputs, check compatibility, and connect reusable vectors to the current note revisions. A cached pass can therefore take time while making zero provider calls.

That is an important distinction in a performance report. “Semantic preparation” includes more than inference. I want separate timing for input preparation, provider work, and commit, so a slow cached run points toward the index rather than blaming the model.

Related: [[Exact embedding inputs]], [[Structured timing events]], [[Semantic convergence]].
