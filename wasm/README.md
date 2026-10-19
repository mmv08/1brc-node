# The Wasm SIMD kernel

One production implementation: `kernel.c` → `kernel.wasm`. Rejected alternatives
live in git history. [BENCHMARKS.md](../BENCHMARKS.md) records matched comparisons,
checkpoint commits and local raw reports.

```sh
./run.sh measurements.txt
```

Node handles file reads, workers, dynamic range scheduling, row ownership,
UTF-8 result decoding, merging, sorting and formatting. Each worker owns a
private Wasm instance and table. Its input Buffer aliases Wasm memory, so the
filesystem writes there directly. Memory grows before any views are created
and never during parsing.

The freestanding kernel imports nothing: no libc, WASI or host callbacks.
SIMD scans 16 bytes for delimiters. Three independent newline-aligned lanes
load their first vectors together. When all three delimiters are present
(1–15 name bytes), each row reuses its vector for hashing and matching, then
updates statistics immediately. It does not reload and mask separate head/tail
words after hashing.

A short key contains the complete name, its semicolon delimiter and zero padding
to 16 bytes. The delimiter encodes the length even when names end in NUL bytes.
One vector comparison verifies both the bytes and the length. Long records cache
raw head/tail words without a delimiter, so they cannot falsely match a short
key. Empty buckets point to a shared zero record, which also cannot match a key
containing the delimiter. The hot lookup needs only the vector comparison;
misses use the complete insertion and collision-probing path.

If any name needs another block, a C-outlined helper uses the complete general
parser: scan all names, resolve all stations, then update statistics in order.
It accepts every valid name up to 100 UTF-8 bytes. Remaining rows in each lane
also use the general parser. Each lookup installs a complete new key before
the next lookup; updates remain ordered even when lanes share a station.

C also outlines new-key insertion and collision probing into cold functions.
V8 uses its normal compilation and inlining settings. The selected binary is
**7,693 bytes**. No alternate table layouts or lane strategies are shipped.

The general scanner packs the name's length into seven bits beside its full
32-bit pointer and carries that descriptor plus the hash into lookup. Hashing
includes the semicolon and mixes each 16-byte block with one 64-bit
multiplication, masking the final partial block. Short-name hashing XORs the
already masked SIMD key with both mixing constants in one vector operation,
then extracts the two words for multiplication. The original key remains
available for comparison; its low word is extracted only on a lookup miss.
This preserves the hash exactly. The high 15 hash bits
select a bucket; a folded fingerprint is computed only on insertion for
inspection. A matching bucket always receives complete name verification;
hash equality is not an additional hot-path requirement.

For names longer than 16 bytes, the 100-byte limit permits at most five fixed
middle-vector comparisons plus an overlapping final vector. These reads stay
inside the actual name and check every byte. A 16-byte name is covered by its
head and tail; shorter names use the delimiter-terminated SIMD key. Arbitrary
valid station names and distributions are supported.

Station records remain exactly **40 bytes**:

| Offset | Field |
| ---: | --- |
| 0 | signed Int64 sum, in tenths |
| 8 | Uint32 count |
| 12, 14 | Int16 min/max |
| 16 | Uint32 fingerprint, retained for inspection |
| 20 | key offset (low 20 bits) and byte length (upper bits) |
| 24–39 | 16-byte delimiter-terminated key for names below 16 bytes; raw head/tail words otherwise |

Temperature bounds put the decimal point at byte offset 1, 2 or 3 in the
first four bytes. Digits have ASCII bit 4 set; the decimal point does not.
Ignoring byte 0 excludes the optional minus sign, so
`ctz((~word) & 0x10101000) >> 3` locates the decimal point directly.
The row width is that offset plus three, with one extra byte for CRLF.
This determines row advancement and the fractional-digit address independently
of sign normalization. The existing numeric lookup remains unchanged.
Tests cover all 4,400 sign/digit-width/newline combinations, including leading
zeros and negative zero, through the production parser.

One 128-bit load/store updates the statistics. An `i64x2.add` updates the sum
and count; signed `i16x8.min/max` compute the extrema. Fixed lane shuffles merge
the fields, lowering to two immediate SIMD blends in the inspected Node 26 code
instead of six bitwise mask operations. Counts cannot
reach 2^32 within the billion-row challenge, so incrementing the count cannot
carry into its adjacent min/max fields. Sums are exact signed 64-bit integers.

The bounded name arena fits in 20 bits even for 10,000 maximum-length names.
Every name byte is checked, including the middle of names sharing identical
heads and tails. No input dictionary or precomputed results are embedded.
BigInt conversion happens once per result station, never per measurement.
All challenge sums fit exactly in a JS Number after conversion.

Build and inspect:

```sh
npm run format:c
npm run build:wasm
npm run format
npm run check:c
node_modules/.bin/wasm2wat wasm/kernel.wasm -o results/build/kernel.wat
```

Build tools used here: existing Clang 22.1.8 and LLD 20.0.0. No global tools
were installed. `CLANG`, `WASM_LD`, and `CLANG_FORMAT` override tool locations.
The kernel is built at `-O3 -msimd128 -ffreestanding -fno-builtin -nostdlib`.
`build.json` records hashes and full commands; tests reject stale binaries.
Only Node is needed to run the prebuilt module.
