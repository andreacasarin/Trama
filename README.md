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

The settings page provides these chat controls:

- **Temperature**: a required slider from **0** through **1** in **0.1**
  increments, with a default of **0.7**.
- **Maximum generated-output tokens**: **0** means **Auto**; larger values use
  **1K** increments through **128K**. Reasoning tokens count toward this limit
  where applicable.
- **Reasoning effort**: **Auto**, **None**, **Low**, **Medium**, or **High**.
  Auto leaves the value unset, while the explicit levels are sent to LM Studio
  when selected.

Voce's tools run in the plugin and are read-only: they can inspect the current
note, search the vault, read notes, and discover or follow links. Answers show
the accessed note paths and line ranges as provenance. Trama does not use
Remote MCP or hosted tools; embeddings continue using LM Studio's existing
`/v1/embeddings` endpoint.

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
`main.js` and `manifest.json` into
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
