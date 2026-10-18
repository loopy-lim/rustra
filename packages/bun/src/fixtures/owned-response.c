#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static uint32_t counters[5]; /* into calls, owned calls, dispatches, owned frees, bad frees */
static size_t pending;
static void *allocation;
static size_t allocation_size;

uint32_t fixture_counter(uint32_t index) { return counters[index]; }
void fixture_reset(void) { memset(counters, 0, sizeof counters); pending = 0; }
void rustra_mobile_init(void) {}
uint64_t rustra_ffi_schema_generation(void) { return 1; }
void rustra_ffi_free(void *pointer, size_t length) { (void)length; free(pointer); }

void *rustra_ffi_get_schema(size_t *length) {
  const char *schema = "{\"schemaVersion\":1,\"packageId\":\"fixture\",\"commands\":[]}";
  *length = strlen(schema);
  void *result = malloc(*length);
  memcpy(result, schema, *length);
  return result;
}
void *rustra_ffi_contract_hash(size_t *length) {
  *length = 1;
  char *result = malloc(1);
  *result = 'x';
  return result;
}
void *rustra_ffi_invoke_frame(const uint8_t *input, size_t length, size_t *output_length) {
  (void)input; (void)length; *output_length = 0; return NULL;
}
static size_t requested(const uint8_t *input) {
  return (size_t)input[0] | (size_t)input[1] << 8 | (size_t)input[2] << 16;
}
static void fill(uint8_t *output, size_t length) {
  memset(output, 0, 8);
  output[0] = 1;
  uint32_t body = (uint32_t)(length - 8);
  memcpy(output + 4, &body, 4);
  for (size_t i = 8; i < length; ++i) output[i] = (uint8_t)(i % 251);
}
size_t rustra_ffi_invoke_frame_into(const uint8_t *input, size_t length,
                                  uint8_t *output, size_t capacity, size_t *output_length) {
  (void)length; ++counters[0];
  if (!pending) { ++counters[2]; pending = requested(input); }
  *output_length = pending;
  if (capacity < pending) return SIZE_MAX;
  fill(output, pending);
  size_t result = pending;
  pending = 0;
  return result;
}

#ifdef WITH_OWNED
void *rustra_ffi_invoke_frame_owned(const uint8_t *input, size_t length,
                                   uint8_t *output, size_t capacity, size_t *output_length) {
  (void)length; ++counters[1]; ++counters[2];
  size_t size = requested(input);
  *output_length = size;
  if (input[3] == 1) return NULL; /* Invalid null/oversized reply, no allocation. */
  if (size <= capacity && input[3] != 2) { fill(output, size); return NULL; }
  allocation = malloc(size);
  allocation_size = size;
  fill(allocation, size);
  return allocation;
}
#ifndef MISSING_OWNED_FREE
void rustra_ffi_free_owned_bytes(void *pointer, size_t length) {
  ++counters[3];
  if (pointer != allocation || length != allocation_size) { ++counters[4]; abort(); }
  /* Poison before release: returned JS frames must already own a copy. */
  memset(pointer, 0xa5, length);
  free(pointer);
  allocation = NULL;
  allocation_size = 0;
}
#endif
#endif
