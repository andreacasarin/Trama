---
tags: [retrieval, evaluation]
---

# Ranking is a product decision

Ranking decides what the reader notices first. It turns a set of plausible candidates into an experience, so its quality cannot be judged only by mathematical elegance.

Technical notes often reward exact terminology. Reflective journal entries may reward broader conceptual similarity. A ranking strategy should be tested across both instead of tuned to one flattering example.

Stable tie behavior matters too. If equivalent candidates reorder unpredictably, comparisons become noisy and the interface feels less dependable. For performance experiments, the output oracle should pin the expected order independently of timing. Faster retrieval is valuable only when it still returns the intended material.

Related: [[Hybrid search combines clues]], [[Retrieval evaluation]], [[Deterministic benchmark fixtures]].
