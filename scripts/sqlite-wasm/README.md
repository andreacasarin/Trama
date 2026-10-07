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

The same static initializer registers Trama's native vector dot product, centroid
aggregate, Unicode token count, scoped passage BM25, and UTF-16 path collation.
These keep database-backed retrieval computation inside SQLite. Vector arithmetic
uses double accumulation in component order to preserve existing Float32 rankings.
The build fingerprint includes this source; runtime verification checks the native
functions alongside SQLite-Vector and FTS5.
