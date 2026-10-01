---
tags: [testing, engineering]
---

# Refactoring-resistant tests

A test survives refactoring when it protects behavior rather than the current arrangement of helper functions. For Trama, a lifecycle test can build an index, change notes, retrieve results, and validate publication through stable boundaries.

This does not make every small test redundant. Query-plan checks, validation tests, and concurrency regressions can protect properties that an end-to-end happy path would miss.

The practical aim is a small set of distinct guarantees. When two tests exercise the same failure and assert the same outcome, duplication may be removable. When they cover different risks, calling one “unit” and the other “integration” does not settle the decision.

Related: [[Generation fencing]], [[Deterministic benchmark fixtures]], [[Retrieval evaluation]].
