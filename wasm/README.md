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
SIMD scans 16 bytes for delimiters and verifies the middle of long names.
Three independent newline-aligned lanes first scan for delimiters. When all
three names end within the first 16-byte block (1–15 name bytes), the compact
path hashes all three names, then resolves and updates each row immediately.
This shortens the lifetime of lookup results between lanes.

If any name needs another block, a C-outlined helper uses the complete general
parser: scan all names, resolve all stations, then update statistics in order.
It accepts every valid name up to 100 UTF-8 bytes. Remaining rows in each lane
also use the general parser. Each lookup installs a complete new key before
the next lookup; updates remain ordered even when lanes share a station.

C also outlines new-key insertion and collision probing into cold functions.
V8 uses its normal compilation and inlining settings. The selected binary is
**7,328 bytes**. The inspected Node 26 optimized `parse_chunk` body is 8,960 bytes
versus 10,624 bytes previously; the general scanning code also exists in its
separate helper. The module has grown while the main native function is smaller.

The 100-byte name limit fits the length into seven bits beside the full 32-bit
input pointer. Scanning carries just that packed value and the hash into lookup;
lookup then loads the head word. Short-name matching loads and masks the head
and tail unconditionally, avoiding branches that vary with name length.

Hashing mixes each 16-byte block with one 64-bit multiplication, masking both
words in the final partial block. The high 15 bits select a bucket directly;
the folded fingerprint is computed only on insertion for inspection. Lookup
checks the first bucket directly and probes further on a name mismatch. A
matching bucket always receives complete name verification; hash equality is
not an additional hot-path requirement.

For names longer than 16 bytes, the 100-byte limit permits at most five fixed
middle-vector comparisons plus an overlapping final vector. These reads stay
inside the actual name and check every byte. Head/tail filters fully cover
shorter names. Arbitrary valid station names and distributions are supported.

Station records remain exactly **40 bytes**:

| Offset | Field |
| ---: | --- |
| 0 | signed Int64 sum, in tenths |
| 8 | Uint32 count |
| 12, 14 | Int16 min/max |
| 16 | Uint32 fingerprint, retained for inspection |
| 20 | key offset (low 20 bits) and byte length (upper bits) |
| 24, 32 | Uint64 head/tail filters |

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
