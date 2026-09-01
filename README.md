# Local Vault Assistant

Local Vault Assistant is a desktop-only Obsidian plugin that sends chat and embedding requests to a user-approved local LM Studio endpoint. It performs no network requests at startup; connection and model discovery are user-triggered by sending a chat message or rebuilding the index.

## Setup

1. Install and start [LM Studio](https://lmstudio.ai/), load a chat model and an embedding model, and enable its local OpenAI-compatible server (normally `http://127.0.0.1:1234/v1`).
2. Configure the chat model and embedding model independently in the plugin settings.
3. Use **Rebuild vault index** from the command palette, then open **Local Vault Assistant** with **Open chat**.

The semantic index is stored at `<vault>/.local-vault-assistant/index/`. Configure that directory in your sync tool's exclusions; it is generated data and can be rebuilt. The assistant reads Markdown notes only and has no note-write, edit, or save-as-note capability. Chat messages remain in memory and are not persisted.

## Development

```sh
npm install
npm run format
npm run lint
npm test
npm run build
```

Do not run `npm run dev`; Obsidian loads the production `main.js`. Current limitations include LM Studio response compatibility, large-vault indexing cost, and native (rather than React) UI. This is an independent plugin and has no migration path from Copilot.
