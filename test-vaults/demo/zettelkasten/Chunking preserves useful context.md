---
tags: [indexing, markdown]
---

# Chunking preserves useful context

A long note rarely discusses only one thing. Splitting it into passages lets retrieval return the relevant section rather than treating the entire document as one topic.

The challenge is preserving context. A sentence under a heading may depend on that heading. A code block should not be split into fragments that lose their meaning. Very small chunks can become ambiguous; very large ones can bury the useful detail.

For a personal notebook, Markdown structure is a helpful starting point. Headings, paragraphs, and complete blocks carry the author's own organization. Chunk boundaries are therefore part of retrieval behavior, not merely a storage optimization.

Related: [[journal/2026-09-23|Markdown is structured input]], [[Exact embedding inputs]], [[Retrieval evaluation]].
