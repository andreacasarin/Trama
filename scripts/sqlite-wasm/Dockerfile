# The wrapper always overrides this with the platform-specific digest-pinned image.
ARG EMSCRIPTEN_IMAGE=emscripten/emsdk:4.0.11
FROM ${EMSCRIPTEN_IMAGE} AS build

ARG SQLITE_URL
ARG SQLITE_SHA256
ARG SQLITE_AMALGAMATION_URL
ARG SQLITE_AMALGAMATION_SHA256
ARG SQLITE_VECTOR_URL
ARG SQLITE_VECTOR_SHA256
ARG SQLITE_OPT
ARG EMCC_FLAGS
ARG EMCC_OPT

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
WORKDIR /src

RUN set -eux; \
    curl --fail --location --retry 3 "$SQLITE_URL" -o /tmp/sqlite.zip; \
    curl --fail --location --retry 3 "$SQLITE_AMALGAMATION_URL" -o /tmp/amalgamation.zip; \
    curl --fail --location --retry 3 "$SQLITE_VECTOR_URL" -o /tmp/sqlite-vector.tar.gz; \
    echo "$SQLITE_SHA256  /tmp/sqlite.zip" | sha256sum --check; \
    echo "$SQLITE_AMALGAMATION_SHA256  /tmp/amalgamation.zip" | sha256sum --check; \
    echo "$SQLITE_VECTOR_SHA256  /tmp/sqlite-vector.tar.gz" | sha256sum --check; \
    unzip -q /tmp/sqlite.zip; \
    unzip -q /tmp/amalgamation.zip; \
    tar -xzf /tmp/sqlite-vector.tar.gz

COPY sqlite3_wasm_extra_init.c /build/

RUN set -eux; \
    emcc --version | grep ' 4.0.11'; \
    cp sqlite-amalgamation-3530400/sqlite3.c sqlite-src-3530400/sqlite3.c; \
    cp sqlite-amalgamation-3530400/sqlite3.h sqlite-src-3530400/sqlite3.h; \
    mkdir -p sqlite-src-3530400/ext/wasm/sqlite-vector/fp16; \
    cp sqlite-vector-1.0.0/src/* sqlite-src-3530400/ext/wasm/sqlite-vector/; \
    cp sqlite-vector-1.0.0/libs/fp16/* sqlite-src-3530400/ext/wasm/sqlite-vector/fp16/; \
    cp /build/sqlite3_wasm_extra_init.c sqlite-src-3530400/ext/wasm/; \
    cd sqlite-src-3530400; \
    ./configure --disable-shared --enable-static >/dev/null; \
    gcc -O2 -I. -o version-info tool/version-info.c; \
    cd ext/wasm; \
    make -f GNUmakefile ./jswasm/sqlite3.mjs sqlite3_wasm_extra_init.c=sqlite3_wasm_extra_init.c \
      "SQLITE_OPT=$SQLITE_OPT" "emcc.flags=$EMCC_FLAGS" "emcc_opt=$EMCC_OPT" emcc.verbose=1; \
    cp jswasm/esm/sqlite3.wasm jswasm/sqlite3.wasm; \
    test -s jswasm/sqlite3.mjs; \
    test -s jswasm/sqlite3.wasm

FROM scratch
COPY --from=build /src/sqlite-src-3530400/ext/wasm/jswasm/sqlite3.mjs /
COPY --from=build /src/sqlite-src-3530400/ext/wasm/jswasm/sqlite3.wasm /
