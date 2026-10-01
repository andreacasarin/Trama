---
tags: [search, lexical]
---

# Lexical search remembers exact words

Keyword search is excellent when the clue is an exact term: OPFS, a function name, or the title of a decision. Those tokens can carry more intent than a semantic model recognizes.

SQLite full-text search provides an inverted index rather than asking JavaScript to scan every note. The important work becomes preparing searchable text and constructing a query that behaves predictably.

Lexical retrieval is not a fallback to be embarrassed about. It is a distinct tool with a useful strength. A demo should include a technical acronym as well as a paraphrased question, so people can see why both lexical and semantic search belong in the same notebook.

Related: [[SQLite FTS]], [[Hybrid search combines clues]], [[Lente as a search lens]].
