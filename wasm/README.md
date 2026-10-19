# Node + WebAssembly SIMD

This is an **optional Wasm backend**, not a pure-JavaScript score. The existing
JS implementation remains the default and the comparison baseline.

```sh
ENGINE=wasm ./run.sh measurements.txt
```

The repository includes small prebuilt modules. Running them requires only
Node (tested on 24 and 26), with **no native addon, WASI shim, or npm runtime
dependency**. Build/inspection dependencies are development-only.

The selected Wasm default is `simd-pointers` with **four cursors**. An ordinary
five-run cached-input batch measured **2.034 s trimmed mean**, best **2.009 s**.
After 16 full-file hardware warm-ups, a five-round alternating comparison
measured **5.670 s JavaScript vs 3.773 s SIMD Wasm**. The optimized scalar Wasm
control was **3.734 s**: SIMD has no clear additional win on these short station
names, although the combined Wasm implementation is about **1.5× faster** than
the JS baseline. See [BENCHMARKS.md](../BENCHMARKS.md) for exact run data.

## Architecture

- Node retains positioned file reads, worker threads, dynamic chunk scheduling,
  boundary ownership, UTF-8 result decoding, merging, sorting and formatting.
- Each worker owns a Wasm instance and a private aggregate table.
- Node's `Buffer` views directly alias `WebAssembly.Memory`. `fs.readSync`
  writes into the kernel's input region; there is **no extra input copy**.
- There is **one JS-to-Wasm call per chunk**, not per row.
- The freestanding C kernel performs both parsing and aggregation. It imports
  **nothing**, including no libc/WASI functions. Its own small memory helpers
  are compiled into the module.
- SIMD scans 16 bytes using `i8x16.eq` and `i8x16.bitmask`. It also compares
  full middle sections of long names with overlapping 16-byte vectors.
- A scalar control uses native 64-bit SWAR and contains no Wasm SIMD opcodes.
  Both controls otherwise use the same integer hash and aggregation algorithm.
- Station names are discovered at runtime. Hashes/head/tail words are filters;
  every byte is verified on a candidate match. No fixed dictionary is embedded.
- Sums are signed 64-bit integer tenths; counts are Uint32; min/max are Int16.
  The complete `999 × 1,000,000,000` bound is exact. BigInt conversion happens
  only once per result station when reading sums, **never per input row**.
- Memory grows only before input/result views are constructed. No subsequent
  growth can detach an active read buffer, including in double-buffered mode.

The valid-input contract is unchanged: UTF-8 names of 1–100 bytes, at most
10,000 stations, decimal temperatures from -99.9 to 99.9 in tenths. Empty input,
CRLF, and missing final LF are supported. The file must not change during a run.

## Build and formatting

```sh
npm ci
npm run build:wasm
npm run format         # Biome: JS and JSON
npm run format:c       # clang-format: the C source
npm run check
npm run check:c
```

The build needs Clang with wasm32/SIMD support and a Wasm linker. The tools
already present on this machine were sufficient: **Clang 22.1.8** and the
ROCm toolchain's **LLD 20.0.0**. No global installation was performed.

To choose other tools:

```sh
CLANG=/path/to/clang WASM_LD=/path/to/wasm-ld npm run build:wasm
CLANG_FORMAT=/path/to/clang-format npm run format:c
```

`tools/build-wasm.mjs` compiles with `-O3 -msimd128` (or `-mno-simd128` for the
scalar controls), `-ffreestanding`, `-fno-builtin`, and `-nostdlib`. It records
compiler/linker versions, full arguments, source hash, binary sizes and hashes
in `build.json`. Tests reject a stale build after C-source changes.

`wabt` is a pinned dev dependency for disassembly/validation. For example:

```sh
node_modules/.bin/wasm2wat wasm/kernel-simd.wasm -o results/build/kernel-simd.wat
```

## Controls and tuning

`WASM_STREAMS=1/2/3/4` selects independent newline-aligned cursors inside the
kernel. `WASM_VARIANT` selects:

| Variant | Purpose |
| --- | --- |
| `simd` | SIMD scan/full-key comparisons; compact Uint16 station-ID table |
| `scalar` | 64-bit scalar control; no Wasm SIMD opcodes |
| `simd-pointers` / `scalar-pointers` | 32-bit pointer buckets, avoiding a dependent record-index multiply; `simd-pointers` is the default |
| `simd-small` / `simd-pointers-small` | Alternative hash multiplier that fits a native immediate operand |
| `collision` / `collision-pointers` | **Correctness only**: forces all full hashes to zero |

Do not use collision variants for performance claims. Their purpose is to prove that
matching hashes and cached words cannot silently merge different station names.

```sh
node tools/wasm-tune.mjs measurements-100m.txt
CPU_SET=0 WORKERS=1 PERF=1 node tools/wasm-tune.mjs measurements-100m.txt

ENGINE=wasm WASM_STREAMS=4 npm run bench -- measurements.txt
ENGINE=wasm WASM_VARIANT=scalar WASM_STREAMS=3 npm run bench -- measurements.txt

# Independently check the EXACT processed count as well as the formatted result:
.runtimes/node-v26.12.0/bin/node tools/verify-wasm.mjs measurements.txt 1000000000
```

All measured runs start a fresh process and check the complete result. Timing
includes worker startup, module compilation/instantiation, reads, computation,
result decoding/merging/output, and shutdown. Report Wasm separately from JS.

The tests audit actual SIMD opcodes and absence of imports, direct buffer
aliasing, reset, memory growth, 64-bit sum limits, both scalar/SIMD variants,
all cursor counts and reader modes, 10K keys, UTF-8/NUL/100-byte names, and
forced full-hash collisions at SIMD-length boundaries.
