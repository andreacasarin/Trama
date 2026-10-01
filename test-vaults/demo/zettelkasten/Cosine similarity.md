---
tags: [embeddings, mathematics]
---

# Cosine similarity

Cosine similarity compares the direction of two vectors. It divides their dot product by the product of their lengths. For nonzero vectors, values closer to one indicate more closely aligned directions.

This is convenient for embeddings, but the number is not a probability that a note is relevant. Its interpretation depends on the model, the input text, and the other candidates in the collection.

A practical search interface should not ask users to interpret bare floating-point scores. The meaningful question is whether the top passages help with the task. I want readable excerpts and a consistent ordering before I want a numeric similarity badge.

Related: [[Embeddings represent meaning]], [[Ranking is a product decision]], [[Retrieval evaluation]].
