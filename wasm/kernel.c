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
// Names below 16 bytes cache their delimiter-terminated key in head/tail;
// longer names cache raw words without a delimiter, so they never match one.
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
_Static_assert(MAX_STATIONS * 104 + 48 < (1 << 20), "all valid key offsets fit");

static uint32_t buckets[TABLE_SIZE];
static Station stations[MAX_STATIONS];
static Station empty_station;
// Canonical keys: the name, its delimiter and zero padding to at least 32 bytes.
// The first 32 bytes belong to the empty record and never match a canonical key.
static uint8_t names[MAX_STATIONS * 104 + 48];
// Indexed by the low nibbles of the two bytes before the decimal (';', '-' or
// tens, then units) and of the tenths digit, plus the sign bit. Each entry is
// the byte offset of that temperature's statistics delta.
static uint16_t temperatures[1 << 16];
// One statistics delta per legal temperature: the signed sum increment, a
// count increment, then the value again in the min/max lanes.
static v128_t deltas[1999];
static uint32_t used;
// The mixing words start fixed. While the table is sparse, an insertion that
// lands beyond its first bucket retunes them so every station hits directly.
static uint64_t mixers[2] __attribute__((aligned(16)));
// Delimiter splats for the hot loop, loaded rather than rebuilt each iteration.
static v128_t separators;
static v128_t newlines;
static uint64_t mixer_seed;
static uint32_t retunes_left;
static uint32_t claimed[TABLE_SIZE / 32];
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

// Entry n keeps n name bytes plus the delimiter; no empty mask is needed.
static const uint64_t short_masks[16][2] __attribute__((aligned(16))) = {
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

// Entry n keeps n name bytes plus the delimiter in a 32-byte key.
static const uint64_t wide_masks[32][4] __attribute__((aligned(16))) = {
    {UINT64_C(0xff), UINT64_C(0x0), UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xffff), UINT64_C(0x0), UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xffffff), UINT64_C(0x0), UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xffffffff), UINT64_C(0x0), UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xffffffffff), UINT64_C(0x0), UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffff), UINT64_C(0x0), UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffff), UINT64_C(0x0), UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0x0), UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xff), UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffff), UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffff), UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffff), UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffff), UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffff), UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffff), UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0x0), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0xff), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0xffff), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0xffffff), UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffff),
     UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffff),
     UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffff),
     UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffff),
     UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff),
     UINT64_C(0x0)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff),
     UINT64_C(0xff)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff),
     UINT64_C(0xffff)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff),
     UINT64_C(0xffffff)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff),
     UINT64_C(0xffffffff)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff),
     UINT64_C(0xffffffffff)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff),
     UINT64_C(0xffffffffffff)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff),
     UINT64_C(0xffffffffffffff)},
    {UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff), UINT64_C(0xffffffffffffffff),
     UINT64_C(0xffffffffffffffff)},
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

INLINE uint64_t mix_pair(uint64_t hash, uint64_t low, uint64_t high, const uint64_t *mix) {
  return (hash ^ low ^ mix[0]) * (high ^ mix[1]);
}

INLINE uint32_t same_vector(const uint8_t *a, const uint8_t *b) {
  return (uint32_t)wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(a), wasm_v128_load(b)));
}

// Names are at most 100 bytes: five fixed middle vectors suffice.
__attribute__((noinline, cold)) static int same_middle(const uint8_t *key, const uint8_t *start,
                                                       uint32_t last) {
  if (last > 16 && same_vector(start + 16, key + 16) != 0xffff) return 0;
  if (last > 32 && same_vector(start + 32, key + 32) != 0xffff) return 0;
  if (last > 48 && same_vector(start + 48, key + 48) != 0xffff) return 0;
  if (last > 64 && same_vector(start + 64, key + 64) != 0xffff) return 0;
  return last <= 80 || same_vector(start + 80, key + 80) == 0xffff;
}

INLINE int same_name(const Station *station, const uint8_t *start, uint32_t length) {
  if ((station->key >> 20) != length) return 0;
  if (length < 16) {
    v128_t key = wasm_v128_and(wasm_v128_load(start), wasm_v128_load(short_masks[length]));
    return !wasm_v128_any_true(wasm_v128_xor(wasm_v128_load(&station->head), key));
  }
  // The first and an overlapping final vector cover every byte of names up to
  // 32 bytes without reading beyond them. Longer names also check the middle.
  const uint8_t *key = names + (station->key & OFFSET_MASK);
  uint32_t last = length - 16;
  if ((same_vector(start, key) & same_vector(start + last, key + last)) != 0xffff) return 0;
  return last <= 16 || same_middle(key, start, last);
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
    v128_t key = wasm_v128_and(wasm_v128_load(start), wasm_v128_load(short_masks[length]));
    wasm_v128_store(&station->head, key);
  } else {
    station->head = head;
    station->tail = load64(start + length - 8);
  }
  uint8_t *key = names + name_used;
  wasm_v128_store(key, wasm_i64x2_const(0, 0));
  wasm_v128_store(key + 16, wasm_i64x2_const(0, 0));
  memcpy(key, start, length);
  key[length] = ';';
  uint32_t size = (length + 8) & ~7u;
  name_used += size < 32 ? 32 : size;
  return station;
}

typedef struct {
  // The 100-byte name limit fits in seven bits beside a full 32-bit pointer.
  uint64_t location;
  uint64_t hash;
} NameRow;

INLINE NameRow scan_name(const uint8_t *p, const uint64_t *mix) {
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
      hash = mix_pair(hash, low, high, mix);
      p += length;
      break;
    }
    hash = mix_pair(hash, load64(p), load64(p + 8), mix);
    p += 16;
  }
  uint32_t length = (uint32_t)(p - start);
  return (NameRow){((uint64_t)(uintptr_t)start << 7) | length, hash};
}

INLINE uint64_t next_mixer(void) {
  uint64_t z = mixer_seed += UINT64_C(0x9e3779b97f4a7c15);
  z = (z ^ (z >> 30)) * UINT64_C(0xbf58476d1ce4e5b9);
  z = (z ^ (z >> 27)) * UINT64_C(0x94d049bb133111eb);
  return z ^ (z >> 31);
}

// Search a few deterministic mixer pairs for one that gives every station its
// own first bucket, then rebuild the table. Dense tables keep linear probing.
__attribute__((noinline, cold)) static void retune(void) {
  if (used > TABLE_SIZE / 32) return;
  for (uint32_t attempt = 0; attempt < 64 && retunes_left; attempt++) {
    retunes_left--;
    uint64_t mix[2] = {next_mixer(), next_mixer()};
    memset(claimed, 0, sizeof(claimed));
    uint32_t id = 0;
    for (; id < used; id++) {
      const uint8_t *key = names + (stations[id].key & OFFSET_MASK);
      uint32_t slot = (uint32_t)(scan_name(key, mix).hash >> 49);
      if (claimed[slot >> 5] & (UINT32_C(1) << (slot & 31))) break;
      claimed[slot >> 5] |= UINT32_C(1) << (slot & 31);
    }
    if (id < used) continue;
    mixers[0] = mix[0];
    mixers[1] = mix[1];
    for (uint32_t slot = 0; slot < TABLE_SIZE; slot++)
      buckets[slot] = (uint32_t)(uintptr_t)&empty_station;
    for (id = 0; id < used; id++) {
      uint64_t hash = scan_name(names + (stations[id].key & OFFSET_MASK), mixers).hash;
      buckets[hash >> 49] = (uint32_t)(uintptr_t)&stations[id];
      stations[id].hash = (uint32_t)(hash ^ (hash >> 32));
    }
    return;
  }
}

__attribute__((noinline, cold)) static Station *probe_station(const uint8_t *start, uint32_t length,
                                                              uint64_t hash, uint64_t head,
                                                              uint32_t slot) {
  for (;;) {
    uint32_t entry = buckets[slot];
    if (entry == (uint32_t)(uintptr_t)&empty_station) {
      Station *station = insert_station(start, length, (uint32_t)(hash ^ (hash >> 32)), head, slot);
      retune();
      return station;
    }
    Station *station = (Station *)(uintptr_t)entry;
    if (same_name(station, start, length)) return station;
    slot = (slot + 1) & (TABLE_SIZE - 1);
  }
}

INLINE Station *find_station(const uint8_t *start, uint32_t length, uint64_t hash, uint64_t head) {
  uint32_t slot = (uint32_t)(hash >> 49);
  uint32_t entry = buckets[slot];
  if (entry == (uint32_t)(uintptr_t)&empty_station)
    return insert_station(start, length, (uint32_t)(hash ^ (hash >> 32)), head, slot);
  Station *station = (Station *)(uintptr_t)entry;
  if (same_name(station, start, length)) return station;
  return probe_station(start, length, hash, head, (slot + 1) & (TABLE_SIZE - 1));
}

typedef struct {
  const uint8_t *temperature;
  Station *station;
} ParsedRow;

INLINE ParsedRow lookup_row(NameRow row) {
  const uint8_t *start = (const uint8_t *)(uintptr_t)(row.location >> 7);
  uint32_t length = (uint32_t)row.location & 127;
  uint64_t head = load64(start) & byte_masks[length < 8 ? length : 8];
  return (ParsedRow){start + length + 1, find_station(start, length, row.hash, head)};
}

// Misses recompute the hash from the name, so the hot paths need not keep it
// alive across this call.
__attribute__((noinline, cold)) static Station *find_name(const uint8_t *start) {
  return lookup_row(scan_name(start, mixers)).station;
}

INLINE ParsedRow scan_row(const uint8_t *p) { return lookup_row(scan_name(p, mixers)); }

INLINE const uint8_t *update_row(ParsedRow row) {
  const uint8_t *p = row.temperature;
  uint32_t inverse = ~load32(p);
  // The decimal is in byte 1, 2 or 3; preceding digits have ASCII bit 4 set.
  const uint8_t *dot = p + (__builtin_ctz(inverse & UINT32_C(0x10101000)) >> 3);
  // The two bytes before the decimal are ';' or '-' or tens, then units.
  uint32_t digits = load32(dot - 2) & UINT32_C(0x0f000f0f);
  // Pack both nibbles, tenths and the sign: a minus lacks ASCII bit 4.
  uint32_t offset = temperatures[((digits | (digits >> 12)) & 0xffff) | (inverse & 0x10)];
  // LF is even and CR is odd.
  const uint8_t *next = dot + 3 + (dot[2] & 1);

  Station *station = row.station;
  // Counts stay below 2^32, so adding one cannot carry into packed min/max.
  // Update the exact sum/count together and blend in signed 16-bit extrema.
  v128_t stats = wasm_v128_load(station);
  v128_t delta = wasm_v128_load((const uint8_t *)deltas + offset);
  v128_t added = wasm_i64x2_add(stats, delta);
  // Fixed lane selections let the host compiler use immediate SIMD blends.
  v128_t extrema = wasm_i16x8_shuffle(wasm_i16x8_min(stats, delta), wasm_i16x8_max(stats, delta), 0,
                                      1, 2, 3, 4, 5, 6, 15);
  wasm_v128_store(station, wasm_i16x8_shuffle(added, extrema, 0, 1, 2, 3, 4, 5, 14, 15));
  return next;
}

INLINE const uint8_t *process_row(const uint8_t *p) { return update_row(scan_row(p)); }

INLINE const uint8_t *process_short(const uint8_t *start, uint32_t matches, v128_t bytes) {
  uint32_t length = (uint32_t)__builtin_ctz(matches);
  v128_t key = wasm_v128_and(bytes, wasm_v128_load(short_masks[length]));
  v128_t mixed = wasm_v128_xor(key, wasm_v128_load(mixers));
  uint64_t hash =
      (uint64_t)wasm_i64x2_extract_lane(mixed, 0) * (uint64_t)wasm_i64x2_extract_lane(mixed, 1);
  uint32_t slot = (uint32_t)(hash >> 49);
  Station *station = (Station *)(uintptr_t)buckets[slot];
  // An empty record is all zero; a key containing ';' can never match it.
  if (wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(&station->head), key)) != 0xffff)
    station = find_name(start);
  return update_row((ParsedRow){start + length + 1, station});
}

INLINE uint32_t same_key(v128_t key, const uint8_t *p) {
  return (uint32_t)wasm_i8x16_bitmask(wasm_i8x16_eq(key, wasm_v128_load(p)));
}

// Names below 32 bytes compare both vectors of their canonical arena key, so
// short and longer names share one branch-free path.
INLINE const uint8_t *process_wide(const uint8_t *start, uint32_t matches, v128_t low,
                                   v128_t high) {
  uint32_t length = (uint32_t)__builtin_ctz(matches);
  const uint64_t *mask = wide_masks[length];
  v128_t key_low = wasm_v128_and(low, wasm_v128_load(mask));
  v128_t key_high = wasm_v128_and(high, wasm_v128_load(mask + 2));
  uint64_t first = mix_pair(0, (uint64_t)wasm_i64x2_extract_lane(key_low, 0),
                            (uint64_t)wasm_i64x2_extract_lane(key_low, 1), mixers);
  uint64_t second = mix_pair(first, (uint64_t)wasm_i64x2_extract_lane(key_high, 0),
                             (uint64_t)wasm_i64x2_extract_lane(key_high, 1), mixers);
  uint64_t hash = length < 16 ? first : second;
  Station *station = (Station *)(uintptr_t)buckets[hash >> 49];
  const uint8_t *key = names + (station->key & OFFSET_MASK);
  if ((same_key(key_low, key) & same_key(key_high, key + 16)) != 0xffff) station = find_name(start);
  return update_row((ParsedRow){start + length + 1, station});
}

// Rows with short names end within 32 bytes. Locating the newline directly
// keeps the next row off the temperature dependency chain.
INLINE const uint8_t *advance_short(const uint8_t *start, uint32_t matches, v128_t bytes) {
  const v128_t newline = wasm_v128_load(&newlines);
  uint32_t lines = (uint32_t)wasm_i8x16_bitmask(wasm_i8x16_eq(bytes, newline)) |
                   (uint32_t)wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(start + 16), newline))
                       << 16;
  process_short(start, matches, bytes);
  return start + __builtin_ctz(lines) + 1;
}

typedef struct {
  const uint8_t *a;
  const uint8_t *b;
  const uint8_t *c;
} RowPointers;

// An empty cold call marks the start of an unlikely path for the derived
// branch hints. V8 inlines it away; the path itself needs no real call.
__attribute__((noinline, cold)) static void cold_path(void) { __asm__ volatile(""); }

// Rows whose names need another vector: every name below 32 bytes takes the
// two-vector path; longer names keep the complete general parser.
INLINE RowPointers process_three(const uint8_t *a, const uint8_t *b, const uint8_t *c) {
  const v128_t separator = wasm_i8x16_splat(';');
  v128_t low_a = wasm_v128_load(a);
  v128_t low_b = wasm_v128_load(b);
  v128_t low_c = wasm_v128_load(c);
  v128_t high_a = wasm_v128_load(a + 16);
  v128_t high_b = wasm_v128_load(b + 16);
  v128_t high_c = wasm_v128_load(c + 16);
  uint32_t matches_a = (uint32_t)wasm_i8x16_bitmask(wasm_i8x16_eq(low_a, separator)) |
                       (uint32_t)wasm_i8x16_bitmask(wasm_i8x16_eq(high_a, separator)) << 16;
  uint32_t matches_b = (uint32_t)wasm_i8x16_bitmask(wasm_i8x16_eq(low_b, separator)) |
                       (uint32_t)wasm_i8x16_bitmask(wasm_i8x16_eq(high_b, separator)) << 16;
  uint32_t matches_c = (uint32_t)wasm_i8x16_bitmask(wasm_i8x16_eq(low_c, separator)) |
                       (uint32_t)wasm_i8x16_bitmask(wasm_i8x16_eq(high_c, separator)) << 16;
  if ((matches_a != 0) & (matches_b != 0) & (matches_c != 0)) {
    const uint8_t *next_a = process_wide(a, matches_a, low_a, high_a);
    const uint8_t *next_b = process_wide(b, matches_b, low_b, high_b);
    const uint8_t *next_c = process_wide(c, matches_c, low_c, high_c);
    return (RowPointers){next_a, next_b, next_c};
  }
  // Hash each name just before its lookup: an insertion may retune the mixers.
  ParsedRow row_a = scan_row(a);
  ParsedRow row_b = scan_row(b);
  ParsedRow row_c = scan_row(c);
  const uint8_t *next_a = update_row(row_a);
  const uint8_t *next_b = update_row(row_b);
  const uint8_t *next_c = update_row(row_c);
  return (RowPointers){next_a, next_b, next_c};
}

EXPORT(reset) void reset(void) {
  for (uint32_t slot = 0; slot < TABLE_SIZE; slot++)
    buckets[slot] = (uint32_t)(uintptr_t)&empty_station;
  used = 0;
  mixers[0] = UINT64_C(0x9e3779b185ebca87);
  mixers[1] = UINT64_C(0xc2b2ae3d27d4eb4f);
  mixer_seed = 0;
  separators = wasm_i8x16_splat(';');
  newlines = wasm_i8x16_splat('\n');
  retunes_left = 256;
  wasm_v128_store(names, wasm_i64x2_const(-1, -1));
  wasm_v128_store(names + 16, wasm_i64x2_const(-1, -1));
  name_used = 32;
  for (int32_t value = -999; value <= 999; value++) {
    uint64_t extreme = (uint16_t)value;
    deltas[value + 999] = wasm_i64x2_make(value, (int64_t)(1 | extreme << 32 | extreme << 48));
  }
  for (uint32_t tenths = 0; tenths <= 9; tenths++) {
    for (uint32_t units = 0; units <= 9; units++) {
      uint32_t index = (units << 8) | (tenths << 12);
      int32_t value = (int32_t)(units * 10 + tenths);
      temperatures[index | (';' & 15)] = (uint16_t)((999 + value) * 16);
      temperatures[index | 0x10 | ('-' & 15)] = (uint16_t)((999 - value) * 16);
      for (int32_t tens = 0; tens <= 9; tens++) {
        temperatures[index | (uint32_t)tens] = (uint16_t)((999 + tens * 100 + value) * 16);
        temperatures[index | 0x10 | (uint32_t)tens] = (uint16_t)((999 - tens * 100 - value) * 16);
      }
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
EXPORT(mixers_base) uint32_t mixers_base(void) { return (uint32_t)(uintptr_t)mixers; }

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
  for (;;) {
    // A row is at most 108 bytes, so this many iterations stay inside all
    // three lanes without checking each pointer.
    uint32_t left_a = (uint32_t)(end_a - a);
    uint32_t left_b = (uint32_t)(end_b - b);
    uint32_t left_c = (uint32_t)(limit - c);
    uint32_t left = left_a < left_b ? left_a : left_b;
    left = left < left_c ? left : left_c;
    uint32_t rounds = left / 108;
    if (!rounds) break;
    do {
      const v128_t separator = wasm_v128_load(&separators);
      v128_t bytes_a = wasm_v128_load(a);
      v128_t bytes_b = wasm_v128_load(b);
      v128_t bytes_c = wasm_v128_load(c);
      uint32_t matches_a = wasm_i8x16_bitmask(wasm_i8x16_eq(bytes_a, separator));
      uint32_t matches_b = wasm_i8x16_bitmask(wasm_i8x16_eq(bytes_b, separator));
      uint32_t matches_c = wasm_i8x16_bitmask(wasm_i8x16_eq(bytes_c, separator));
      if ((matches_a != 0) & (matches_b != 0) & (matches_c != 0)) {
        a = advance_short(a, matches_a, bytes_a);
        b = advance_short(b, matches_b, bytes_b);
        c = advance_short(c, matches_c, bytes_c);
      } else {
        cold_path();
        RowPointers next = process_three(a, b, c);
        a = next.a;
        b = next.b;
        c = next.c;
      }
    } while (--rounds);
  }
  while (a < end_a) a = process_row(a);
  while (b < end_b) b = process_row(b);
  while (c < limit) c = process_row(c);
}
