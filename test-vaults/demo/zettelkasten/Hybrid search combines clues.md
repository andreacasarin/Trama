---
tags: [search, hybrid]
---

# Hybrid search combines clues

Hybrid search combines two kinds of evidence: words that match and meanings that resemble the question. Neither signal has to win every time.

A query about “finding ideas without remembering their wording” benefits from semantic similarity. A query containing a specific API name benefits from lexical precision. Real questions often contain both: an exact product term inside a loosely expressed need.

Combining candidates requires care. Lexical scores and vector similarities live on different scales, so simply adding raw scores can give a misleading ranking. Whatever combination a system uses, its behavior should be tested against fixed examples rather than judged by an appealing screenshot alone.

Related: [[Ranking is a product decision]], [[Lexical search remembers exact words]], [[Embeddings represent meaning]].
