# ADR: Automatic indexing and settings changes

- Status: Accepted (extracted from the note-index ADR; no new decision)
- Recorded: 2026-10-19
- Related: [LangChain and SQLite note index](langchain-sqlite-note-index.md), [embedding cache and Clear](embedding-cache-sharing-and-clear.md)

## Context

Keep an initialized local index and published embedding cache current without restoring the legacy maintenance scheduler or a second indexing lifecycle. Fresh or explicitly cleared indexes must wait for manual initialization. Settings should follow Obsidian's plugin-settings sync rather than a custom transport.

## Decision

### Scheduling and eligibility

After workspace layout readiness, make one eligible automatic attempt. Coalesce relevant Markdown create/modify/delete/rename events for 20 seconds, and use a registered five-minute backstop for missed changes and shared-cache arrivals. All triggers reuse the same cache import, LangChain `index()`, full cleanup, and final publication path as manual Update.

Derive eligibility from local SQLite `note_index` contents on initialization/reconfiguration and after successful indexing. Fresh, cleared, and empty indexes remain paused across restarts until manual Update/Rebuild creates notes. Do not add a persisted or synced pause flag. Keep manual Update/Rebuild/Stop/Clear available.

Run only one index operation at a time. Coalesce at most one pending event during a run and follow it only after success. Failure, Stop, Clear, and unload discard pending work without immediate restart; unload cancels the debounce timer. A later eligible trigger may retry. Edits made during a run wait for a later successful update. This introduces no other scheduler, provider retry loop, or background maintenance path.

### Settings and invalidation

Store all plugin settings, including model IDs and dimensions, in `data.json`. User-enabled Obsidian plugin-settings sync carries them; the external-settings-change hook reloads normalized settings and reconfigures services. Do not build a separate settings transport or share credentials through cache files.

With an existing local index or active indexing run, ask before saving a local change to the effective embedding endpoint, model, or dimensions. Cancel preserves settings and data without stopping the active run. Save changes saves and recommends **Clear index and embedding cache**, followed by manual Update/Rebuild; it never clears automatically. First configuration, an idle empty index, chat-only changes, and equivalent effective embedding settings do not prompt. Retain synced changes and show nonblocking advice only. A pending accepted confirmation survives closing settings, but stale confirmations cannot overwrite externally replaced settings.

Folder exclusions apply to selected folders and their descendants during note enumeration and reads. `Projects` does not match `ProjectsArchive`. Persist changes automatically; the next successful manual or automatic Update/Rebuild removes excluded indexed records through native full cleanup. Until then, prior indexed results remain available. Exclusions do not purge embedding-cache artifacts or restrict attachments.

## Rationale

One pipeline and one coalesced pending event minimize owned scheduling code. Local note existence supplies the pause condition without additional schema or sync state. The backstop also discovers shared files without a new watcher or uploader. Confirmation and advice make stale-index implications visible while leaving destructive cleanup optional.

## Consequences and reconsideration

Eligible automatic runs can call the configured provider on cache misses; complete cache hits can work offline. A device can use shared vectors with the same model/dimensions even when the provider is unavailable, but a miss stops indexing rather than introducing lexical-only writes or a separate retry engine. Vault-sync and plugin-settings sync require the user's configuration; they are not live cross-device validation guarantees.

Reconsider debounce/backstop values or eligibility only with measured workloads or changed product requirements. Preserve the single LangChain lifecycle and explicit Clear semantics.
