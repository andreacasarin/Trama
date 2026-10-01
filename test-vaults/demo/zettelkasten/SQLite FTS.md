---
tags: [sqlite, lexical]
---

# SQLite FTS

A full-text index maps searchable terms to the passages that contain them. It avoids scanning the complete corpus for every keyword query.

The application still has responsibilities. It must decide which Markdown becomes searchable text, handle query syntax safely, and keep full-text rows synchronized with the active note revisions. A stale FTS entry can be just as confusing as a stale embedding.

The product benefit is simple: a specific word should lead back to a usable excerpt quickly. When demonstrating Lente, I want to search for “publication” and open the source note directly. The mechanism matters because it supports that ordinary interaction reliably.

Related: [[Lexical search remembers exact words]], [[Atomic index promotion]], [[Lente as a search lens]].
