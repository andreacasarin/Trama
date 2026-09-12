# TalaDB 0.11.3 Gate 0 evaluation

Date: 2026-09-11  
Selected pair: `taladb@0.11.3` and `@taladb/web@0.11.3` (exact pins)

## Decision

PASS_WITH_APPROVED_EXCEPTIONS. All retained Gate 0 availability and runtime proofs passed for the exact pair. The raw second `db.close()` observation is retained as an approved exception: it rejects after worker termination, so the future Trama wrapper must provide idempotent close semantics.

## Published package evidence

Both packages were queried from the live npm registry and downloaded as exact tarballs. The mutually published patch is `0.11.3`; no caret or tilde range is used.

| Package              | Registry integrity                                                                                | Lockfile integrity | License             | Public entry/types                         |
| -------------------- | ------------------------------------------------------------------------------------------------- | ------------------ | ------------------- | ------------------------------------------ |
| `taladb@0.11.3`      | `sha512-lbAmXGwteI+txA4MpU9izaIV3oYjXl4G/iLxKFRHIEmj6MkaZDisOtJWjU7zeZR3qSarbC44WWCc3KHjeiZV8A==` | matching           | `MIT OR Apache-2.0` | `dist/index.js`, `dist/index.d.ts`         |
| `@taladb/web@0.11.3` | `sha512-+e6x3AS0szqEF7NWxOlaoDxGh7tYueSZ8SYqKHore9nECYAGZePSI7Ct5b4+54Lgy8aTiGDO1JjiDnSVO+kaaQ==` | matching           | `MIT OR Apache-2.0` | `pkg/taladb_web.js`, `pkg/taladb_web.d.ts` |

The web tarball contains the Worker (`17,041` bytes), glue (`89,561` bytes), and WASM (`2,117,505` bytes), plus MIT and Apache license files. Public declarations expose `openDB`, CRUD/bulk methods, flat cosine vector indexes/search, FTS/BM25, hybrid search, metadata filters, `close`, `storageInfo`, and public snapshot import/export bindings. HNSW is unavailable in the browser binding.

## Executed proofs

The single runner is `npm run taladb:gate0`. It builds the fixture in an installed-plugin layout and emits the package-relative local Worker/glue/WASM layout under the ignored generated directory. The shared production resource resolver’s installed-layout proof confirms the same package-relative local asset strategy. The browser runner uses Chromium 131.0.6778.33 (Playwright build 1148), fresh repository-contained profiles, loopback serving, request interception, and no Obsidian imports or vault paths.

| Retained proof                                                                               | Result                                                                                        |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Exact package resolution, lockfile/tarball integrity, files, exports, declarations, licenses | PASS                                                                                          |
| CommonJS/Obsidian-style root-main local asset strategy; emitted metafile and asset sizes     | PASS                                                                                          |
| Local Worker/glue/WASM loading; no CDN or remote Worker                                      | PASS                                                                                          |
| Startup/open/index traffic has no remote fetch/XHR/WebSocket/EventSource                     | PASS; only package-local asset loading is observed                                            |
| OPFS open/write/search/close/reopen and durable flush                                        | PASS                                                                                          |
| Forced IndexedDB fallback, positively detected as `indexeddb`, CRUD/search/reopen            | PASS                                                                                          |
| Flat cosine exact 768-dimensional oracle                                                     | PASS                                                                                          |
| FTS/BM25                                                                                     | PASS                                                                                          |
| Native hybrid availability/behavior (benchmark-only)                                         | PASS in browser WASM binding; no native production adoption                                   |
| Metadata prefilter before top-k                                                              | PASS                                                                                          |
| Numeric and null filters                                                                     | PASS                                                                                          |
| CRUD/update/delete/bulk and deterministic field mapping                                      | PASS                                                                                          |
| No HNSW in browser                                                                           | PASS (`storageInfo().hnsw === false`)                                                         |
| Writer/contender lifetime behavior                                                           | PASS (first owner, second non-owner)                                                          |
| Close/reopen                                                                                 | PASS                                                                                          |
| Raw second-close observation                                                                 | APPROVED EXCEPTION — second public `close()` rejects; future Trama wrapper must be idempotent |
| Public checkpoint export/import into a fresh DB object/runtime                               | PASS                                                                                          |
| Corrupt checkpoint rejected without replacing last good object                               | PASS                                                                                          |

The runner exits nonzero only when a retained check fails. The obsolete transaction/staged-generation/current-previous publication proofs are intentionally outside this availability-first Gate 0 decision and are not used as blockers.

## Commands and evidence

Executed commands included live `npm view` registry queries, exact `npm pack`, exact package installation, Node syntax checks, and:

```text
npm run taladb:gate0
```

The final run returned `PASS_WITH_APPROVED_EXCEPTIONS`, with `36` retained checks evaluated. Ignored raw/build/runtime evidence is under `candidate/taladb/.generated/gate0`. Browser binaries/profiles/cache are under `candidate/taladb/.generated`.

No real Obsidian vault was inspected, enumerated, launched, or written.
