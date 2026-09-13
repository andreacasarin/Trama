#include "sqlite3.h"
#define SQLITE_CORE 1
#define SQLITE_VEC_STATIC 1
#define SQLITE_VEC_OMIT_FS 1
#include "sqlite-vec.c"

int sqlite3_wasm_extra_init(const char *z) {
  (void)z;
  return sqlite3_auto_extension((void (*)(void))sqlite3_vec_init);
}
