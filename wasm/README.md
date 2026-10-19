# The Wasm SIMD kernel

One production implementation: `kernel.c` → `kernel.wasm`. Failed alternatives
were removed and are recorded in [BENCHMARKS.md](../BENCHMARKS.md). Experimental
source and binaries are preserved in git checkpoint **`ff83918`**.

```sh
ENGINE=wasm ./run.sh measurements.txt
```

Node retains file reads, workers, dynamic range scheduling, row ownership,
UTF-8 result decoding, merging, sorting and formatting. Each worker owns a
private Wasm instance and table. Its Buffer aliases the input region of Wasm
memory: the filesystem writes there directly, without a second input copy.
Memory grows before any views are constructed and never during parsing.

The freestanding C kernel imports nothing: no libc, WASI or host callbacks.
SIMD uses `i8x16.eq`/`i8x16.bitmask` for 16-byte delimiter scanning and complete
middle-word comparisons. Four independent newline-aligned lanes overlap work.
New-key initialization/copying is a cold, non-inlined function.

The compact/cold combination improved matched full-file time by about **4%**.
The final binary is **7,868 bytes**. Only this implementation is built/shipped;
the experimental alternatives live in git history, not a runtime registry.

Station records are exactly **40 bytes**:

| Offset | Field |
| ---: | --- |
| 0 | signed Int64 sum, in tenths |
| 8 | Uint32 count |
| 12, 14 | Int16 min/max |
| 16 | Uint32 hash |
| 20 | key offset (low 20 bits) and byte length (upper bits) |
| 24, 32 | Uint64 head/tail filters |

The bounded key arena fits in 20 bits even for 10,000 maximum-length names.
Hashes and head/tail are only filters: every name byte is verified. The final
vector overlaps the tail without reading beyond a key. No station dictionary
or input-specific results are embedded. BigInt conversion happens once per
result station, never per measurement. All challenge sums fit exactly in a JS
Number after conversion.

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
