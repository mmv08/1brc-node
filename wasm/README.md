# The Wasm SIMD kernel

One production implementation: `kernel.c` → `kernel.wasm`. Rejected alternatives
live in git history or the benchmark log. [BENCHMARKS.md](../BENCHMARKS.md)
links the final measurements and the historical experiment archive.

```sh
./run.sh measurements.txt
```

Node handles file reads, workers, dynamic range scheduling, row ownership,
UTF-8 result decoding, merging, sorting and formatting. Workers start from
`worker.mjs`, which loads only `engine.mjs` and the reader. Each worker owns a
private Wasm instance and table. Its input Buffer aliases Wasm memory, so the
filesystem writes there directly. Each instance starts with 4 MiB of memory.
Any growth needed for the input buffer happens before views are created and
never during parsing.

The freestanding kernel imports nothing: no libc, WASI or host callbacks.
SIMD scans 16 bytes for delimiters. Three independent newline-aligned lanes
load their first vectors together. A valid row is at most 108 bytes, so a
counted inner loop runs as many iterations as the shortest lane allows without
checking each lane's end. `#pragma clang loop unroll_count(4)` asks Clang to
unroll four logical iterations of this loop, preserving the iteration count
and handling any remainder. The number of independent parsing lanes stays three.

Each lane whose first vector contains the delimiter (1–15 name bytes) reuses
that vector for hashing and matching. Such a row ends within 32 bytes: two
vector comparisons find its newline, so the lane advances without waiting for
the temperature to decode. A longer name in another lane does not take this
row out of its short-name path.

A short key contains the complete name, its semicolon delimiter and zero padding
to 16 bytes. The delimiter encodes the length even when names end in NUL bytes.
One vector comparison and bitmask verify both the bytes and the length. Long
records cache raw head/tail words without a delimiter, so they cannot falsely
match a short key. Empty buckets point to a shared zero record, which also
cannot match a key containing the delimiter. Misses recompute the hash from the
name in an outlined lookup, so the hot loop keeps no hash state alive for them.

Each lane with a longer name calls the outlined, cold `process_long()` helper.
Names of 16–31 bytes take a two-vector path. Their canonical 32-byte key holds
the name, its delimiter and zero padding; the arena stores the same form, so
one pair of vector comparisons verifies the complete key. The caller proves
that the first vector contains no delimiter, so this path uses it unmasked and
always hashes both vectors. Only the high vector needs masking, using the short
mask table indexed by `length - 16`. This removes a redundant load/AND, hash
selection and the separate 1 KiB wide-mask table. Names of 32 bytes or more use
the complete general parser. Every mask includes the delimiter.

The general scanner packs the name's length into seven bits beside its full
32-bit pointer and carries that descriptor plus the hash into lookup. Hashing
includes the semicolon and mixes each 16-byte block with one 64-bit
multiplication, `(hash ^ low ^ m0) * (high ^ m1)`, masking the final partial
block. Every path computes this same hash. The high 15 bits select a bucket; a
folded fingerprint is computed only on insertion for inspection.

The mixing words start fixed. While the table holds at most 1,024 stations, an
insertion that lands beyond its first bucket tries deterministic splitmix64
word pairs (up to 64 per collision, 256 per reset) for one that gives every
station its own first bucket, then rebuilds the table. On the benchmark data
three station pairs share first buckets under the initial words; after
retuning, every lookup hits directly. Denser tables keep linear probing.
A matching bucket always receives complete name verification.

Names longer than 16 bytes compare their first and an overlapping final vector
against the arena copy, which covers every byte up to 32 bytes. The 100-byte
limit permits at most five further middle vectors. These reads stay inside the
actual name. Arbitrary valid station names and distributions are supported.

Station records remain exactly **40 bytes**:

| Offset | Field |
| ---: | --- |
| 0 | signed Int64 sum, in tenths |
| 8 | Uint32 count |
| 12 | Int16 minimum |
| 14 | Int16 negative maximum |
| 16 | Uint32 fingerprint, retained for inspection |
| 20 | key offset (low 20 bits) and byte length (upper bits) |
| 24–39 | 16-byte delimiter-terminated key for names below 16 bytes; raw head/tail words otherwise |

Temperature bounds put the decimal point at byte offset 1, 2 or 3 in the
first four bytes. Digits have ASCII bit 4 set; the decimal point does not.
Ignoring byte 0 excludes the optional minus sign, so
`ctz((~word) & 0x10101000) >> 3` locates the decimal point directly. The two
bytes before it are `;` (one digit), `-` (a negative single digit) or the tens
digit, then the units digit. Their low nibbles, the tenths digit's and the
inverted bit 4 of the first byte (set only for a minus sign) form a 16-bit
index. One vector lookup returns the complete statistics delta directly from
a sparse 65,536-entry `v128_t` table (1 MiB). This removes the dependent lookup
through a `uint16` offset table. During reset, the 1,999 possible deltas are
constructed once and copied into each legal spelling's table entry. LF is even
and CR odd, so the low bit of the byte two places
after the decimal identifies CRLF where the general path advances by the
temperature. Tests cover all 4,400 sign/digit-width/newline combinations,
including leading zeros and negative zero, through the production parser.

Each delta holds the signed sum increment, a count increment, the value in the
minimum lane and its negation in the negative-maximum lane. An `i64x2.add`
updates the sum and count, while one signed `i16x8.min` updates both extrema.
A fixed lane shuffle merges the fields, lowering to one immediate SIMD blend,
then one 128-bit store writes the statistics. Counts cannot reach 2^32 within
the billion-row challenge, so incrementing the count cannot carry into the
adjacent extrema fields. Sums are exact signed 64-bit integers. The host
decodes the maximum as `0 - negative_max`, preserving positive zero.

V8 rebuilds immediate SIMD constants inside loops, so the delimiter splats and
mixing words are written by `reset()` and loaded from memory instead.

Clang emits no Wasm branch hints, but V8 uses them to place cold blocks out of
line and keep their register spills there. `tools/branch-hints.mjs` decodes the
linked module and hints a branch unlikely when taking it calls a function
declared `noinline, cold`, and likely when it skips such a call or repeats a
loop. Everything else stays unhinted. The shipped module keeps no other custom
sections; `build.json` lists the cold functions and per-function hint counts.

The bounded name arena fits in 20 bits even for 10,000 maximum-length names.
Every name byte is checked, including the middle of names sharing identical
heads and tails. No input dictionary or precomputed results are embedded.
BigInt conversion happens once per result station, never per measurement.
All challenge sums fit exactly in a JS Number after conversion.
The selected binary is **12,110 bytes**, down from 13,175 after the range
specialization. The final 21-round paired comparison measured **2.09% less
elapsed time** (0.487 to 0.477 seconds). Three-lane key-load staging produced no
repeatable gain and was rejected. The four-way loop hint, existing `cold`,
`noinline`, `always_inline` attributes and branch-hint policy remain. Extra
`hot` and `__builtin_expect` annotations produced identical Wasm with this
toolchain, and other tested hint policies did not improve the matched results.
See [BENCHMARKS.md](../BENCHMARKS.md) for final results and the historical experiment record.

Build and inspect:

```sh
npm run format:c
npm run build:wasm
npm run format
npm run check:c
node_modules/.bin/wasm2wat wasm/kernel.wasm -o results/build/kernel.wat
```

Build tools used here: existing Clang 21.1.8 and LLD 21.1.8. No global tools
were installed. `CLANG`, `WASM_LD`, and `CLANG_FORMAT` override tool locations.
The kernel is built at `-O3 -msimd128 -ffreestanding -fno-builtin -nostdlib`
and linked with its symbol names, which only the hint derivation reads.
`build.json` records hashes and full commands; tests reject stale binaries.
Only Node is needed to run the prebuilt module.
