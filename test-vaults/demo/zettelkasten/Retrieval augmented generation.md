---
tags: [ai, conversation]
---

# Retrieval augmented generation

Retrieval augmented generation supplies selected source passages to a model before it answers. The model does not need to memorize the notebook for the conversation to reference it.

There are two separate quality problems. Retrieval must find useful material, and generation must use that material faithfully. A good answer cannot repair missing evidence by sounding confident. Likewise, strong retrieval can still be followed by an inaccurate summary.

I prefer evaluations that inspect both stages. Which passages were selected? Which claims did the answer make? Can a reader verify the connection? This gives a more actionable diagnosis than a single overall impression that the assistant felt clever.

Related: [[Voce grounds a conversation]], [[Retrieval evaluation]], [[Citations are an interface]].
