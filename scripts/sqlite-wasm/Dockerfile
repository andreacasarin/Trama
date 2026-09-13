# The wrapper always overrides this with the platform-specific digest-pinned image.
ARG EMSCRIPTEN_IMAGE=emscripten/emsdk:4.0.11
FROM ${EMSCRIPTEN_IMAGE} AS build

ARG SQLITE_URL
ARG SQLITE_SHA256
ARG SQLITE_AMALGAMATION_URL
ARG SQLITE_AMALGAMATION_SHA256
ARG SQLITE_VEC_URL
ARG SQLITE_VEC_SHA256
ARG SQLITE_OPT
ARG EMCC_FLAGS
ARG EMCC_OPT

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
WORKDIR /src

RUN set -eux; \
    curl --fail --location --retry 3 "$SQLITE_URL" -o /tmp/sqlite.zip; \
    curl --fail --location --retry 3 "$SQLITE_AMALGAMATION_URL" -o /tmp/amalgamation.zip; \
    curl --fail --location --retry 3 "$SQLITE_VEC_URL" -o /tmp/sqlite-vec.tar.gz; \
    echo "$SQLITE_SHA256  /tmp/sqlite.zip" | sha256sum --check; \
    echo "$SQLITE_AMALGAMATION_SHA256  /tmp/amalgamation.zip" | sha256sum --check; \
    echo "$SQLITE_VEC_SHA256  /tmp/sqlite-vec.tar.gz" | sha256sum --check; \
    unzip -q /tmp/sqlite.zip; \
    unzip -q /tmp/amalgamation.zip; \
    mkdir sqlite-vec; \
    tar -xzf /tmp/sqlite-vec.tar.gz -C sqlite-vec

COPY sqlite3_wasm_extra_init.c patch-module.mjs /build/

RUN set -eux; \
    emcc --version | grep ' 4.0.11'; \
    cp sqlite-amalgamation-3450300/sqlite3.c sqlite-src-3450300/sqlite3.c; \
    cp sqlite-amalgamation-3450300/sqlite3.h sqlite-src-3450300/sqlite3.h; \
    cp sqlite-vec/sqlite-vec.c sqlite-src-3450300/ext/wasm/sqlite-vec.c; \
    cp sqlite-vec/sqlite-vec.h sqlite-src-3450300/ext/wasm/sqlite-vec.h; \
    cp /build/sqlite3_wasm_extra_init.c sqlite-src-3450300/ext/wasm/; \
    cd sqlite-src-3450300; \
    ./configure --disable-shared --enable-static >/dev/null; \
    gcc -O2 -I. -o version-info tool/version-info.c; \
    cd ext/wasm; \
    make -f GNUmakefile ./jswasm/sqlite3.mjs sqlite3_wasm_extra_init.c=sqlite3_wasm_extra_init.c \
      "SQLITE_OPT=$SQLITE_OPT" "emcc.flags=$EMCC_FLAGS" "emcc_opt=$EMCC_OPT" emcc.verbose=1; \
    node /build/patch-module.mjs jswasm/sqlite3.mjs

FROM scratch
COPY --from=build /src/sqlite-src-3450300/ext/wasm/jswasm/sqlite3.mjs /
COPY --from=build /src/sqlite-src-3450300/ext/wasm/jswasm/sqlite3.wasm /
