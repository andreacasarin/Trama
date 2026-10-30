# Trama

**Talk with your notes. Find the thread between them.**

[![CI](https://github.com/andreacasarin/trama/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/andreacasarin/trama/actions/workflows/ci.yml)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.7.2%2B-7C3AED)](manifest.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Trama brings AI chat, related notes, and search into Obsidian. Connect your models,
index your vault, and explore what you've already written—from a question, a
half-remembered idea, or the note in front of you.

Built for local models, with an index that stays on your device and read-only
tools for exploring your notes.

[Get started](#get-started) · [Explore Trama](#three-ways-into-your-vault) · [Privacy](#your-notes-your-models) · [Technical notes](docs/technical-notes.md)

## Three ways into your vault

| View              | What it does                                                                 | Try it when…                                          |
| ----------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Voce** · Voice  | Chat with your notes, attach context, and follow sources back to your vault. | “What themes keep coming up in my journal?”           |
| **Filo** · Thread | Discover notes related to the one you're reading.                            | You want to follow an idea beyond its existing links. |
| **Lente** · Lens  | Search by keywords and meaning, then open the notes behind the results.      | You remember the idea, but not the exact words.       |

Open each view from Obsidian's command palette: **Trama: Open Voce**,
**Trama: Open Filo**, or **Trama: Open Lente**.

### Voce: a conversation with context

Ask a question, or bring a few notes into the conversation with `[[wikilinks]]`,
`@`, or the plus button. The current note and related-note suggestions are optional;
you choose what to attach. Voce can also search and read notes through its vault
tools. Expand **Sources** below an answer to open the notes it used.

Use **Enter** to send, **Shift+Enter** for a new line, and **Stop** to interrupt a
response. You can copy answers, edit an earlier prompt to take the conversation
in a different direction, or start fresh with **New chat**.

Want a repeatable workflow? Write a skill as a Markdown note and invoke it with
`/` in the composer. [Create your first skill →](docs/technical-notes.md#voce-skills)

### Filo and Lente: follow an idea

Filo surfaces related notes as you move through your vault. Lente combines
keyword and semantic search to help you find notes even when your wording has
changed. Both link directly to the original notes. With Obsidian's **Page preview**
enabled for Trama, hover over a result title to peek inside.

## Get started

You'll need Obsidian **1.7.2 or newer** and a running model server. Trama connects
to OpenAI-compatible endpoints; chat requires the **Responses API** and tool
calling, and semantic search requires an **embedding model**. You can configure
chat and embeddings separately.

### 1. Install Trama

1. Download the plugin ZIP from [Releases](https://github.com/andreacasarin/trama/releases).
2. Extract all files into `<your-vault>/.obsidian/plugins/trama/`, so
   `manifest.json` sits directly inside that folder. If your vault uses a custom
   configuration folder, use it in place of `.obsidian`.
3. Reload Obsidian, allow community plugins, and enable **Trama** in Settings.

The search engine and its worker are bundled into `main.js`; no extra runtime
files or startup downloads are needed.

### 2. Connect your models

Open **Settings → Trama**:

- Under **Voce**, set the chat endpoint and choose a chat model.
- Under **Filo**, set the embedding endpoint, model, and matching vector dimensions.
  You can also exclude folders from indexing here.
- Use **Discover** beside either model selector to load the models offered by
  that endpoint.

The default base URL is `http://127.0.0.1:1234/v1`. Use your server's base URL,
including any required prefix such as `/v1`.

### 3. Index and explore

Under **Maintenance**, select **Update index**. Once it finishes, open Filo or
Lente, or ask Voce a question about your notes.

After that first successful index, Trama keeps it up to date on startup and after
Markdown changes, with a periodic check for missed changes. New or changed content
may be sent to your embedding model during these updates. You can update manually
or stop an operation at any time.

## Your notes, your models

- **Local storage.** The search index lives on your device. Trama also writes reusable
  document embeddings under `Trama/embedding-cache-v2` in your vault, so your usual
  sync service can carry them between devices. These files contain vectors and
  cache metadata, without note text, chat, or queries.
- **You choose the endpoint.** Chat requests send your prompt, selected skill,
  attachments, and retrieved context to the configured chat server. Indexing sends
  note content to the embedding server; semantic search sends the query. With a
  local server, those requests go to that server. A remote endpoint receives that
  content instead.
- **Read-only note tools.** Voce can search and read notes. Its vault tools cannot
  edit or delete them. Folder exclusions apply to indexing; they do not restrict
  notes you attach or read in chat.
- **Session-only conversations.** Trama does not save chat history to disk. Use
  **New chat** to clear it; closing the last Voce pane also resets the conversation.

[Read about storage, cache sharing, and provider requests →](docs/technical-notes.md)

## Common questions

**Do I need both models?**

Voce needs a chat model. Building the semantic index and using Filo need an
embedding model. If embeddings become unavailable, search can fall back to
keywords over an existing index.

**What is the difference between Update, Rebuild, and Clear?**

| Action                              | Use it to…                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Update index**                    | Index current notes and remove deleted or excluded notes from search.                                                |
| **Rebuild index**                   | Replace the note index while retaining reusable embeddings.                                                          |
| **Clear index and embedding cache** | Remove the local index and cached embeddings, plus managed cache files in the vault. Notes and settings stay intact. |

Clear also pauses automatic indexing until you run Update or Rebuild again. Shared
file deletion follows your vault's sync service; other devices keep their own
local caches. If cleanup is interrupted, Trama reports it and you can retry.

**I've changed my embedding model. What next?**

Use the dimensions expected by the new model. Trama prompts before saving a local
embedding configuration change when an index exists, and recommends Clear followed
by Update or Rebuild. See [model changes and cache reuse](docs/technical-notes.md#models-and-settings)
for the details.

**The conversation hit a context limit.**

Try fewer or smaller attachments, or adjust **Context window tokens** to fit your
model. Trama summarizes older history as needed and tells you when it does. This
setting controls Trama's request budget; it does not enlarge the model's own
context window.

## Build and contribute

Development requires **Node.js 24** and **Docker** for the pinned SQLite/WASM build.

```sh
npm ci
npm test
```

To build and install into the generated demo vault:

```sh
npm run install:plugin -- --test-vaults
```

This builds and installs the validated release ZIP into the demo vault, removes
obsolete runtime sidecars, and preserves your notes and settings. Reload Obsidian
or disable and re-enable Trama afterwards.

See the [demo-vault guide](docs/demo-vault.md) for a walkthrough,
[technical notes](docs/technical-notes.md) for behavior and architecture,
and the [benchmark guide](docs/obsidian-benchmark.md) for performance checks.
[Issues](https://github.com/andreacasarin/trama/issues) are welcome—include what
you expected, what happened, and steps to reproduce it. Remove private note content
and endpoint credentials from anything you share.

## License

Trama is [MIT licensed](LICENSE). Dependencies keep their own licenses; see the
[dependency inventory](vendor/sqlite-wasm/LICENSES.md). Release archives include
the applicable third-party notices.
