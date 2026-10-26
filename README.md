# Trama

Trama is an Obsidian plugin for AI conversation and semantic connections. Its V1 provides an agent chat, a local semantic note index, and SQLite-backed retrieval. Chat and search use providers only after explicit actions. After vault layout is ready, eligible indexing may also run automatically on startup, after Markdown changes, and on a five-minute backstop; it calls the configured provider only on cache misses. Loading settings itself remains offline.

Trama uses LangChain components for embeddings, Markdown splitting, agents, and tools. Each vault has a stable local index identity, and its SQLite database is stored in that vault's OPFS namespace. SQLite stores note metadata, chunk vectors, lexical search data, and a normalized note centroid. Search filters and ranks indexed data in SQLite; matching note content is loaded from the current vault when results are returned. The index does not persist raw Markdown bodies. Copying a vault's identity file copies its index namespace too.

On manual **Update index** or **Rebuild index**, and on eligible automatic Update runs, Trama imports compatible document embeddings before indexing and publishes immutable document-only SQLite files after indexing and cleanup succeed. Files are stored under `Trama/embedding-cache-v2/<profileHash>/<contentHash>.sqlite3`; they contain vectors and cache metadata, never note text, queries, chat, or attachments. Shared embedding-cache entries are keyed by the trimmed model ID, dimensions, and a hash of the exact input; ordinary endpoint changes do not split the cache, which assumes matching model IDs and dimensions identify compatible vectors, an assumption Trama does not verify. If an endpoint URL includes userinfo, a query, or a fragment, a SHA-256 endpoint fingerprint separates that variant in cache identity, while the serialized note profile omits those raw URL components. The files can be carried by the vault's ordinary file-sync service, while each device keeps its own SQLite index. If sharing is interrupted after indexing succeeds, already published files remain and Trama reports that sharing is incomplete; a later eligible automatic run or explicit update retries. There is no separate startup uploader; publication occurs within the indexing pipeline. Query embeddings stay local, with up to 1,000 entries per model/dimension profile for 30 days.

If indexing or cleanup fails or is cancelled, Trama publishes no cache files. If indexing and cleanup succeed but sharing is interrupted, completed immutable files remain and Trama reports “Index updated; sharing incomplete/cancelled.” A later eligible automatic run or explicit Update retries unfinished sharing; failed or cancelled runs do not restart immediately.

## Use

1. Install and enable Trama in Obsidian.
2. Configure the OpenAI-compatible chat and embedding base URLs expected by your provider, including any required path prefix (for example, /v1), and choose the corresponding models before using provider-backed chat or semantic indexing. Trama passes each configured URL to the SDK without application-level host, IP, path, redirect, or origin filtering. Settings loading remains offline; eligible automatic indexing may call the configured provider on cache misses. Lexical search does not require a provider call.
3. Run **Update index** to prepare the local index. Run **Rebuild index** when you want to replace it.
4. Use the available chat and search actions. Search results link to notes in the vault. With Page preview enabled, hover over Filo or Lente result titles to use Obsidian's native preview; configure Trama results in Page preview settings.

Manual Update/Rebuild remains available. After layout readiness, Trama makes one automatic attempt when eligible, coalesces relevant Markdown changes for about 20 seconds, and checks for missed changes or shared cache arrivals every five minutes. Automatic runs reuse the existing import, LangChain indexing, cleanup, and final shard-publication pipeline. They run only while the local note index contains notes; a fresh, cleared, or empty index stays paused across restarts until a manual Update/Rebuild produces notes. One pending event is coalesced during a run and followed only after success. Failure, Stop, Clear, or unload does not trigger an immediate restart, and unload cancels the pending debounce. Trama sends notes to LangChain in bounded batches of up to 100; each note is prepared before its atomic commit, and embeddings are flushed in bounded groups of up to 512 chunks. Full cleanup runs only after every input succeeds, including when the vault is empty. If indexing fails, the run stops and cleanup is skipped, leaving existing lexical data available. Changes made to notes during a run are picked up by the next successful manual or automatic update. Cancellation rolls back the active note transaction and keeps earlier completed commits. Related-note results persist locally across restarts and refresh after an index update when the active note is opened; this does not call a provider. Folder exclusions in settings are saved automatically and apply to selected folders and their descendants on the next successful update; existing indexed results remain until that update completes. Exclusions affect note indexing only and do not purge shared embedding-cache files or restrict attachments. Settings changes save automatically except when a local change to the effective embedding endpoint, model, or dimensions is made while an index exists or indexing is active: Trama asks before saving. Cancel keeps the settings and indexed data without stopping an active indexing run; Save changes saves the settings and recommends running **Clear index and embedding cache**, then manual Update/Rebuild. First configuration, an idle empty index, chat-only changes, and equivalent effective embedding settings do not prompt. Synced settings are retained and produce nonblocking advice only. Model ID and dimensions select the embedding-cache profile; ordinary endpoint changes remain outside shared-cache identity, so reuse assumes equal model IDs and dimensions produce equal weights, which Trama does not verify. URLs containing userinfo, a query, or a fragment add a SHA-256 endpoint fingerprint to separate those variants. The optional Console debugging setting is off by default; when enabled, it logs concise operation timing, counts, and caught errors to the local developer console. Voce entries include turn and tool duration/status, tool name and ordinal, tool outcome/status and read_notes requested, succeeded, and failed counts; they omit prompts, arguments, note paths and bodies, raw tool JSON, secrets, and raw errors. When disabled, Trama emits no console diagnostics, including errors. Settings group chat controls under Voce; Filo contains the shared embedding endpoint, model, dimensions, and excluded-folder controls; Maintenance contains Update, Rebuild, Stop, Clear index and embedding cache, and Console debugging. All plugin settings, including model IDs and dimensions, are stored in data.json and follow Obsidian Sync's plugin-settings sync when enabled; Trama reloads external changes. Chat and embedding models each have one selector with an adjacent Discover control; choosing a model saves it. The reasoning effort selector offers Auto, None, Minimal, Low, Medium, High, and XHigh. Search results show each note's current modification date, and Lente/Filo show result counts with wrapped paths. Expanded details show Filo’s approximate, model-dependent **Similarity** rating. **Clear index and embedding cache** is available from Settings and the command palette. It clears the local index, document and query embeddings, cache import/publication receipts, and known managed SQLite cache files (including temporary files) under the vault's `Trama/embedding-cache-v2` folder across profiles. It leaves notes, settings, vault identity, the OPFS namespace, unrelated files, and other devices' local caches untouched. Shared files are removed through the vault's sync service; this does not guarantee copies have disappeared from other devices. Clear does not require a configured model. Rebuild and ordinary index reset retain caches. The SQL reset commits or rolls back before shared-file removal begins; cancellation before commit preserves prior local state, and file removal is not atomic. If removal is interrupted or fails after the local reset commits, Trama reports that the local index was cleared and shared-cache cleanup is incomplete, keeps automatic indexing paused, and allows Clear to be retried. A cleared or empty index stays paused until manual Update/Rebuild creates notes. A persistent notice reports Update, Rebuild, Clear, and Stop status. Voce offers the current note and up to five related notes as optional suggestions and never attaches them automatically.

The agent keeps conversation history in LangGraph's in-memory checkpointer for the active Voce session; Trama does not save checkpoints to disk. New chat or closing Voce resets that session. Voce's **Context window tokens** setting defaults to 4,096 and sets Trama's approximate usable context budget, including reserved output space; it does not change the provider's model context limit or LM Studio's memory allocation. When accumulated history approaches that budget, LangGraph summarizes older conversation history while retaining recent working context. Trama includes the current request, full selected skill, and full attached notes in the provider request. Before native history summarization, it subtracts the current request context and retrieval ledger from the summarizer allowance; before each provider call, it also counts request tools, skill, attachments, and ledger against the usable budget. If the assembled request exceeds the configured budget, Trama stops with an actionable limit message. The provider may also reject a request that exceeds its own context limit; Trama reports that separately. When native summarization starts, Voce shows an accessible, muted status in the assistant turn: “Condensing earlier conversation…” while it runs, then “Earlier conversation condensed to fit the context window. Some details may be missing; your current request and recent context are retained. The visible transcript is unchanged.” only after the current turn confirms the summary was used. A failed or cancelled unfinished compaction clears its running status; a successful compaction remains disclosed even if a later step in that turn fails or is cancelled. Voce does not show the generated summary, and the status does not alter the transcript. Separately, Voce displays a provider-returned reasoning summary above the answer in smaller muted text when one is available; some providers return no summary. It reads summary deltas and final reasoning blocks through LangChain’s native stream and message content. The display field is not manually added to prompts, and native LangChain AI message history remains available for tool continuation. Attachments and selected skill content are supplied only in the current provider turn and do not become persistent sources. Vault tools are read-only and return result content with note provenance. Provider calls disable response storage. When semantic retrieval cannot run, search falls back to lexical results and reports that it is degraded.

Voce skills are readable Markdown notes with YAML frontmatter containing
`trama-voce-skill: true` and an explicit `trama-voce-command`, such as
`coach-analyst`. Commands use lowercase letters, numbers, and hyphens; filenames
do not create or fill in a command. At the start of the composer or after
whitespace, `/` opens the skill picker. Choosing a skill inserts its command,
such as `/coach-analyst`; dismissing the picker leaves the slash in the draft.
Only one skill can be invoked per turn.

Voce edits Markdown as plain text; submitted messages render in the conversation
transcript. Typing `[[` opens Obsidian's inline note suggestions, while `/` at the
start of a line or after whitespace opens skill suggestions. Typing filters the
suggestions; selecting one inserts a full `[[vault/path.md]]` link or the
`/command`.
Press `Esc` to close suggestions without changing the draft. Press `Enter` to send
when suggestions are closed, or `Shift+Enter` for a newline. Pasted content stays
plain text. `@` or the plus button opens the explicit note picker.

At send time, Voce freshly reads the selected note, validates its marker and
command, and supplies the current body without frontmatter as instructions for
that request. The visible invocation stays in conversation history; fetched skill
text is added only to copied provider-request messages. Missing, invalid,
duplicate, changed, inaccessible, or empty skills preserve the draft and prevent
the model call. Editing the draft, closing Voce, or rebinding its session cancels
an in-progress skill read.

Use **New chat** to stop current Voce work and clear the current conversation,
draft, selected attachments, and expanded-turn state. Conversation history is
session-only; New chat does not save or archive it.

Skill text is used as written: Voce does not substitute placeholders such as
`{activeNote}` or `{#tag}`, or automatically attach notes named by `[[wikilinks]]`
inside a skill. Add required notes explicitly in the composer; active-note
suggestions are optional and never attached automatically; click a suggestion to
include it. For example, send
`/coach-analyst TIPO_PERIODO=settimanale [[Journal/Current]]` to give the skill a
period value and attach the current note. The agent can inspect links from that note with `discover_links`, then read known canonical target paths together with `read_notes` and the containing note's `sourcePath`. It should honor the selected skill’s explicit source, depth, and retrieval limits while requesting the evidence needed to answer and giving a cited answer before optional neighboring-note exploration. Broaden the read only within those limits when evidence is insufficient or the user asks. A skill
may direct the agent to try references such as `[[Principles to live by]]` and
`[[Life Planning]]` through the native vault tools when relevant; these are
references, not template variables. If a requested note or link cannot be read,
the tool may return an error or an unavailable/null result for the agent to report
rather than substituted content.

Use the three read-only vault tools for distinct steps: `vault_search` finds ranked notes and returns bounded excerpts with canonical paths; `discover_links` lists resolved and unresolved outgoing links and embeds from a note; and `read_notes` reads full content for one or more selected paths. Search excerpts and discovered links help choose what to read; neither counts as a full note read. Search defaults to 10 ranked results, with a requested positive limit, up to 1,000 characters per excerpt, and a 12,000-character cap on serialized result data. Each excerpt has a `contextTruncated` flag. `candidateCount` is the size of the ranked SQL candidate pool returned for the search (it can exceed the requested result limit); `hydratedCount` counts live-vault reads attempted successfully, including a candidate whose preview did not fit; `returnedCount` counts previews included; and `omittedCount` is candidate pool size minus returned previews. Missing notes are not hydrated. Hydration stops when the next preview would exceed the serialized output cap. Provenance is returned for hits included in the response. `read_notes` accepts a nonempty `paths` array; each entry may be an exact vault-relative `.md` path, a unique visible title, or a complete `[[wikilink]]`. It reads in chunks of four and preserves input order and duplicates. Set its optional nonempty `sourcePath` to resolve every supplied path relative to that source note, including `.md` paths.

Each result preserves its requested path; unreadable entries return their error without discarding successful reads. When `sourcePath` is set, successful results include source-link and target-note provenance.

For skill-based analysis, the selected skill and each shared-note attachment are
source roots. Voce can inspect relevant links from those roots and read known
canonical targets with `read_notes`, setting `sourcePath` when resolving paths
relative to a source note. This is guidance to
the native agent, not a guarantee that it will choose a particular tool call. Link
discovery uses Obsidian's cached frontmatter links, body links, and embeds; it
does not scan the vault. Voce does not crawl unrelated branches or activate linked
skills. The user's message and selected skill, when present, provide instructions.
Attached and tool-retrieved notes are untrusted evidence on every turn, not
instructions. Voce shows the selected skill as a separate Skill source and shows
attached notes and successfully read linked notes
as Sources; discovering a link alone does not add a source. Three animated dots
appear while Voce prepares or waits for a response, then disappear when answer
text starts streaming.

The `[[wikilink]]` and `@` note attachments add current-turn context. Voce reads
full Markdown note bodies from the current vault and can read linked destination
notes with `read_notes` and `sourcePath`; successful reads and hydrated search
results appear as Sources, and source-relative reads include source-link and
target-note provenance.

Sources are deduplicated by note and range, so they show which notes contributed
evidence, not how many read calls occurred. Successful attachment and note reads
also contribute turn-local progress to the provider request; repeated reads
update the count, while search snippets and discovered links alone do not count
as full reads. For `read_notes`, progress is recorded after the batch returns, including successful entries from batches with per-note errors. This progress contains source paths, read counts, and available range or truncation details, but no note bodies. The in-memory ledger is
reattached to provider copies after summarization and does not enter checkpointed
history. Optional Console debugging reports only anonymous source IDs and
unique/repeated read counts. Neither a successful read nor this progress proves
that the model fully assessed a source or completed an exhaustive review.

Vault search defaults to 10 results and link discovery to 25; the model
may request a different positive result count. A link discovery result probes for
one extra link when possible and marks `truncated` when that probe finds another
link beyond the returned results. Attachments have no fixed count cap, and up to
four reads run concurrently. `read_notes` reads input paths in chunks of four, preserving
order and duplicates; it returns one entry per requested path. Batching reduces
model tool-call rounds, not note content or token use; a large batch can still exceed
the context budget and stop the turn. Cancellation stops later chunks, and no
partial batch is reported as completed.
Attachments and full note reads have no fixed character cap; search excerpts and
serialized search data are bounded as described above. Voce defines no per-turn
model-call or tool-call count cap; it uses LangGraph's default recursion limit,
currently 25 graph steps. This limit counts agent steps, not notes or tool calls,
and some tool calls can return multiple notes. A long run may stop at the native
limit. The **Context window tokens** setting defaults to 4,096 and sets an
approximate usable provider-request budget including reserved output; it does not
change the provider model context limit or LM Studio memory allocation. As
accumulated history approaches that budget, LangGraph summarizes older history.
The current request and its full turn-scoped skill and attachment context are
retained. If the current request, retrieved evidence, or assembled provider request still
cannot fit, Voce stops with an actionable context-limit message instead of silently
clipping content. Context-limit failures mark the turn incomplete and preserve any
partial answer, source provenance, and any successful compaction status.
Graph-step exhaustion and context limits mark the turn incomplete and preserve
the last completed conversation context. A provider may also reject a request
that exceeds its own context limit. Larger turns can increase latency and model
usage; cancellation remains available during a run.

## Development

The packaged runtime consists of `main.js`, `sqlite-worker.mjs`, `sqlite3.mjs`, `sqlite3.wasm`, `manifest.json`, and `styles.css`. The repository includes a version hook and commands to build and install the plugin into the demo vault. The demo installer targets that vault only.

Use the current-app benchmark to compare repeated timing samples from the normal Obsidian plugin. Build and prepare the generated benchmark vault with `npm run build` and `npm run benchmark:prepare`, then follow [the Obsidian benchmark guide](docs/obsidian-benchmark.md). The comparison command is `npm run benchmark:compare -- before.json after.json`; it prints raw samples, medians, and after-minus-before milliseconds without writing files. Historical measurements recorded in the ADRs are workload-specific evidence, not current performance guarantees.

Accepted architecture decisions are recorded in the [LangChain and SQLite ADR](.ai/adrs/langchain-sqlite-note-index.md), the [embedding-cache ADR](.ai/adrs/embedding-cache-sharing-and-clear.md), the [SQLite storage-layout ADR](.ai/adrs/sqlite-table-storage-layout.md), and the [automatic-maintenance ADR](.ai/adrs/automatic-index-maintenance.md). The [test-boundaries ADR](.ai/adrs/testing-boundaries-and-native-validation.md) links the [generated demo-vault checks](docs/demo-vault.md); use the [Obsidian benchmark guide](docs/obsidian-benchmark.md) for current-app measurements.
