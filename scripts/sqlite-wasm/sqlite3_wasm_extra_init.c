#define _GNU_SOURCE
#include <strings.h>
#include "sqlite3.h"
#define SQLITE_CORE 1
#include "sqlite-vector/distance-cpu.c"
#include "sqlite-vector/sqlite-vector.c"

int sqlite3_wasm_extra_init(const char *z) {
  (void)z;
  return sqlite3_auto_extension((void (*)(void))sqlite3_vector_init);
}
