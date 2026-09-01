# Trama

Trama is a desktop-only Obsidian plugin for local AI conversation and semantic connections. **Voce** is the agent chat that can navigate linked notes, while **Filo** is the planned per-note view for discovering semantically related notes. Chat and embedding requests go only to a user-approved local LM Studio endpoint. Trama performs no network requests at startup; connection and model discovery are triggered by sending a message or rebuilding the index.

## Setup

1. Install and start [LM Studio](https://lmstudio.ai/), load a chat model and an embedding model, and enable its local OpenAI-compatible server (normally `http://127.0.0.1:1234/v1`).
2. Configure the chat model and embedding model independently in the plugin settings.
3. Use **Rebuild Filo index** from the command palette, then open **Voce** with **Open Voce**.

The semantic index is stored at `<vault>/.trama/index/`. Configure that directory in your sync tool's exclusions; it is generated data and can be rebuilt. Trama reads Markdown notes only and has no note-write, edit, or save-as-note capability. Voce messages remain in memory and are not persisted.

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
