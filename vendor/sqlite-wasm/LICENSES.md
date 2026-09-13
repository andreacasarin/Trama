# SQLite candidate supply-chain licenses

This directory is generated from pinned upstream sources by
`node scripts/sqlite-wasm/build.mjs`. The direct-production WASM assets contain the following
third-party components:

| Component | Version | License | Official evidence |
| --- | --- | --- | --- |
| SQLite | 3.45.3 | Public domain (SQLite blessing) | https://www.sqlite.org/copyright.html |
| sqlite-vec | v0.1.9 | MIT | https://github.com/asg017/sqlite-vec/blob/v0.1.9/LICENSE.md |
| Emscripten SDK | 4.0.11 | Apache-2.0 / LLVM / component licenses | https://github.com/emscripten-core/emsdk/blob/4.0.11/LICENSE |

The generated JavaScript and WebAssembly files retain the upstream SQLite
license/version header. This inventory is deliberately kept next to the
lock manifest so an artifact can be audited without accessing a vault.
