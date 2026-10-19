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
static Station empty_station;
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

// Include the delimiter in short keys so their length is part of the SIMD key.
static const uint64_t short_masks[17][2] __attribute__((aligned(16))) = {
    {UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xff), UINT64_C(0x0)},
    {UINT64_C(0xffff), UINT64_C(0x0)},
    {UINT64_C(0xffffff), UINT64_C(0x0)},
    {UINT64_C(0xffffffff), UINT64_C(0x0)},
    {UINT64_C(0xffffffffff), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffff), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffff), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xff)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffff)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffff)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffff)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffff)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffff)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffff)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff)},
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

INLINE uint64_t mix_pair(uint64_t hash, uint64_t low, uint64_t high) {
  return (hash ^ low ^ UINT64_C(0x9e3779b185ebca87)) * (high ^ UINT64_C(0xc2b2ae3d27d4eb4f));
}

__attribute__((noinline, cold)) static int same_middle(const Station *station, const uint8_t *start,
                                                       uint32_t length) {
  const uint8_t *key = names + (station->key & OFFSET_MASK);
  const uint32_t last = length - 16;
  // Names are at most 100 bytes: five fixed middle vectors suffice.
  if (last > 8 && wasm_i8x16_bitmask(
                      wasm_i8x16_eq(wasm_v128_load(start + 8), wasm_v128_load(key + 8))) != 0xffff)
    return 0;
  if (last > 24 && wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(start + 24),
                                                    wasm_v128_load(key + 24))) != 0xffff)
    return 0;
  if (last > 40 && wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(start + 40),
                                                    wasm_v128_load(key + 40))) != 0xffff)
    return 0;
  if (last > 56 && wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(start + 56),
                                                    wasm_v128_load(key + 56))) != 0xffff)
    return 0;
  if (last > 72 && wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(start + 72),
                                                    wasm_v128_load(key + 72))) != 0xffff)
    return 0;
  // Overlap the last vector so every middle byte is checked without reading
  // beyond the actual name. Cached head/tail words alone are never sufficient.
  return wasm_i8x16_bitmask(
             wasm_i8x16_eq(wasm_v128_load(start + last), wasm_v128_load(key + last))) == 0xffff;
}

INLINE int same_name(const Station *station, const uint8_t *start, uint32_t length, uint64_t head) {
  if ((station->key >> 20) != length) return 0;
  if (length < 16) {
    v128_t key = wasm_v128_and(wasm_v128_load(start), wasm_v128_load(short_masks[length + 1]));
    return !wasm_v128_any_true(wasm_v128_xor(wasm_v128_load(&station->head), key));
  }
  if ((station->head != head) | (station->tail != load64(start + length - 8))) return 0;
  if (length == 16) return 1;
  return same_middle(station, start, length);
}

// At most 10K insertions versus 1B measurements: don't duplicate this cold
// initialization/copy path inside each hot parsing lane.
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
  if (length < 16) {
    v128_t key = wasm_v128_and(wasm_v128_load(start), wasm_v128_load(short_masks[length + 1]));
    wasm_v128_store(&station->head, key);
  } else {
    station->head = head;
    station->tail = load64(start + length - 8);
  }
  memcpy(names + name_used, start, length);
  name_used = (name_used + length + 7) & ~7u;
  return station;
}

__attribute__((noinline, cold)) static Station *probe_station(const uint8_t *start, uint32_t length,
                                                              uint64_t hash, uint64_t head,
                                                              uint32_t slot) {
  for (;;) {
    uint32_t entry = buckets[slot];
    if (entry == (uint32_t)(uintptr_t)&empty_station)
      return insert_station(start, length, (uint32_t)(hash ^ (hash >> 32)), head, slot);
    Station *station = (Station *)(uintptr_t)entry;
    if (same_name(station, start, length, head)) return station;
    slot = (slot + 1) & (TABLE_SIZE - 1);
  }
}

INLINE Station *find_station(const uint8_t *start, uint32_t length, uint64_t hash, uint64_t head) {
  uint32_t slot = (uint32_t)(hash >> 49);
  uint32_t entry = buckets[slot];
  if (entry == (uint32_t)(uintptr_t)&empty_station)
    return insert_station(start, length, (uint32_t)(hash ^ (hash >> 32)), head, slot);
  Station *station = (Station *)(uintptr_t)entry;
  if (same_name(station, start, length, head)) return station;
  return probe_station(start, length, hash, head, (slot + 1) & (TABLE_SIZE - 1));
}

typedef struct {
  const uint8_t *temperature;
  Station *station;
} ParsedRow;

typedef struct {
  // The 100-byte name limit fits in seven bits beside a full 32-bit pointer.
  uint64_t location;
  uint64_t hash;
} NameRow;

INLINE NameRow scan_name(const uint8_t *p) {
  const uint8_t *start = p;
  uint64_t hash = 0;
  const v128_t separator = wasm_i8x16_splat(';');
  for (;;) {
    uint32_t matches = (uint32_t)wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(p), separator));
    if (matches) {
      uint32_t length = (uint32_t)__builtin_ctz(matches);
      // Mask both words before selecting: name lengths vary unpredictably.
      uint32_t low_width = length < 8 ? length + 1 : 8;
      uint32_t high_width = length >= 8 ? length - 7 : 0;
      uint64_t low = load64(p) & byte_masks[low_width];
      uint64_t high = load64(p + 8) & byte_masks[high_width];
      hash = mix_pair(hash, low, high);
      p += length;
      break;
    }
    hash = mix_pair(hash, load64(p), load64(p + 8));
    p += 16;
  }
  uint32_t length = (uint32_t)(p - start);
  return (NameRow){((uint64_t)(uintptr_t)start << 7) | length, hash};
}

INLINE ParsedRow lookup_row(NameRow row) {
  const uint8_t *start = (const uint8_t *)(uintptr_t)(row.location >> 7);
  uint32_t length = (uint32_t)row.location & 127;
  uint64_t head = load64(start) & byte_masks[length < 8 ? length : 8];
  return (ParsedRow){start + length + 1, find_station(start, length, row.hash, head)};
}

INLINE ParsedRow scan_row(const uint8_t *p) { return lookup_row(scan_name(p)); }

INLINE const uint8_t *update_row(ParsedRow row) {
  const uint8_t *p = row.temperature;
  uint32_t word = load32(p);
  uint32_t negative = (~word >> 4) & 1;
  uint32_t digits = word >> (negative * 8);
  uint32_t width = 4 + negative + ((digits >> 12) & 1);
  int32_t value = temperatures[digits & 0x0f0f] + (p[width - 2] & 15);
  value = (value ^ -(int32_t)negative) + (int32_t)negative;
  const uint8_t *next = p + width + (p[width - 1] == '\r');

  Station *station = row.station;
  // Counts stay below 2^32, so adding one cannot carry into packed min/max.
  // Update the exact sum/count together and blend in signed 16-bit extrema.
  v128_t stats = wasm_v128_load(station);
  v128_t added = wasm_i64x2_add(stats, wasm_i64x2_make(value, 1));
  v128_t values = wasm_i16x8_splat((int16_t)value);
  // Fixed lane selections let the host compiler use immediate SIMD blends.
  v128_t extrema = wasm_i16x8_shuffle(wasm_i16x8_min(stats, values), wasm_i16x8_max(stats, values),
                                      0, 1, 2, 3, 4, 5, 6, 15);
  wasm_v128_store(station, wasm_i16x8_shuffle(added, extrema, 0, 1, 2, 3, 4, 5, 14, 15));
  return next;
}

INLINE const uint8_t *process_row(const uint8_t *p) { return update_row(scan_row(p)); }

INLINE const uint8_t *process_short(const uint8_t *start, uint32_t matches, v128_t bytes) {
  uint32_t length = (uint32_t)__builtin_ctz(matches);
  v128_t key = wasm_v128_and(bytes, wasm_v128_load(short_masks[length + 1]));
  uint64_t head = (uint64_t)wasm_i64x2_extract_lane(key, 0);
  uint64_t high = (uint64_t)wasm_i64x2_extract_lane(key, 1);
  uint64_t hash = mix_pair(0, head, high);
  uint32_t slot = (uint32_t)(hash >> 49);
  Station *station = (Station *)(uintptr_t)buckets[slot];
  // An empty record is all zero; a key containing ';' can never match it.
  if (wasm_v128_any_true(wasm_v128_xor(wasm_v128_load(&station->head), key))) {
    station = find_station(start, length, hash, head);
  }
  return update_row((ParsedRow){start + length + 1, station});
}

typedef struct {
  const uint8_t *a;
  const uint8_t *b;
  const uint8_t *c;
} RowPointers;

// Preserve the complete valid-input parser when any name needs another block.
__attribute__((noinline, cold)) static RowPointers process_three(const uint8_t *a, const uint8_t *b,
                                                                 const uint8_t *c) {
  NameRow name_a = scan_name(a);
  NameRow name_b = scan_name(b);
  NameRow name_c = scan_name(c);
  ParsedRow row_a = lookup_row(name_a);
  ParsedRow row_b = lookup_row(name_b);
  ParsedRow row_c = lookup_row(name_c);
  const uint8_t *next_a = update_row(row_a);
  const uint8_t *next_b = update_row(row_b);
  const uint8_t *next_c = update_row(row_c);
  return (RowPointers){next_a, next_b, next_c};
}

EXPORT(reset) void reset(void) {
  for (uint32_t slot = 0; slot < TABLE_SIZE; slot++)
    buckets[slot] = (uint32_t)(uintptr_t)&empty_station;
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
EXPORT(empty_station_base) uint32_t empty_station_base(void) {
  return (uint32_t)(uintptr_t)&empty_station;
}

static const uint8_t *boundary(const uint8_t *begin, const uint8_t *end, uint32_t part) {
  const uint8_t *p = begin + (uint32_t)(end - begin) * part / 3;
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
  const uint8_t *b = end_a;
  const uint8_t *c = end_b;
  while (a < end_a && b < end_b && c < limit) {
    const v128_t separator = wasm_i8x16_splat(';');
    v128_t bytes_a = wasm_v128_load(a);
    v128_t bytes_b = wasm_v128_load(b);
    v128_t bytes_c = wasm_v128_load(c);
    uint32_t matches_a = wasm_i8x16_bitmask(wasm_i8x16_eq(bytes_a, separator));
    uint32_t matches_b = wasm_i8x16_bitmask(wasm_i8x16_eq(bytes_b, separator));
    uint32_t matches_c = wasm_i8x16_bitmask(wasm_i8x16_eq(bytes_c, separator));
    if ((matches_a != 0) & (matches_b != 0) & (matches_c != 0)) {
      a = process_short(a, matches_a, bytes_a);
      b = process_short(b, matches_b, bytes_b);
      c = process_short(c, matches_c, bytes_c);
    } else {
      RowPointers next = process_three(a, b, c);
      a = next.a;
      b = next.b;
      c = next.c;
    }
  }
  while (a < end_a) a = process_row(a);
  while (b < end_b) b = process_row(b);
  while (c < limit) c = process_row(c);
}
