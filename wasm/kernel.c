#include <stddef.h>
#include <stdint.h>
#include <wasm_simd128.h>

#define EXPORT(name) __attribute__((export_name(#name)))
#define INLINE static inline __attribute__((always_inline))
#define MAX_STATIONS 10000
#define TABLE_SIZE 32768
#define OFFSET_MASK UINT32_C(0xfffff)

// Fixed result ABI: integer tenths, an exact signed 64-bit sum, and a packed
// key descriptor. The entire valid arena fits in 20 bits; length needs only 7.
typedef struct {
  int64_t sum;
  uint32_t count;
  int16_t min;
  int16_t max;
  uint32_t hash;
  uint32_t key;
  uint64_t head;
  uint64_t tail;
} Station;

_Static_assert(sizeof(Station) == 40, "station ABI size");
_Static_assert(offsetof(Station, count) == 8, "station ABI count");
_Static_assert(offsetof(Station, key) == 20, "station ABI key");
_Static_assert(MAX_STATIONS * 104 + 16 < (1 << 20), "all valid key offsets fit");

static uint32_t buckets[TABLE_SIZE];
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

// Freestanding memory helpers: the module imports neither libc nor WASI.
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

INLINE uint64_t mix(uint64_t hash, uint64_t word) {
  return (hash ^ word) * UINT64_C(0x9e3779b185ebca87);
}

INLINE int same_name(const Station *station, const uint8_t *start, uint32_t length, uint64_t head) {
  if ((station->key >> 20) != length || station->head != head) return 0;
  if (length <= 8) return 1;
  if (load64(start + length - 8) != station->tail) return 0;
  if (length <= 16) return 1;
  const uint8_t *key = names + (station->key & OFFSET_MASK);
  const uint32_t last = length - 16;
  for (uint32_t i = 8; i < last; i += 16) {
    if (wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(start + i), wasm_v128_load(key + i))) !=
        0xffff)
      return 0;
  }
  // Overlap the last vector so every middle byte is checked without reading
  // beyond the actual name. Cached head/tail words alone are never sufficient.
  return wasm_i8x16_bitmask(
             wasm_i8x16_eq(wasm_v128_load(start + last), wasm_v128_load(key + last))) == 0xffff;
}

// At most 10K insertions versus 1B measurements: don't duplicate this cold
// initialization/copy path inside each of the four hot parsing lanes.
__attribute__((noinline, cold)) static Station *insert_station(const uint8_t *start,
                                                               uint32_t length, uint32_t hash,
                                                               uint64_t head, uint32_t slot) {
  if (used >= MAX_STATIONS || length == 0 || length > 100) __builtin_trap();
  Station *station = &stations[used++];
  buckets[slot] = (uint32_t)(uintptr_t)station;
  station->sum = 0;
  station->count = 0;
  station->min = 999;
  station->max = -999;
  station->hash = hash;
  station->key = (length << 20) | name_used;
  station->head = head;
  station->tail = length > 8 ? load64(start + length - 8) : head;
  memcpy(names + name_used, start, length);
  name_used = (name_used + length + 7) & ~7u;
  return station;
}

INLINE Station *find_station(const uint8_t *start, uint32_t length, uint32_t hash, uint64_t head) {
  uint32_t slot = (hash ^ (hash >> 16)) & (TABLE_SIZE - 1);
  for (;;) {
    uint32_t entry = buckets[slot];
    if (!entry) return insert_station(start, length, hash, head, slot);
    Station *station = (Station *)(uintptr_t)entry;
    if (station->hash == hash && same_name(station, start, length, head)) return station;
    slot = (slot + 1) & (TABLE_SIZE - 1);
  }
}

INLINE const uint8_t *process_row(const uint8_t *p) {
  const uint8_t *start = p;
  uint64_t hash = 0;
  uint64_t first = load64(start);
  const v128_t separator = wasm_i8x16_splat(';');
  for (;;) {
    uint32_t matches = (uint32_t)wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(p), separator));
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
  uint32_t length = (uint32_t)(p - start);
  uint64_t head = length < 8 ? first & byte_masks[length] : first;
  uint32_t fingerprint = (uint32_t)(hash ^ (hash >> 32));
  p++;
  uint32_t word = load32(p);
  uint32_t negative = (~word >> 4) & 1;
  uint32_t digits = word >> (negative * 8);
  uint32_t width = 4 + negative + ((digits >> 12) & 1);
  int32_t value = temperatures[digits & 0x0f0f] + (p[width - 2] & 15);
  value = (value ^ -(int32_t)negative) + (int32_t)negative;
  const uint8_t *next = p + width + (p[width - 1] == '\r');

  Station *station = find_station(start, length, fingerprint, head);
  v128_t stats = wasm_v128_load(station);
  v128_t added = wasm_i64x2_add(stats, wasm_i64x2_make(value, 1));
  v128_t values = wasm_i16x8_splat((int16_t)value);
  v128_t extrema = wasm_v128_bitselect(wasm_i16x8_max(stats, values), wasm_i16x8_min(stats, values),
                                       wasm_i16x8_make(0, 0, 0, 0, 0, 0, 0, -1));
  wasm_v128_store(station,
                  wasm_v128_bitselect(extrema, added, wasm_i16x8_make(0, 0, 0, 0, 0, 0, -1, -1)));
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
EXPORT(buckets_base) uint32_t buckets_base(void) { return (uint32_t)(uintptr_t)buckets; }
EXPORT(station_count) uint32_t station_count(void) { return used; }

static const uint8_t *boundary(const uint8_t *begin, const uint8_t *end, uint32_t part) {
  const uint8_t *p = begin + (uint32_t)(end - begin) * part / 4;
  if (p == begin) return p;
  while (p < end && p[-1] != '\n') p++;
  return p;
}

EXPORT(parse_chunk) void parse_chunk(uint32_t begin, uint32_t end) {
  if (begin >= end) return;
  const uint8_t *a = (const uint8_t *)(uintptr_t)begin;
  const uint8_t *limit = (const uint8_t *)(uintptr_t)end;
  const uint8_t *end_a = boundary(a, limit, 1);
  const uint8_t *end_b = boundary(a, limit, 2);
  const uint8_t *end_c = boundary(a, limit, 3);
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
