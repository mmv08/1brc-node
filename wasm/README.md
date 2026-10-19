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
Three independent newline-aligned lanes run name scanning, station lookup and
statistics updates in separate phases. Each lookup installs a complete new key
before the next lookup; updates remain ordered even when lanes share a station.
New-key insertion is a
cold, non-inlined function. The selected binary is **6,267 bytes**.

Short-name matching loads and masks the head and tail unconditionally, avoiding
branches whose outcomes vary with station-name length. Hashing similarly masks
both parts of the last 16-byte block before selecting the rolling hash result.
The rolling hash is unchanged. Its high 15 bits select a bucket directly;
the folded fingerprint is computed only on insertion for inspection. A matching
bucket always receives complete
name verification; hash equality is not an additional hot-path requirement.

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
