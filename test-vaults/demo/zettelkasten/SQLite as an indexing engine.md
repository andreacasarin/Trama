---
tags: [sqlite, architecture]
---

# SQLite as an indexing engine

SQLite is more than a file format. It can own relationships, constraints, transactions, and indexed queries that would otherwise become repeated JavaScript loops.

For Trama, the useful boundary is practical: JavaScript reads vault files, parses Markdown, prepares model inputs, and talks to providers. SQLite manages relational state and promotes coherent revisions.

Moving work into SQL is not automatically faster. The benefit comes from bounded operations, appropriate indexes, and fewer round trips. Measurements should include transport and preparation as well as database execution. Otherwise a fast SQL statement can hide an expensive application path around it.

Related: [[SQLite FTS]], [[Worker transport has a cost]], [[Atomic index promotion]].
