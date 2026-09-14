# Direct SQLite WASM supply chain

Run from the repository root:

```sh
node scripts/sqlite-wasm/build.mjs --clean
node scripts/sqlite-wasm/verify.mjs
```

The Dockerfile downloads and verifies immutable official SQLite, SQLite
amalgamation, and SQLite-Vector archives, then compiles them with the digest-pinned
Emscripten image recorded in `vendor/sqlite-wasm/supply-chain.json`. The Node
wrapper records one local input fingerprint, rebuilds only when it changes, verifies
the Docker outputs, and atomically copies `sqlite3.mjs` and `sqlite3.wasm` to the
ignored repository root. SQLite-Vector is statically registered; the build uses
SQLite's canonical ES module without post-processing generated code.
