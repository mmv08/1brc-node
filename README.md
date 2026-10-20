# 1BRC: plain Node.js and WebAssembly

Two optimized implementations of the One Billion Row Challenge live side by side:

- **Plain Node.js:** JavaScript parsing and aggregation, with worker threads and a
  fully verified station-name prediction cache. No WebAssembly or native addons.
- **WebAssembly (default):** Node handles workers and reads; a freestanding Wasm
  kernel parses and aggregates using SIMD, which processes multiple values in one
  CPU instruction. The prebuilt kernel is included.

Neither version needs npm packages at runtime. Both produce identical sorted
`min/mean/max` output and use the same final formatter.

## Run

Requires **Node.js 22 or newer**. Node **26.12.0** is pinned for reproducible benchmarks.

```sh
./run.sh measurements.txt                 # Wasm, the unchanged default
ENGINE=node ./run.sh measurements.txt     # Plain JavaScript
ENGINE=wasm ./run.sh measurements.txt     # Explicit Wasm
```

The input defaults to `measurements.txt`; only the result goes to stdout. The
launcher prefers `.runtimes/node-v26.12.0/bin/node` when present, otherwise `node`
on PATH. `NODE_BIN=/path/to/node` overrides it without changing system Node.

Equivalent npm commands are `npm run start:node -- measurements.txt` and
`npm run start:wasm -- measurements.txt`. To invoke an entry point directly:

```sh
node plain/calculate.mjs measurements.txt # Plain JavaScript, without launcher tuning
node calculate.mjs measurements.txt       # Wasm
```

The launcher supplies two V8 tuning flags for plain Node only. V8 is Node's
JavaScript engine; the flags increase how much helper code it can combine into
its optimized parsing loop:
`--max-inlined-bytecode-size=1000 --max-inlined-bytecode-size-cumulative=4000`.

## Measured results

On an **AMD Ryzen 9 7900, 12 cores / 24 threads, 60 GiB RAM**, using Node
**26.12.0**, the full **1,000,000,000-row / 13,795,455,110-byte** input measured:

| Implementation | Seven-run trimmed mean | Best |
| --- | ---: | ---: |
| Previous plain Node, `f5ed40a` | 1.245 s | 1.198 s |
| **Optimized plain Node** | **1.165 s** | **1.137 s** |
| **Wasm SIMD** | **0.505 s** | **0.499 s** |

The plain version took **6.4% less elapsed time** than its previous implementation
in this same-session comparison. These are warm-filesystem-cache, end-to-end
measurements: startup, compilation, reads, parsing, aggregation, merging, sorting,
output and shutdown all count. Two full-file warm-ups per case were excluded;
then seven alternating rounds discarded each case's fastest and slowest run.
All measured outputs were checked, and measured filesystem-input counters were zero.
Both engines used 24 workers. Throughput was **11.84 GB/s** for Node and
**27.32 GB/s** for Wasm. The existing Wasm implementation remains the fastest tested;
four lanes, prefix prediction and sharing compiled code did not improve it.

The earlier Wasm result of **0.866 s** was on a different Core Ultra 7 258V laptop;
it is not a same-hardware comparison. The earlier loaded-machine plain-Node batch
is also separate. See [BENCHMARKS.md](BENCHMARKS.md) and the
[recorded comparison](benchmarks/2026-10-20-optimization-round.json) for evidence and caveats.
These are local results, not official leaderboard scores.

## Input and design

Both accept the original challenge format: valid UTF-8 station names of 1–100
bytes, at most 10,000 stations, and temperatures from -99.9 to 99.9 with one
fractional digit. Empty input, CRLF and a missing final newline work. Input must
remain unchanged while processing. These are optimized valid-input parsers,
not general-purpose CSV validators.

Workers claim newline-aware ranges from a shared atomic counter, maintain private
aggregates, and merge only the small station results. The full file is never
loaded into the JavaScript heap. Sorting follows UTF-16 order; mean rounding is
Java-compatible. Temperatures are accumulated as exact integer tenths.

### Plain Node.js

`plain/calculate.mjs` and `plain/lib/` contain the JavaScript implementation.
Workers use 128 KiB chunks, four-byte delimiter scanning, typed-array hash tables
and two independent parsing cursors. There are no per-measurement strings or objects.

A 64 KiB worker-local cache predicts a station from its first five bytes; for a
four-byte name, the fifth byte is its delimiter. A hit
must match the **entire name and its delimiter** before it can skip scanning and
rolling-hash calculation. Cached entries supply their stored length directly;
hash-table lookups check the scanned length before comparing bytes. Misses use
the general hash-table parser; names shorter than four bytes are not cached.
The cache learns only station IDs while reading the current file:
no hardcoded station names, precomputed answers or parsed state survive a process.
Its benefit depends on name distribution; shared prefixes can reduce it or cause
regressions without changing correctness.

Workers load a small dedicated entry point and post completed aggregates before
exiting, allowing the main thread to merge results while threads shut down.

### WebAssembly

The existing `calculate.mjs`, `wasm/` kernel and worker, and shared reader are
unchanged. Workers use 512 KiB chunks, read directly into Wasm memory, and process
three parsing lanes with complete name verification and exact signed 64-bit sums.
Details and build instructions: [wasm/README.md](wasm/README.md).

## Test and develop

The upstream checkout supplies official fixtures and the generator's station list:

```sh
git clone --depth 1 https://github.com/1brc/nodejs.git upstream
npm ci --ignore-scripts
npm test                 # Both versions and launcher/benchmark integration
npm run test:node        # Plain-Node correctness suite
npm run test:wasm        # Existing Wasm correctness suite
npm run check            # JavaScript/JSON formatting and lint
npm run check:c          # Existing C format check; requires clang-format
```

Tests cover official fixtures, every legal temperature spelling, Unicode/NUL and
100-byte names, 10,000 stations, exact sums and counts, hash/prefix collisions,
chunk boundaries, CRLF, EOF and integer sums beyond 32-bit limits. Integration
checks compare exact tuples between both versions and run plain Node without any
Wasm files or npm dependencies. Wasm-specific tests also check memory aliases,
reset behavior, SIMD instructions, branch hints and the shipped build hashes.

Biome and `wabt` are pinned **development-only** dependencies. Running either
solver needs neither an npm install nor a C toolchain. For Wasm development,
`npm run build:wasm`, `npm run format:c`, `CLANG`, `WASM_LD` and `CLANG_FORMAT`
remain available; no system tools are installed by these scripts. The C-format
helper also detects a local `.runtimes/formatting/bin/clang-format`; version
21.1.8 was used for the latest check. Pointer alignment is explicit so checking
formatting does not rewrite the existing kernel's pointer style.

## Generate, verify and benchmark

```sh
node tools/generate.mjs 1000000000 measurements.txt
node tools/verify-engines.mjs measurements.txt 1000000000
npm run bench:node -- measurements.txt
npm run bench:wasm -- measurements.txt
RUNS=7 WARMUP=2 node tools/compare.mjs node-vs-wasm measurements.txt
```

The seeded generator creates independent rows using upstream station names and
Gaussian temperatures clamped to the legal range. It also writes `measurements.txt.out`
with the expected output and refuses to overwrite either file. This is not the
exact output of the upstream Java generator, nor repeated copies of a small block.

`verify-engines.mjs` compares every station's exact name/minimum/sum/maximum/count
between the versions, checks the row count, and validates complete expected stdout.
Benchmark processes are fresh and always validate stdout. `bench` defaults to Wasm;
`compare` defaults to both versions and alternates case order. The comparison tool
uses Linux GNU `/usr/bin/time` for CPU, memory and filesystem-input counters.

Common settings are `ENGINE` (`node` or `wasm`), `WORKERS`, `CHUNK_BYTES`, and
`NODE_BIN`. Chunk defaults differ: 131072 bytes for Node, 524288 for Wasm.
Plain-Node tuning also accepts `STREAMS` (1–4, default 2), `TABLE_BITS` (14–16,
default 15), `TEMPERATURE` (`table`, `compact`, `arithmetic`; default `table`),
`NAME_COMPARE` (`branchless` by default), and `IO` (`sync`, `async`, `macro`;
default `sync`). `PRIVATE_FD=1` opens a per-worker file; `MACRO_BYTES` configures
macro reads. These are tuning settings within the plain solver, not extra engines.

Benchmark-only settings include `RUNS`, `WARMUP` (full-file warm-up rounds per case
in `compare`), `FLAGS`, `SCRIPT` (in `bench`) and generic `CASES` (in `compare`).
Worktree comparisons hash each script's own dependencies. Reports go to ignored
`results/`; reviewed evidence lives in `benchmarks/`. Datasets, local runtimes,
profiles and npm dependencies are ignored. No power settings or system-wide caches
are changed. Reports include inherited parser/runtime tuning and verify source
hashes before and after each run. Every experiment in the latest round has an
unsigned checkpoint commit; rejected implementations remain in git history.

## Attribution

The solvers are new implementations. The challenge, fixtures, station list and
comparison programs come from [1brc/nodejs](https://github.com/1brc/nodejs),
under its Apache-2.0 license. The upstream optimized entry is by Edgar Pogosyan.
