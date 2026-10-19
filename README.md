# 1BRC with Node.js and Wasm SIMD

One optimized implementation: Node handles workers, file reads and final output;
a freestanding Wasm SIMD kernel parses and aggregates the measurements.
On this Core Ultra 7 258V in performance mode, the cached billion-row benchmark
averages **1.257 seconds**. A further optimization round reduced elapsed time
by **6.7%** against the previous winner in a matched test.
Only the selected solver is shipped. Optimization attempts are checkpointed in
git, with measured results in [BENCHMARKS.md](BENCHMARKS.md).

## Run

```sh
./run.sh measurements.txt
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

- Workers claim 512 KiB ranges using a shared atomic counter, naturally balancing work
  across the machine's different CPU cores.
- A preceding byte and trailing overlap ensure exact row ownership when a
  range splits a name or temperature. The full file isn't loaded into the heap.
- Input buffers alias Wasm memory directly. One host call processes a chunk;
  there are no per-row JS/Wasm calls or input copies.
- Three lanes scan names, resolve stations, then update statistics in separate
  phases. SIMD scans delimiters; masked hashing and matching avoid length branches.
- The 100-byte name limit packs each scanned name pointer and length into one
  value. Head words are loaded during lookup, keeping less state between phases.
- A pointer table references compact 40-byte records. Hashing mixes each pair of
  words with one multiplication; its high bits select buckets. Full name checks
  use bounded SIMD comparisons, with insertion and collision probing outlined.
- SIMD updates exact signed 64-bit sums, counts and min/max values; fixed lane
  shuffles merge the fields. Objects are allocated per station, never per measurement.
- Final sorting uses UTF-16 order and Java-compatible rounding.

Details: [wasm/README.md](wasm/README.md).

## Test and format

The upstream checkout supplies official fixtures and the generator station list:

```sh
git clone --depth 1 https://github.com/1brc/nodejs.git upstream
npm ci
npm test
npm run check
npm run check:c
```

Tests cover official fixtures, every legal temperature, Unicode/NUL/100-byte
names, 10,000 keys, exact sums/counts, chunk boundaries, missing newlines,
sum bounds, zero-copy memory growth/reset, SIMD opcodes and whole-key collisions.
Collision tests fault-inject cached metadata in the production kernel.

Biome and `wabt` are pinned development-only dependencies. The prebuilt
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
npm run bench -- measurements.txt
WARMUP=16 node tools/compare.mjs current measurements.txt
.runtimes/node-v26.12.0/bin/node tools/verify-wasm.mjs measurements.txt 1000000000
```

The seeded Node generator uses upstream names and Gaussian temperatures,
clamped to the legal range. It creates each row independently; it isn't the
exact output of the official Java generator.

Each measured run is a fresh process and validates complete stdout. Startup,
compilation, I/O, parsing, aggregation, merging, sorting and shutdown all count.
Five runs are the default; fastest/slowest are discarded. Warm-ups prepare
hardware/cache state, never reusable parsed data. The scripts do not change
system power settings or drop the system-wide file cache.

Settings: `WORKERS`, `CHUNK_BYTES`, and `NODE_BIN`. Benchmark-only settings:
`RUNS`, `WARMUP`, `FLAGS`, `SCRIPT`, or generic `CASES` with scripts from git
worktrees. Worktree comparisons hash each script's own source dependencies.
Keep future attempts in commits/worktrees and retain only the measured winner
in the production tree. See the benchmark log for checkpoint and report paths.

## Attribution

The solver is a new implementation. The challenge, fixtures, station list and
comparison programs come from [1brc/nodejs](https://github.com/1brc/nodejs),
under its Apache-2.0 license. The upstream optimized entry is by Edgar Pogosyan.
