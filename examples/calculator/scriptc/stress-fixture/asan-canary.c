// Intentionally invalid test-only native code. Never linked into the stress app
// or a package: the separate canary executable must fail with an ASan diagnostic.
#include <stdint.h>
#include <stdlib.h>

uint32_t rustra_stress_asan_canary(void) {
  volatile uint32_t *value = malloc(sizeof(uint32_t));
  *value = 42;
  free((void *)value);
  return *value;
}
