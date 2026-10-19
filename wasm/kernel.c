#include <stddef.h>
#include <stdint.h>

#if USE_SIMD
#include <wasm_simd128.h>
#endif

#ifndef HASH_TEST_MASK
#define HASH_TEST_MASK UINT32_MAX
#endif
#ifndef POINTER_BUCKETS
#define POINTER_BUCKETS 0
#endif
#ifndef HASH_MULTIPLIER
#define HASH_MULTIPLIER UINT64_C(0x9e3779b185ebca87)
#endif

#define EXPORT(name) __attribute__((export_name(#name)))
#define INLINE static inline __attribute__((always_inline))
#define MAX_STATIONS 10000
#define TABLE_SIZE 32768

// Fixed ABI shared with engine.mjs. Sums are signed integer tenths, not floats.
typedef struct {
  int64_t sum;
  uint32_t count;
  int16_t min;
  int16_t max;
  uint32_t name_offset;
  uint32_t length;
  uint32_t hash;
  uint32_t reserved;
  uint64_t head;
  uint64_t tail;
} Station;

_Static_assert(sizeof(Station) == 48, "station ABI size");
_Static_assert(offsetof(Station, count) == 8, "station ABI count");
_Static_assert(offsetof(Station, name_offset) == 16, "station ABI name");
_Static_assert(offsetof(Station, head) == 32, "station ABI head");

#if POINTER_BUCKETS
static uint32_t buckets[TABLE_SIZE];
#else
static uint16_t buckets[TABLE_SIZE];
#endif
static Station stations[MAX_STATIONS];
static uint8_t names[MAX_STATIONS * 104 + 16];
static uint16_t temperatures[4096];
static uint32_t used;
static uint32_t name_used;
extern uint8_t __heap_base;

static const uint64_t byte_masks[9] = {
    0,
    UINT64_C(0xff),
    UINT64_C(0xffff),
    UINT64_C(0xffffff),
    UINT64_C(0xffffffff),
    UINT64_C(0xffffffffff),
    UINT64_C(0xffffffffffff),
    UINT64_C(0xffffffffffffff),
    UINT64_MAX,
};

// These freestanding implementations keep the module independent of libc/WASI.
void *memcpy(void *destination, const void *source, size_t length) {
  uint8_t *out = destination;
  const uint8_t *in = source;
  for (size_t i = 0; i < length; i++) out[i] = in[i];
  return destination;
}

void *memset(void *destination, int value, size_t length) {
  uint8_t *out = destination;
  for (size_t i = 0; i < length; i++) out[i] = (uint8_t)value;
  return destination;
}

INLINE uint64_t load64(const uint8_t *p) {
  uint64_t value;
  __builtin_memcpy(&value, p, sizeof(value));
  return value;
}

INLINE uint32_t load32(const uint8_t *p) {
  uint32_t value;
  __builtin_memcpy(&value, p, sizeof(value));
  return value;
}

INLINE uint64_t mix(uint64_t hash, uint64_t word) { return (hash ^ word) * HASH_MULTIPLIER; }

INLINE int same_name(const Station *station, const uint8_t *start, uint32_t length, uint64_t head) {
  if (station->length != length || station->head != head) return 0;
  if (length <= 8) return 1;
  if (load64(start + length - 8) != station->tail) return 0;
  if (length <= 16) return 1;
  const uint8_t *key = names + station->name_offset;
#if USE_SIMD
  // Cached head/tail are only filters. Compare EVERY middle byte, including
  // the final overlapping vector; never compare beyond the actual key.
  const uint32_t last = length - 16;
  for (uint32_t i = 8; i < last; i += 16) {
    v128_t a = wasm_v128_load(start + i);
    v128_t b = wasm_v128_load(key + i);
    if (wasm_i8x16_bitmask(wasm_i8x16_eq(a, b)) != 0xffff) return 0;
  }
  return wasm_i8x16_bitmask(
             wasm_i8x16_eq(wasm_v128_load(start + last), wasm_v128_load(key + last))) == 0xffff;
#else
  for (uint32_t i = 8; i < length - 8; i += 8) {
    if (load64(start + i) != load64(key + i)) return 0;
  }
  return 1;
#endif
}

INLINE Station *find_station(const uint8_t *start, uint32_t length, uint32_t hash, uint64_t head) {
  uint32_t slot = (hash ^ (hash >> 16)) & (TABLE_SIZE - 1);
  for (;;) {
    uint32_t entry = buckets[slot];
    if (entry == 0) {
      if (used >= MAX_STATIONS || length == 0 || length > 100) __builtin_trap();
      Station *station = &stations[used++];
#if POINTER_BUCKETS
      // Native Wasm pointers fit in 32 bits. Avoid the dependent ID-to-record
      // multiply in the hot lookup path; measure the larger table separately.
      buckets[slot] = (uint32_t)(uintptr_t)station;
#else
      buckets[slot] = (uint16_t)used;
#endif
      station->sum = 0;
      station->count = 0;
      station->min = 999;
      station->max = -999;
      station->name_offset = name_used;
      station->length = length;
      station->hash = hash;
      station->head = head;
      station->tail = length > 8 ? load64(start + length - 8) : head;
      memcpy(names + name_used, start, length);
      name_used = (name_used + length + 7) & ~7u;
      return station;
    }
#if POINTER_BUCKETS
    Station *station = (Station *)(uintptr_t)entry;
#else
    Station *station = &stations[entry - 1];
#endif
    if (station->hash == hash && same_name(station, start, length, head)) return station;
    slot = (slot + 1) & (TABLE_SIZE - 1);
  }
}

INLINE const uint8_t *process_row(const uint8_t *p) {
  const uint8_t *start = p;
  uint64_t hash = 0;
  uint64_t first = load64(start);
#if USE_SIMD
  const v128_t separator = wasm_i8x16_splat(';');
  for (;;) {
    v128_t block = wasm_v128_load(p);
    uint32_t matches = (uint32_t)wasm_i8x16_bitmask(wasm_i8x16_eq(block, separator));
    if (matches) {
      uint32_t length = (uint32_t)__builtin_ctz(matches);
      if (length >= 8) {
        hash = mix(hash, load64(p));
        p += 8;
        length -= 8;
      }
      if (length) hash = mix(hash, load64(p) & byte_masks[length]);
      p += length;
      break;
    }
    hash = mix(hash, load64(p));
    hash = mix(hash, load64(p + 8));
    p += 16;
  }
#else
  for (;;) {
    uint64_t word = load64(p);
    uint64_t x = word ^ UINT64_C(0x3b3b3b3b3b3b3b3b);
    uint64_t matches = (x - UINT64_C(0x0101010101010101)) & ~x & UINT64_C(0x8080808080808080);
    if (matches) {
      uint32_t length = (uint32_t)__builtin_ctzll(matches) >> 3;
      if (length) hash = mix(hash, word & byte_masks[length]);
      p += length;
      break;
    }
    hash = mix(hash, word);
    p += 8;
  }
#endif
  uint32_t length = (uint32_t)(p - start);
  uint64_t head = length < 8 ? first & byte_masks[length] : first;
  uint32_t fingerprint = (uint32_t)(hash ^ (hash >> 32)) & HASH_TEST_MASK;
  p++;
  // Derive the next-row pointer without waiting on the station lookup.
  uint32_t word = load32(p);
  uint32_t negative = (~word >> 4) & 1;
  uint32_t digits = word >> (negative * 8);
  uint32_t width = 4 + negative + ((digits >> 12) & 1);
  int32_t value = temperatures[digits & 0x0f0f] + (p[width - 2] & 15);
  value = (value ^ -(int32_t)negative) + (int32_t)negative;
  const uint8_t *next = p + width + (p[width - 1] == '\r');

  Station *station = find_station(start, length, fingerprint, head);
  station->sum += value;
  station->count++;
  if (value < station->min) station->min = (int16_t)value;
  if (value > station->max) station->max = (int16_t)value;
  return next;
}

EXPORT(reset) void reset(void) {
  memset(buckets, 0, sizeof(buckets));
  used = 0;
  name_used = 0;
  for (uint32_t first = 0; first <= 9; first++) {
    temperatures[0xe00 | first] = (uint16_t)(first * 10);
    for (uint32_t second = 0; second <= 9; second++) {
      temperatures[(second << 8) | first] = (uint16_t)(first * 100 + second * 10);
    }
  }
}

EXPORT(input_base) uint32_t input_base(void) { return (uint32_t)(uintptr_t)&__heap_base; }
EXPORT(stations_base) uint32_t stations_base(void) { return (uint32_t)(uintptr_t)stations; }
EXPORT(keys_base) uint32_t keys_base(void) { return (uint32_t)(uintptr_t)names; }
EXPORT(station_count) uint32_t station_count(void) { return used; }
EXPORT(station_stride) uint32_t station_stride(void) { return sizeof(Station); }
EXPORT(simd_enabled) uint32_t simd_enabled(void) { return USE_SIMD; }

static const uint8_t *boundary(const uint8_t *begin, const uint8_t *end, uint32_t part,
                               uint32_t lanes) {
  const uint8_t *p = begin + (uint32_t)(end - begin) * part / lanes;
  if (p == begin) return p;
  while (p < end && p[-1] != '\n') p++;
  return p;
}

EXPORT(parse1) void parse1(uint32_t begin, uint32_t end) {
  const uint8_t *p = (const uint8_t *)(uintptr_t)begin;
  const uint8_t *limit = (const uint8_t *)(uintptr_t)end;
  while (p < limit) p = process_row(p);
}

EXPORT(parse2) void parse2(uint32_t begin, uint32_t end) {
  if (begin >= end) return;
  const uint8_t *a = (const uint8_t *)(uintptr_t)begin;
  const uint8_t *limit = (const uint8_t *)(uintptr_t)end;
  const uint8_t *middle = boundary(a, limit, 1, 2);
  const uint8_t *b = middle;
  while (a < middle && b < limit) {
    a = process_row(a);
    b = process_row(b);
  }
  while (a < middle) a = process_row(a);
  while (b < limit) b = process_row(b);
}

EXPORT(parse3) void parse3(uint32_t begin, uint32_t end) {
  if (begin >= end) return;
  const uint8_t *a = (const uint8_t *)(uintptr_t)begin;
  const uint8_t *limit = (const uint8_t *)(uintptr_t)end;
  const uint8_t *end_a = boundary(a, limit, 1, 3);
  const uint8_t *end_b = boundary(a, limit, 2, 3);
  const uint8_t *b = end_a;
  const uint8_t *c = end_b;
  while (a < end_a && b < end_b && c < limit) {
    a = process_row(a);
    b = process_row(b);
    c = process_row(c);
  }
  while (a < end_a) a = process_row(a);
  while (b < end_b) b = process_row(b);
  while (c < limit) c = process_row(c);
}

EXPORT(parse4) void parse4(uint32_t begin, uint32_t end) {
  if (begin >= end) return;
  const uint8_t *a = (const uint8_t *)(uintptr_t)begin;
  const uint8_t *limit = (const uint8_t *)(uintptr_t)end;
  const uint8_t *end_a = boundary(a, limit, 1, 4);
  const uint8_t *end_b = boundary(a, limit, 2, 4);
  const uint8_t *end_c = boundary(a, limit, 3, 4);
  const uint8_t *b = end_a;
  const uint8_t *c = end_b;
  const uint8_t *d = end_c;
  while (a < end_a && b < end_b && c < end_c && d < limit) {
    a = process_row(a);
    b = process_row(b);
    c = process_row(c);
    d = process_row(d);
  }
  while (a < end_a) a = process_row(a);
  while (b < end_b) b = process_row(b);
  while (c < end_c) c = process_row(c);
  while (d < limit) d = process_row(d);
}
