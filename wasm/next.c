#include <stddef.h>
#include <stdint.h>
#include <wasm_simd128.h>

#ifndef COMPACT_STATIONS
#define COMPACT_STATIONS 0
#endif
#ifndef ADAPTIVE_TABLE
#define ADAPTIVE_TABLE 0
#endif
#ifndef INITIAL_BITS
#define INITIAL_BITS 11
#endif
#ifndef OUTLINE_INSERT
#define OUTLINE_INSERT 0
#endif
#ifndef STREAMING_SCAN
#define STREAMING_SCAN 0
#endif
#ifndef STREAM_BATCH
#define STREAM_BATCH 32
#endif
#ifndef HASH_TEST_MASK
#define HASH_TEST_MASK UINT32_MAX
#endif

#define EXPORT(name) __attribute__((export_name(#name)))
#define INLINE static inline __attribute__((always_inline))
#define MAX_STATIONS 10000
#define TABLE_SIZE 32768
#define OFFSET_MASK UINT32_C(0xfffff)

// The first 16 bytes preserve the result ABI. Compact records combine an
// arena offset (20 bits) and byte length (7 bits) in one word, saving 8 bytes
// including alignment. The complete valid arena fits, not just this dataset.
typedef struct {
  int64_t sum;
  uint32_t count;
  int16_t min;
  int16_t max;
#if COMPACT_STATIONS
  uint32_t hash;
  uint32_t key;
#else
  uint32_t name_offset;
  uint32_t length;
  uint32_t hash;
  uint32_t reserved;
#endif
  uint64_t head;
  uint64_t tail;
} Station;

_Static_assert(sizeof(Station) == (COMPACT_STATIONS ? 40 : 48), "station ABI size");
_Static_assert(offsetof(Station, count) == 8, "station ABI count");
_Static_assert(offsetof(Station, min) == 12, "station ABI minimum");
_Static_assert(MAX_STATIONS * 104 + 16 < (1 << 20), "entire key arena fits packed offset");

static uint32_t buckets[TABLE_SIZE];
static Station stations[MAX_STATIONS];
static uint8_t names[MAX_STATIONS * 104 + 16];
static uint16_t temperatures[4096];
static uint32_t used;
static uint32_t name_used;
#if ADAPTIVE_TABLE
static uint32_t active_mask;
static uint32_t resizes;
#endif
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

INLINE uint32_t key_length(const Station *station) {
#if COMPACT_STATIONS
  return station->key >> 20;
#else
  return station->length;
#endif
}

INLINE uint32_t key_offset(const Station *station) {
#if COMPACT_STATIONS
  return station->key & OFFSET_MASK;
#else
  return station->name_offset;
#endif
}

INLINE uint32_t table_mask(void) {
#if ADAPTIVE_TABLE
  return active_mask;
#else
  return TABLE_SIZE - 1;
#endif
}

INLINE uint64_t mix(uint64_t hash, uint64_t word) {
  return (hash ^ word) * UINT64_C(0x9e3779b185ebca87);
}

INLINE int same_name(const Station *station, const uint8_t *start, uint32_t length, uint64_t head) {
  if (key_length(station) != length || station->head != head) return 0;
  if (length <= 8) return 1;
  if (load64(start + length - 8) != station->tail) return 0;
  if (length <= 16) return 1;
  const uint8_t *key = names + key_offset(station);
  const uint32_t last = length - 16;
  for (uint32_t i = 8; i < last; i += 16) {
    if (wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(start + i), wasm_v128_load(key + i))) !=
        0xffff)
      return 0;
  }
  return wasm_i8x16_bitmask(
             wasm_i8x16_eq(wasm_v128_load(start + last), wasm_v128_load(key + last))) == 0xffff;
}

#if ADAPTIVE_TABLE
__attribute__((noinline, cold)) static void grow_table(void) {
  uint32_t size = (active_mask + 1) * 2;
  if (size > TABLE_SIZE) __builtin_trap();
  // Clear the entire new prefix, including stale slots from a prior reset.
  memset(buckets, 0, size * sizeof(buckets[0]));
  active_mask = size - 1;
  for (uint32_t i = 0; i < used; i++) {
    Station *station = &stations[i];
    uint32_t hash = station->hash;
    uint32_t slot = (hash ^ (hash >> 16)) & active_mask;
    while (buckets[slot]) slot = (slot + 1) & active_mask;
    buckets[slot] = (uint32_t)(uintptr_t)station;
  }
  resizes++;
}
#endif

#if OUTLINE_INSERT
#define INSERT_FUNCTION static __attribute__((noinline, cold))
#else
#define INSERT_FUNCTION INLINE
#endif

INSERT_FUNCTION Station *insert_station(const uint8_t *start, uint32_t length, uint32_t hash,
                                        uint64_t head, uint32_t slot) {
  if (used >= MAX_STATIONS || length == 0 || length > 100) __builtin_trap();
  Station *station = &stations[used++];
  buckets[slot] = (uint32_t)(uintptr_t)station;
  station->sum = 0;
  station->count = 0;
  station->min = 999;
  station->max = -999;
#if COMPACT_STATIONS
  station->key = (length << 20) | name_used;
#else
  station->name_offset = name_used;
  station->length = length;
#endif
  station->hash = hash;
  station->head = head;
  station->tail = length > 8 ? load64(start + length - 8) : head;
  memcpy(names + name_used, start, length);
  name_used = (name_used + length + 7) & ~7u;
  return station;
}

INLINE Station *find_station(const uint8_t *start, uint32_t length, uint32_t hash, uint64_t head) {
  uint32_t mask = table_mask();
  uint32_t slot = (hash ^ (hash >> 16)) & mask;
  for (;;) {
    uint32_t entry = buckets[slot];
    if (entry == 0) {
#if ADAPTIVE_TABLE
      if ((used + 1) * 2 > mask + 1) {
        grow_table();
        mask = table_mask();
        slot = (hash ^ (hash >> 16)) & mask;
        continue;
      }
#endif
      return insert_station(start, length, hash, head, slot);
    }
    Station *station = (Station *)(uintptr_t)entry;
    if (station->hash == hash && same_name(station, start, length, head)) return station;
    slot = (slot + 1) & mask;
  }
}

INLINE void accumulate(Station *station, int32_t value) {
  station->sum += value;
  station->count++;
  if (value < station->min) station->min = (int16_t)value;
  if (value > station->max) station->max = (int16_t)value;
}

INLINE const uint8_t *temperature(const uint8_t *p, int32_t *result) {
  uint32_t word = load32(p);
  uint32_t negative = (~word >> 4) & 1;
  uint32_t digits = word >> (negative * 8);
  uint32_t width = 4 + negative + ((digits >> 12) & 1);
  int32_t value = temperatures[digits & 0x0f0f] + (p[width - 2] & 15);
  *result = (value ^ -(int32_t)negative) + (int32_t)negative;
  return p + width + (p[width - 1] == '\r');
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
  uint32_t fingerprint = (uint32_t)(hash ^ (hash >> 32)) & HASH_TEST_MASK;
  int32_t value;
  const uint8_t *next = temperature(p + 1, &value);
  accumulate(find_station(start, length, fingerprint, head), value);
  return next;
}

EXPORT(reset) void reset(void) {
#if ADAPTIVE_TABLE
  active_mask = (1u << INITIAL_BITS) - 1;
  resizes = 0;
#endif
  memset(buckets, 0, (table_mask() + 1) * sizeof(buckets[0]));
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
EXPORT(simd_enabled) uint32_t simd_enabled(void) { return 1; }
EXPORT(streaming_enabled) uint32_t streaming_enabled(void) { return STREAMING_SCAN; }
EXPORT(table_capacity) uint32_t table_capacity(void) { return table_mask() + 1; }
EXPORT(table_resizes) uint32_t table_resizes(void) {
#if ADAPTIVE_TABLE
  return resizes;
#else
  return 0;
#endif
}

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

#if STREAMING_SCAN
typedef struct {
  const uint8_t *start;
  uint32_t length;
  uint32_t hash;
  int32_t value;
  uint64_t head;
} Token;
static Token tokens[STREAM_BATCH];

// Scan the text in contiguous 32-byte windows, retaining ALL separator bits
// across rows. This differs from loading a fresh vector at each station name.
// Small bounded batches keep token traffic in L1, with no host calls per row.
EXPORT(parse_stream) void parse_stream(uint32_t begin, uint32_t end) {
  if (begin >= end) return;
  const uint8_t *row = (const uint8_t *)(uintptr_t)begin;
  const uint8_t *limit = (const uint8_t *)(uintptr_t)end;
  const uint8_t *scan = row;
  const uint8_t *window = row;
  uint32_t marks = 0;
  const v128_t separator = wasm_i8x16_splat(';');
  while (row < limit) {
    uint32_t count = 0;
    while (count < STREAM_BATCH && row < limit) {
      while (marks == 0) {
        window = scan;
        marks = (uint32_t)wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(scan), separator));
        marks |= (uint32_t)wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(scan + 16), separator))
                 << 16;
        scan += 32;
      }
      const uint8_t *semicolon = window + (uint32_t)__builtin_ctz(marks);
      marks &= marks - 1;
      uint32_t length = (uint32_t)(semicolon - row);
      uint64_t hash = 0;
      uint32_t full = length & ~7u;
      for (uint32_t i = 0; i < full; i += 8) hash = mix(hash, load64(row + i));
      if (length & 7) hash = mix(hash, load64(row + full) & byte_masks[length & 7]);
      Token *token = &tokens[count++];
      token->start = row;
      token->length = length;
      token->hash = (uint32_t)(hash ^ (hash >> 32)) & HASH_TEST_MASK;
      token->head = load64(row) & byte_masks[length < 8 ? length : 8];
      row = temperature(semicolon + 1, &token->value);
    }
    uint32_t i = 0;
    for (; i + 3 < count; i += 4) {
      Token *a = &tokens[i];
      Token *b = &tokens[i + 1];
      Token *c = &tokens[i + 2];
      Token *d = &tokens[i + 3];
      Station *sa = find_station(a->start, a->length, a->hash, a->head);
      Station *sb = find_station(b->start, b->length, b->hash, b->head);
      Station *sc = find_station(c->start, c->length, c->hash, c->head);
      Station *sd = find_station(d->start, d->length, d->hash, d->head);
      accumulate(sa, a->value);
      accumulate(sb, b->value);
      accumulate(sc, c->value);
      accumulate(sd, d->value);
    }
    for (; i < count; i++) {
      Token *token = &tokens[i];
      accumulate(find_station(token->start, token->length, token->hash, token->head), token->value);
    }
  }
}
#endif
