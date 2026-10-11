# Trama

Trama is an Obsidian plugin for local AI conversation and semantic connections. Its V1 provides an agent chat, a local semantic note index, and SQLite-backed retrieval. Provider requests happen only after an explicit chat, search, or index action. Trama makes no network requests at startup or while loading settings.

Trama uses LangChain components for embeddings, Markdown splitting, agents, and tools. Each vault has a stable local index identity, and its SQLite database is stored in that vault's OPFS namespace. SQLite stores note metadata, chunk vectors, lexical search data, and a normalized note centroid. Search filters and ranks indexed data in SQLite; matching note content is loaded from the current vault when results are returned. The index does not persist raw Markdown bodies. Copying a vault's identity file copies its index namespace too.

## Use

1. Install and enable Trama in Obsidian.
2. Configure an approved local OpenAI-compatible endpoint and embedding model before using provider-backed chat or semantic indexing. Startup and settings loading remain offline; lexical search does not require a provider call.
3. Run **Update index** to prepare the local index. Run **Rebuild index** when you want to replace it.
4. Use the available chat and search actions. Search results link to notes in the vault.

Index updates are manual. Trama indexes notes one at a time and runs full cleanup only after every input succeeds, including when the vault is empty. If indexing fails, the run stops and cleanup is skipped, leaving existing lexical data available. Changes made to notes during an update are picked up on the next manual update. Cancellation rolls back the active note transaction and keeps earlier completed commits. Related-note results persist locally across restarts and refresh after an index update when the active note is opened; this does not call a provider.

The agent uses session-only conversation history and turn attachments. Tools are read-only and return note links. Provider calls disable response storage. When semantic retrieval cannot run, search falls back to lexical results and reports that it is degraded.

## Development

The packaged runtime consists of `main.js`, `sqlite-worker.mjs`, `sqlite3.mjs`, `sqlite3.wasm`, `manifest.json`, and `styles.css`. The repository includes a version hook and commands to build and install the plugin into the demo vault. The demo installer targets that vault only.

The current implementation reference is [docs/langchain-sqlite-implementation.md](docs/langchain-sqlite-implementation.md). Historical design briefs, benchmark reports, and test inventories are labeled in their respective documents; they do not define current V1 behavior or performance claims.
