---
tags: [architecture, privacy]
---

# Local-first AI

A useful assistant should not require surrendering the notebook that makes it useful. Local-first AI keeps notes and the search index on the device, while letting the owner choose where models run.

For Trama, this means separating storage from inference. SQLite can answer keyword searches without a model server. Embeddings and conversation use the configured provider, with an explicit endpoint rather than an invisible cloud dependency.

Local-first is not the same as offline in every configuration. A remote provider still receives its inputs. The honest promise is control: know which operation needs a model, which text it sends, and which data remains local.

Related: [[journal/2026-09-24|Provider boundaries]], [[SQLite as an indexing engine]], [[journal/2026-09-28|A trustworthy assistant]].
