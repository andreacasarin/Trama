#define _GNU_SOURCE
#include <strings.h>
#include "sqlite3.h"
#define SQLITE_CORE 1
#include "sqlite-vector/distance-cpu.c"
#include "sqlite-vector/sqlite-vector.c"

static int trama_sqlite_init(sqlite3 *, char **, const sqlite3_api_routines *);

int sqlite3_wasm_extra_init(const char *z) {
  (void)z;
  int rc = sqlite3_auto_extension((void (*)(void))sqlite3_vector_init);
  if (rc == SQLITE_OK) rc = sqlite3_auto_extension((void (*)(void))trama_sqlite_init);
  return rc;
}

#include <math.h>
#include <stdlib.h>
#include <string.h>

/* Accumulate in double, in component order, matching the existing Float32 JS
   scoring exactly. These operate on SQLite-owned blobs, without JS transfers. */
static void trama_dot(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc;
  int bytes = sqlite3_value_bytes(argv[0]);
  if (sqlite3_value_type(argv[0]) != SQLITE_BLOB ||
      sqlite3_value_type(argv[1]) != SQLITE_BLOB || !bytes || bytes % 4 ||
      bytes != sqlite3_value_bytes(argv[1])) {
    sqlite3_result_error(ctx, "Vector dimensions mismatch", -1);
    return;
  }
  const float *a = sqlite3_value_blob(argv[0]), *b = sqlite3_value_blob(argv[1]);
  double sum = 0;
  for (int i = 0; i < bytes / 4; ++i) sum += (double)a[i] * (double)b[i];
  if (!isfinite(sum)) sqlite3_result_error(ctx, "Invalid vector values", -1);
  else sqlite3_result_double(ctx, sum);
}

typedef struct { double *sum; int dimensions; int failed; } TramaCentroid;
static void trama_centroid_step(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc;
  TramaCentroid *state = sqlite3_aggregate_context(ctx, sizeof(*state));
  if (!state) { sqlite3_result_error_nomem(ctx); return; }
  int bytes = sqlite3_value_bytes(argv[0]);
  if (sqlite3_value_type(argv[0]) != SQLITE_BLOB || !bytes || bytes % 4 ||
      (state->dimensions && state->dimensions != bytes / 4)) {
    state->failed = 1;
    sqlite3_result_error(ctx, "Vector dimensions mismatch", -1);
    return;
  }
  if (!state->sum) {
    state->dimensions = bytes / 4;
    state->sum = sqlite3_malloc64(state->dimensions * sizeof(double));
    if (!state->sum) { state->failed = 1; sqlite3_result_error_nomem(ctx); return; }
    memset(state->sum, 0, state->dimensions * sizeof(double));
  }
  const float *v = sqlite3_value_blob(argv[0]);
  for (int i = 0; i < state->dimensions; ++i) state->sum[i] += v[i];
}
static void trama_centroid_final(sqlite3_context *ctx) {
  TramaCentroid *state = sqlite3_aggregate_context(ctx, 0);
  if (!state) return;
  double norm = 0;
  if (!state->failed && state->sum) {
    for (int i = 0; i < state->dimensions; ++i) norm += state->sum[i] * state->sum[i];
    if (isfinite(norm) && norm > 0) {
      float *result = sqlite3_malloc64(state->dimensions * sizeof(float));
      if (!result) sqlite3_result_error_nomem(ctx);
      else {
        double scale = 1 / sqrt(norm);
        for (int i = 0; i < state->dimensions; ++i) result[i] = (float)(state->sum[i] * scale);
        sqlite3_result_blob(ctx, result, state->dimensions * 4, sqlite3_free);
      }
    }
  }
  sqlite3_free(state->sum);
}

static fts5_api *trama_fts_api(sqlite3 *db) {
  fts5_api *api = NULL;
  sqlite3_stmt *stmt = NULL;
  if (sqlite3_prepare_v2(db, "SELECT fts5(?1)", -1, &stmt, NULL) == SQLITE_OK) {
    sqlite3_bind_pointer(stmt, 1, &api, "fts5_api_ptr", NULL);
    sqlite3_step(stmt);
  }
  sqlite3_finalize(stmt);
  return api;
}
static int trama_count_token(void *context, int flags, const char *token,
                             int bytes, int start, int end) {
  (void)flags; (void)token; (void)bytes; (void)start; (void)end;
  ++*(int *)context;
  return SQLITE_OK;
}
static void trama_token_count(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc;
  fts5_api *api = sqlite3_user_data(ctx);
  fts5_tokenizer tokenizer;
  void *context = NULL;
  Fts5Tokenizer *instance = NULL;
  const char *args[] = {"remove_diacritics", "2"};
  int rc = api->xFindTokenizer(api, "unicode61", &context, &tokenizer);
  if (rc == SQLITE_OK) rc = tokenizer.xCreate(context, args, 2, &instance);
  int count = 0;
  if (rc == SQLITE_OK) rc = tokenizer.xTokenize(instance, &count, FTS5_TOKENIZE_DOCUMENT,
    (const char *)sqlite3_value_text(argv[0]), sqlite3_value_bytes(argv[0]), trama_count_token);
  if (instance) tokenizer.xDelete(instance);
  if (rc != SQLITE_OK) sqlite3_result_error_code(ctx, rc);
  else sqlite3_result_int(ctx, count);
}

typedef struct { sqlite3_int64 note; int phrase; int count; } TramaPhraseCount;
typedef struct { TramaPhraseCount *rows; int count; int capacity; int phrase; } TramaBm25;
static void trama_bm25_free(void *value) {
  TramaBm25 *state = value;
  sqlite3_free(state->rows);
  sqlite3_free(state);
}
static int trama_phrase_compare(const void *a, const void *b) {
  const TramaPhraseCount *x = a, *y = b;
  return x->note < y->note ? -1 : x->note > y->note ? 1 : x->phrase - y->phrase;
}
static int trama_phrase_hit(const Fts5ExtensionApi *api, Fts5Context *fts, void *value) {
  TramaBm25 *state = value;
  const char *note = NULL;
  int bytes = 0;
  int rc = api->xColumnText(fts, 1, &note, &bytes);
  if (rc != SQLITE_OK) return rc;
  if (state->count == state->capacity) {
    int capacity = state->capacity ? state->capacity * 2 : 128;
    void *rows = sqlite3_realloc64(state->rows, capacity * sizeof(*state->rows));
    if (!rows) return SQLITE_NOMEM;
    state->rows = rows;
    state->capacity = capacity;
  }
  state->rows[state->count++] = (TramaPhraseCount){strtoll(note, NULL, 10), state->phrase, 1};
  return SQLITE_OK;
}
/* BM25 over each note's passages, preserving the former per-note FTS statistics.
   Phrase document frequencies are collected once per statement and reused. */
static void trama_passage_bm25(const Fts5ExtensionApi *api, Fts5Context *fts,
                              sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  if (argc != 3) { sqlite3_result_error(ctx, "Invalid passage rank arguments", -1); return; }
  TramaBm25 *state = api->xGetAuxdata(fts, 0);
  int phrases = api->xPhraseCount(fts), rc = SQLITE_OK;
  if (!state) {
    state = sqlite3_malloc64(sizeof(*state));
    if (!state) { sqlite3_result_error_nomem(ctx); return; }
    memset(state, 0, sizeof(*state));
    for (int phrase = 0; phrase < phrases && rc == SQLITE_OK; ++phrase) {
      state->phrase = phrase;
      rc = api->xQueryPhrase(fts, phrase, state, trama_phrase_hit);
    }
    if (rc != SQLITE_OK) { trama_bm25_free(state); sqlite3_result_error_code(ctx, rc); return; }
    qsort(state->rows, state->count, sizeof(*state->rows), trama_phrase_compare);
    int distinct = 0;
    for (int i = 0; i < state->count; ++i) {
      if (distinct && trama_phrase_compare(&state->rows[distinct-1], &state->rows[i]) == 0)
        ++state->rows[distinct-1].count;
      else state->rows[distinct++] = state->rows[i];
    }
    state->count = distinct;
    rc = api->xSetAuxdata(fts, state, trama_bm25_free);
    if (rc != SQLITE_OK) { sqlite3_result_error_code(ctx, rc); return; }
  }
  double *frequency = sqlite3_malloc64(phrases * sizeof(double));
  if (!frequency) { sqlite3_result_error_nomem(ctx); return; }
  memset(frequency, 0, phrases * sizeof(double));
  int instances = 0, length = 0;
  rc = api->xInstCount(fts, &instances);
  for (int i = 0; i < instances && rc == SQLITE_OK; ++i) {
    int phrase, column, offset;
    rc = api->xInst(fts, i, &phrase, &column, &offset);
    if (rc == SQLITE_OK) frequency[phrase] += 1;
  }
  if (rc == SQLITE_OK) rc = api->xColumnSize(fts, 0, &length);
  sqlite3_int64 note = sqlite3_value_int64(argv[0]);
  double documents = sqlite3_value_double(argv[1]);
  double average = sqlite3_value_double(argv[2]) / documents, score = 0;
  for (int phrase = 0; phrase < phrases && rc == SQLITE_OK; ++phrase) {
    TramaPhraseCount key = {note, phrase, 0};
    TramaPhraseCount *hit = bsearch(&key, state->rows, state->count, sizeof(key), trama_phrase_compare);
    double count = hit ? hit->count : 0;
    double idf = log((documents - count + 0.5) / (count + 0.5));
    if (idf <= 0) idf = 1e-6;
    double denominator = frequency[phrase] + 1.2 * (0.25 + 0.75 * length / average);
    if (frequency[phrase] > 0) score += idf * frequency[phrase] * 2.2 / denominator;
  }
  sqlite3_free(frequency);
  if (rc != SQLITE_OK) sqlite3_result_error_code(ctx, rc);
  else sqlite3_result_double(ctx, -score);
}

/* SQLite's UTF-8 BINARY ordering differs from JS UTF-16 for astral paths. */
typedef struct { const unsigned char *p, *end; int low; } TramaUtf16;
static int trama_code_unit(TramaUtf16 *text) {
  if (text->low) { int low = text->low; text->low = 0; return low; }
  if (text->p == text->end) return -1;
  unsigned int value = *text->p++;
  int continuation = value < 0x80 ? 0 : value < 0xe0 ? 1 : value < 0xf0 ? 2 : 3;
  if (continuation) value &= (1 << (6-continuation))-1;
  while (continuation-- && text->p < text->end) value = (value << 6) | (*text->p++ & 0x3f);
  if (value > 0xffff) {
    value -= 0x10000;
    text->low = 0xdc00 + (value & 0x3ff);
    return 0xd800 + (value >> 10);
  }
  return (int)value;
}
static int trama_path_compare(void *ctx, int na, const void *a, int nb, const void *b) {
  (void)ctx;
  TramaUtf16 x = {a,(const unsigned char *)a+na,0}, y = {b,(const unsigned char *)b+nb,0};
  for (;;) {
    int left = trama_code_unit(&x), right = trama_code_unit(&y);
    if (left != right) return left < right ? -1 : 1;
    if (left < 0) return 0;
  }
}

static int trama_sqlite_init(sqlite3 *db, char **error, const sqlite3_api_routines *routines) {
  (void)error; (void)routines;
  int flags = SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS;
  int rc = sqlite3_create_collation(db, "trama_code_units", SQLITE_UTF8, NULL, trama_path_compare);
  if (rc == SQLITE_OK) rc = sqlite3_create_function_v2(db, "trama_vector_dot", 2, flags, NULL, trama_dot, NULL, NULL, NULL);
  if (rc == SQLITE_OK) rc = sqlite3_create_function_v2(db, "trama_vector_centroid", 1, SQLITE_UTF8 | SQLITE_INNOCUOUS,
    NULL, NULL, trama_centroid_step, trama_centroid_final, NULL);
  fts5_api *api = trama_fts_api(db);
  if (rc == SQLITE_OK && !api) rc = SQLITE_ERROR;
  if (rc == SQLITE_OK) rc = sqlite3_create_function_v2(db, "trama_token_count", 1, flags, api, trama_token_count, NULL, NULL, NULL);
  if (rc == SQLITE_OK) rc = api->xCreateFunction(api, "trama_passage_bm25", NULL, trama_passage_bm25, NULL);
  return rc;
}
