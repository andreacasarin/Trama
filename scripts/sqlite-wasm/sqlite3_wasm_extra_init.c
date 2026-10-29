#include "sqlite3.h"
#include <math.h>
#include <string.h>

static int trama_sqlite_init(sqlite3 *, char **, const sqlite3_api_routines *);

int sqlite3_wasm_extra_init(const char *z) {
  (void)z;
  return sqlite3_auto_extension((void (*)(void))trama_sqlite_init);
}

/* Stored Float32 components, double precision arithmetic (also used by validation).
   Retrieval normalizes inputs once, so this dot product is cosine similarity. */
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

static int trama_sqlite_init(sqlite3 *db, char **error, const sqlite3_api_routines *routines) {
  (void)error; (void)routines;
  int flags = SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS;
  int rc = sqlite3_create_function_v2(db, "trama_vector_dot", 2, flags, NULL, trama_dot, NULL, NULL, NULL);
  if (rc == SQLITE_OK) rc = sqlite3_create_function_v2(db, "trama_vector_centroid", 1, SQLITE_UTF8 | SQLITE_INNOCUOUS,
    NULL, NULL, trama_centroid_step, trama_centroid_final, NULL);
  return rc;
}
