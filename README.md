# Trama

Trama is a desktop-only Obsidian plugin for local AI conversation and semantic connections. **Voce** is the agent chat that can navigate linked notes, while **Filo** is the planned per-note view for discovering semantically related notes. Chat and embedding requests go only to a user-approved local LM Studio endpoint. Trama performs no network requests at startup; connection and model discovery are triggered by sending a message or rebuilding the index.

## Setup

1. Install and start [LM Studio](https://lmstudio.ai/) **0.3.29 or newer**, load a chat model and an embedding model, and enable its local OpenAI-compatible server (normally `http://127.0.0.1:1234/v1`).
2. Configure the chat model and embedding model independently in the plugin settings.
3. Use **Rebuild Filo index** from the command palette, then open **Voce** with **Open Voce**.

The semantic index is stored at `<vault>/.trama/index/`. Configure that directory in your sync tool's exclusions; it is generated data and can be rebuilt. Trama reads Markdown notes only and has no note-write, edit, or save-as-note capability. Voce messages remain in memory and are not persisted.

## Voce chat

Voce uses LM Studio's `/v1/responses` endpoint with streaming enabled. Each
request includes the complete local conversation history and `store: false`,
so LM Studio does not hold the conversation. Chats are kept only in memory and
are not persisted.

The visible transcript stays clean and compact: it shows only user and
assistant conversation bubbles, a generic working state while Voce is busy,
compact source chips for accessed notes, and user-actionable error text. Raw
protocol roles, tool calls, tool arguments/results, and attached note contents
are not rendered in the chat view. Each completed assistant response has an
action row with a copy button; the row can accommodate additional response
actions later without changing message rendering. Message bodies use
Obsidian's reading-mode Markdown renderer, so their internal links follow the
same navigation behavior as links in a rendered note.

Use Obsidian wikilinks such as `[[Daily/Today]]` in the composer to attach one
or more visible Markdown notes to the next turn, including unopened notes.
Typing `@` opens the note picker as a shortcut and inserts the selected note as
a visible wikilink. Full paths, aliases, headings, and unique note names are
resolved deterministically; missing or ambiguous citations produce an error
instead of silently omitting context. Attached notes also appear as removable
chips, are sent only with that turn, and clear as soon as the send begins. Voce
does not fall back to the active note automatically. A compact context strip
above the composer suggests the most recently active visible Markdown note;
click its tag to toggle it, or use the Plus button for the full picker. The
strip can later include related-note suggestions without changing the
composer. Enter sends the message, while Shift+Enter inserts a newline. Long
messages are collapsed by default and can be expanded in place.

The settings page provides these chat controls:

- **Temperature**: a required slider from **0** through **1** in **0.1**
  increments, with a default of **0.7**.
- **Maximum generated-output tokens**: **0** means **Auto**; larger values use
  **1K** increments through **128K**. Reasoning tokens count toward this limit
  where applicable.
- **Reasoning effort**: **Auto**, **None**, **Low**, **Medium**, or **High**.
  Auto leaves the value unset, while the explicit levels are sent to LM Studio
  when selected.

Voce's tools run in the plugin and are read-only: they can search the vault,
read notes, and discover or follow links. Answers show the accessed note paths
and line ranges as provenance. Wikilinks inside an attached note can therefore
lead Voce to related notes when the question requires them; traversal remains
bounded by the existing tool-round and read limits rather than eagerly loading
an entire link graph. Trama does not use Remote MCP or hosted tools; embeddings
continue using LM Studio's existing `/v1/embeddings` endpoint.

The settings page also includes **Detailed Voce debugging**, which is off by
default. When enabled, Trama writes full Voce diagnostic payloads to the
developer console only, including prompts, selected-note contents, requests,
SSE events, tool arguments/results, and errors. No diagnostic file is created,
so enable it only when you are comfortable with that console-visible data.

## Development

Build and install the plugin into a vault with one command:

```sh
npm run install:plugin -- "/path/to/your/vault"
```

Alternatively, set the vault path through the environment:

```sh
OBSIDIAN_VAULT_PATH="/path/to/your/vault" npm run install:plugin
```

The installer verifies that the target is an Obsidian vault, then copies
`main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/trama/`. Restart or reload Obsidian
after installation.

Run the development checks separately with:

```sh
npm install
npm run format
npm run lint
npm test
npm run build
```

Do not run `npm run dev`; Obsidian loads the production `main.js`. Current limitations include large-vault indexing cost, the not-yet-implemented Filo view, and native (rather than React) UI. Trama is an independent, clean-break plugin with no compatibility guarantees for other plugins or earlier identities.
