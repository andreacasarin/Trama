---
tags: [diagnostics, performance]
---

# Structured timing events

A useful timing event names the operation, its phase, and the duration. Correlation identifiers make it possible to follow one lifecycle across application code and Worker messages.

Tags let the same logging interface serve different needs. Performance mode can collect phase measurements without emitting every detailed payload. Detailed mode adds the context needed to investigate behavior that appears only in live usage.

The important architectural choice is measuring in production code. A thin benchmark harness then supplies fixtures and collects events instead of maintaining a second interpretation of where each phase starts and ends. That makes the measurements useful beyond a laboratory run.

Related: [[Embedding cache reuse]], [[Worker transport has a cost]], [[journal/2026-09-26|Honest performance claims]].
