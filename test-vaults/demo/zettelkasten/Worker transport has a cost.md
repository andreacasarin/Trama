---
tags: [performance, workers]
---

# Worker transport has a cost

A Worker keeps database activity away from the interface thread, but communication is not free. Requests must be prepared, transported, dispatched, and answered.

If a lifecycle sends thousands of tiny messages, transport overhead can outweigh the SQL work inside each one. Bounded batches reduce that repetition while still allowing progress and cancellation at useful boundaries.

Startup has its own boundary. The application may send a handshake before a dynamically imported Worker module is ready to receive it. Buffering those early messages avoids a timeout that looks like a broken installation even though the packaged files are correct.

Related: [[Bounded batches]], [[Structured timing events]], [[SQLite as an indexing engine]].
