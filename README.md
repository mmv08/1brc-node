# 1BRC with Node.js

Two implementations, no runtime variant framework:

- **JavaScript**: the preserved optimized JS reference; default.
- **Wasm SIMD**: one kernel, with 40-byte station records, four parsing lanes,
  and outlined cold insertion. Node handles workers, I/O and final output.

The Wasm backend has processed all billion cached rows in about **2 seconds**
on this machine (Core Ultra 7 258V, 8 cores, 30 GiB RAM, Node 26.12.0).
Power/burst state affects timings substantially. See [BENCHMARKS.md](BENCHMARKS.md)
for matched comparisons, raw run data and the rejected-experiment log.

## Run

```sh
ENGINE=wasm ./run.sh measurements.txt   # optimized Wasm SIMD
./run.sh measurements.txt               # JavaScript reference
```

The default input is `measurements.txt`. Only the sorted result goes to stdout.
The launcher prefers `.runtimes/node-v26.12.0/bin/node` if present, otherwise
`node` on PATH. `NODE_BIN=/path/to/node` overrides it. No system Node change,
native addon, WASI shim or npm runtime dependency is required.

Supported input is the original challenge format: valid UTF-8 names of 1–100
bytes, at most 10,000 stations, temperatures in tenths from -99.9 to 99.9.
Empty files, CRLF and an absent final LF work. Input must remain unchanged
while processing. This is an optimized valid-input parser, not a CSV validator.

## Design

- Workers claim 128 KiB ranges using a shared atomic counter. Faster cores
  naturally process more ranges on this hybrid CPU.
- A preceding byte and trailing overlap ensure exact row ownership when a
  range splits a name or temperature. The full file isn't loaded into the heap.
- Wasm input buffers **alias its memory directly**. One host call parses and
  aggregates a whole chunk; there are no per-row JS/Wasm calls or input copies.
- SIMD finds semicolons 16 bytes at a time. Hashes and cached words are filters;
  candidate station names are verified completely, including every middle byte.
- A fixed pointer table references compact records. Name bytes live in a
  bounded arena, and no strings/objects are allocated per measurement.
- Temperatures are integer tenths. Wasm uses exact signed 64-bit sums; JS uses
  doubles whose integer precision exceeds the challenge bound. Final sorting
  and Java-compatible rounding are shared.

Details: [wasm/README.md](wasm/README.md).

## Test and format

The upstream checkout supplies official fixtures and the generator station list:

```sh
git clone --depth 1 https://github.com/1brc/nodejs.git upstream
npm ci
npm test
npm run check          # Biome: JS, imports and JSON
npm run format         # Biome safe fixes
npm run check:c        # clang-format: C source
```

Tests cover official fixtures, every temperature, Unicode/NUL/100-byte names,
10,000 keys, exact sums/counts, chunk boundaries, missing newlines, sum bounds,
zero-copy memory growth/reset, SIMD opcodes and whole-key collision handling.
Collision tests fault-inject cached metadata in the real kernel; no separate
test-only parser is shipped.

Biome and `wabt` are pinned **development-only** dependencies. The prebuilt
`wasm/kernel.wasm` works without installing them or a C toolchain.

To rebuild or edit C:

```sh
npm run format:c
npm run build:wasm
npm run format
```

This uses existing Clang/LLD tools. `CLANG`, `WASM_LD`, and `CLANG_FORMAT` can
select project-local tools; no global installation is performed by the scripts.
The build records source/binary hashes and compiler/linker commands.

## Generate and measure

The existing local files are `measurements.txt` (1B rows, 13,795,455,110 bytes)
and `measurements-100m.txt` (100M rows), each with expected aggregates in `.out`.
They, runtimes, dependencies and generated results are excluded from git.

```sh
node tools/generate.mjs 1000000000 another-file.txt
ENGINE=wasm npm run bench -- measurements.txt
WARMUP=16 node tools/compare.mjs backends measurements.txt
.runtimes/node-v26.12.0/bin/node tools/verify-wasm.mjs measurements.txt 1000000000
```

The seeded Node generator uses upstream names and Gaussian temperatures,
clamped to the legal range. It creates every row independently, not by repeating
a smaller block. It isn't the official Java generator's exact output.

Each measured run is a fresh process, includes startup, compilation, I/O,
aggregation, merging, sorting, output and shutdown, and validates stdout.
Five runs are the default; fastest/slowest are discarded. Raw reports are in
`results/`. Warm-ups prepare hardware/cache state, never reusable parsed data.
Power settings and the system-wide cache are not altered.

Settings: `ENGINE=phased|wasm`, `WORKERS`, `CHUNK_BYTES`, and `NODE_BIN`.
Benchmark-only settings: `RUNS`, `WARMUP`, `FLAGS`, `SCRIPT` or generic `CASES`.
Future experiments should use git commits/worktrees and the benchmark log,
not permanent runtime strategies. Checkpoint **`ff83918`** contains the previous
experimental code if it is needed for reproduction.

## Attribution

The solver is a new implementation. The challenge, fixtures, station list and
comparison programs come from [1brc/nodejs](https://github.com/1brc/nodejs),
under its Apache-2.0 license. The upstream optimized entry is by Edgar Pogosyan.
