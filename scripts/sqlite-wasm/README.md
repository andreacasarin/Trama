# Direct SQLite WASM supply chain

Run from the repository root:

```sh
node scripts/sqlite-wasm/build.mjs --clean
node scripts/sqlite-wasm/verify.mjs
```

The Dockerfile downloads and verifies the pinned official SQLite source and
amalgamation archives, then compiles them with the digest-pinned Emscripten image
recorded in `vendor/sqlite-wasm/supply-chain.json`. The Node wrapper records one
local input fingerprint, rebuilds only when it changes, verifies the Docker
outputs, and atomically copies `sqlite3.mjs` and `sqlite3.wasm` to the ignored
repository root. The build uses SQLite's canonical ES module without
post-processing generated code.

The static initializer registers only Trama's native dot product and centroid
aggregate. Lexical retrieval uses SQLite's built-in FTS5 tokenizer and BM25;
path ordering uses SQLite's BINARY collation. No vector extension is bundled.
Vector components are stored as little-endian Float32; validation,
normalization, dot products, and centroid accumulation use double precision
arithmetic. Inputs must remain finite and nonzero after Float32 conversion.
Retrieval normalizes stored chunks, queries, and centroids, so their dot product
is cosine similarity. Normalize bounded inputs once instead of recomputing norms
for every comparison, reusing the magnitude already calculated by validation.
Raw document-cache vectors remain unnormalized for reuse. Shard validation checks
their native squared magnitude once; the dot function rejects nonfinite results.

Exact cosine search is the current choice. Approximate indexes are deferred until
representative search measurements justify a separate investigation.

The build fingerprint includes the native source; runtime verification checks
extreme magnitudes, native functions, FTS5, and the absence of SQLite-Vector.
Shard imports accept both the current two-table format and legacy shards with
SQLite-Vector's empty metadata table; no index reset is required.
