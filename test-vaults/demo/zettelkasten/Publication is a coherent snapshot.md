---
tags: [storage, synchronization]
---

# Publication is a coherent snapshot

A publication packages one consistent view of the local index for later adoption. It is not a dump of whichever tables happen to be available halfway through an update.

Coherence means that active note revisions and compatible vector coverage belong together. Validation should happen before a snapshot is treated as usable, and adoption should not replace the live database during conflicting maintenance.

An in-memory publication is useful for measuring preparation and adoption without filesystem noise. It does not measure synchronization or disk write costs. Reports need that boundary spelled out, especially when results will inform a public performance claim.

Related: [[Atomic index promotion]], [[OPFS and browser storage]], [[journal/2026-09-26|Honest performance claims]].
