# Direct SQLite WASM supply chain

Normal plugin builds use Node.js 22.23.3 and the committed `sqlite3.mjs` and
`sqlite3.wasm` in `vendor/sqlite-wasm/`. `artifacts.json` pins their SHA-256 hashes
and the fingerprint of the native source, Dockerfile, supply-chain lock, and
builder. `npm run build` rejects modified or stale inputs and verifies their
native capabilities before bundling. It needs no Docker, compiler, build cache,
or downloads beyond `npm ci`.

For maintainers, from the repository root with Docker available:

```sh
npm run rebuild:sqlite
npm run verify:sqlite:rebuild
```

`rebuild:sqlite` downloads and verifies the pinned official SQLite source and
amalgamation archives, then compiles them with the digest-pinned Emscripten image
recorded in `vendor/sqlite-wasm/supply-chain.json`. It verifies the native outputs
before updating the committed artifacts and integrity record. Commit those files
together with any native input change. Generated code is not post-processed.

`verify:sqlite:rebuild` independently recompiles without a build-cache shortcut
and requires byte equality with the committed artifacts. CI and the release
workflow run this check. Native rebuild staging files at the ignored repository
root are never used by the normal plugin build. A separate CI test starts from a
clean Node 22 container without Docker and runs the same install, build, and tests
as a fresh contributor or the Community verifier.

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

## Plugin bundle

`npm run build` keeps these pinned files as build inputs. Esbuild's binary loader
embeds the WASM in the worker bundle at `.cache/sqlite.worker.js`, and its text
loader embeds that generated worker in `main.js`. The runtime creates a Blob-backed
module worker and supplies the WASM bytes directly; it does not fetch sidecar files.
The community installer needs only `main.js`, `manifest.json`, and `styles.css`.
Required license notices are included in `main.js` as well as the release ZIP.
