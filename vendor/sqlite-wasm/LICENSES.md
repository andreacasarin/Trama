# SQLite candidate supply-chain licenses

This directory is generated from pinned upstream sources by
`node scripts/sqlite-wasm/build.mjs`. The direct-production WASM assets contain the following
third-party components:

| Component | Version | License | Official evidence |
| --- | --- | --- | --- |
| SQLite | 3.53.4 | Public domain (SQLite blessing) | https://www.sqlite.org/copyright.html |
| Emscripten SDK | 4.0.11 | Build tools: Apache-2.0 / LLVM / component licenses; runtime glue: MIT / NCSA | https://github.com/emscripten-core/emsdk/blob/4.0.11/LICENSE |
| musl libc | Bundled with Emscripten 4.0.11 | MIT and permissive component terms | https://github.com/emscripten-core/emscripten/blob/4.0.11/system/lib/libc/musl/COPYRIGHT |

The generated JavaScript and WebAssembly files retain the upstream SQLite
license/version header. This inventory is deliberately kept next to the
lock manifest so an artifact can be audited without accessing a vault.

Trama, including its independently implemented native vector functions, is
licensed under MIT. SQLite-Vector and its FP16 headers are no longer downloaded,
compiled, or shipped.

The runtime glue license is preserved in `emscripten-LICENSE.txt` from the
Emscripten 4.0.11 source. Its bundled musl copyright file is preserved verbatim
in `musl-COPYRIGHT.txt` from the same pinned source. Release builds generate `THIRD-PARTY-NOTICES.txt`
from the licenses of bundled npm packages and these runtime components.
