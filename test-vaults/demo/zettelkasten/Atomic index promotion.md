---
tags: [indexing, correctness]
---

# Atomic index promotion

Updating an index should not expose a half-built revision to readers. New data can be staged, checked, and then promoted as one coherent change.

The useful mental model is a handover. Search continues to see an established revision while the next one is prepared. At promotion, the new revision becomes authoritative without a period where counts, passages, and vectors disagree.

This is especially valuable when semantic work lags behind lexical work. A readable prior semantic head is better than incomplete new coverage pretending to be ready. Performance changes must preserve this handover, not merely make the happy-path build finish sooner.

Related: [[Semantic convergence]], [[Generation fencing]], [[Publication is a coherent snapshot]].
