# 1BRC: plain Node.js and WebAssembly

Two optimized implementations of the One Billion Row Challenge:

- **Plain Node.js:** JavaScript parsing and aggregation with worker threads,
  two parsing lanes and a fully verified station-name prediction cache.
- **WebAssembly (default):** Node workers and reads with a freestanding SIMD
  kernel. The compiled kernel is included.

Both run without npm packages and produce identical sorted `min/mean/max` output.
General compiler improvements, patches and official benchmark measurements are
preserved in the [V8 research](v8-research/README.md).

## Run

Requires **Node.js 22 or newer**; **26.12.0** is pinned for benchmark reproduction.

```sh
./run.sh measurements.txt                 # Wasm
ENGINE=node ./run.sh measurements.txt     # Plain Node.js
```

The input defaults to `measurements.txt`. Only results go to stdout. The launcher
uses `.runtimes/node-v26.12.0/bin/node` when available, then `node` on PATH;
`NODE_BIN=/path/to/node` overrides this choice.

Equivalent npm commands are `npm run start:node -- measurements.txt` and
`npm run start:wasm -- measurements.txt`. The entry points are
`plain/calculate.mjs` and `calculate.mjs`, which also export `calculate(file,
{ workers, chunkSize })` for exact `[name, min, sum, max, count]` results in tenths.

The Node launcher supplies the measured tuning flags
`--max-inlined-bytecode-size=1000 --max-inlined-bytecode-size-cumulative=4000
--v8-pool-size=8`. Direct invocation of `plain/calculate.mjs` omits those flags.

Runtime settings:

| Setting | Default |
| --- | --- |
| `ENGINE` | `wasm`; accepts `node` or `wasm` |
| `WORKERS` | Available logical CPUs, limited by input size |
| `CHUNK_BYTES` | 131072 for Node; 524288 for Wasm |
| `NODE_BIN` | Local pinned runtime, then Node on PATH |

The parser and I/O experiments have been removed from the runtime configuration.
Historical alternatives remain in Git at checkpoint `351f07f`.

## Performance

On an **AMD Ryzen 9 7900 (12 cores / 24 threads, 60 GiB RAM)** with Node
**26.12.0**, the retained implementations processed **1 billion rows /
13,795,455,110 bytes** in **1.024 s (Node)** and **0.476 s (Wasm)** before cleanup.
These include startup, compilation, cached reads, parsing, merging and shutdown.
They are local measurements, not leaderboard scores or a theoretical limit.

After cleanup, a fresh matched comparison measured **1.019 s (Node)** and
**0.483 s (Wasm)**, with no measurable change relative to the pre-cleanup commit.
See [BENCHMARKS.md](BENCHMARKS.md) for paired intervals, raw measurements,
validation and the earlier experiment history.

## Design and input

Both accept valid UTF-8 station names of 1–100 bytes, at most 10,000 stations,
and temperatures from -99.9 to 99.9 with one fractional digit. Empty input,
CRLF and a missing final newline work. The input must remain unchanged while
processing. These parsers assume valid challenge input.

`lib/` shares the worker coordinator, newline-aware synchronous reader and
formatter. Workers claim ranges through an atomic counter and keep private
aggregates. Only station results are merged; the full file is never loaded into
the JavaScript heap. Sums are exact integer tenths, means use Java-compatible
rounding, and sorting follows UTF-16 order.

`plain/lib/aggregate.mjs` uses four-byte delimiter scanning, typed-array tables
and two independent parsing cursors. Its 128 KiB prediction cache packs station
IDs and name lengths. Every prediction verifies the entire name and delimiter;
misses use the general hash-table parser. No station dictionary or parsed state
survives a process. Integer buffer cursors fit within the 256 MiB chunk limit;
file offsets retain full JavaScript-number precision.

The Wasm kernel reads directly into its memory and uses three parsing lanes,
SIMD statistics updates, exact 64-bit sums and complete name verification.
See [wasm/README.md](wasm/README.md) for the kernel design and build details.

## Develop and verify

The upstream checkout supplies official fixtures and the generator's station list:

```sh
git clone --depth 1 https://github.com/1brc/nodejs.git upstream
npm ci --ignore-scripts
npm test
npm run test:node
npm run test:wasm
npm run check
npm run check:c           # Requires clang-format
npm run build:wasm        # Requires Clang and a Wasm linker
```

Tests cover official fixtures, all legal temperature spellings, Unicode/NUL and
100-byte names, 10,000 stations, hash/prefix collisions, chunk boundaries, CRLF,
EOF and exact sums beyond 32-bit limits. Integration tests check both launchers,
benchmark provenance and running plain Node without Wasm files or npm packages.
Wasm tests also check memory aliases, reset behavior, SIMD, branch hints and
source/binary hashes.

Biome and `wabt` are pinned development dependencies. `CLANG`, `WASM_LD` and
`CLANG_FORMAT` select build tools; the scripts install no system tools. C format
checking also recognizes `.runtimes/formatting/bin/clang-format`. The formatter
excludes the V8 research archive to preserve recorded artifacts and d8 scripts.

## Generate and benchmark

```sh
node tools/generate.mjs 1000000000 measurements.txt
node tools/verify-engines.mjs measurements.txt 1000000000
npm run bench:node -- measurements.txt
npm run bench:wasm -- measurements.txt
RUNS=7 WARMUP=2 node tools/compare.mjs node-vs-wasm measurements.txt
```

The seeded generator uses upstream station names and independent Gaussian
measurements clamped to the legal range. It writes expected output alongside
the input and refuses to overwrite either file. The verifier compares exact
station/minimum/sum/maximum/count tuples, total rows and complete expected output.

Benchmarks use fresh processes and validate every output. `compare` alternates
case order and uses Linux GNU `/usr/bin/time` for CPU, memory and filesystem
counters. `RUNS`, `WARMUP`, `FLAGS`, `SCRIPT` (bench) and JSON `CASES` (compare)
control measurements. Each case can specify `name`, `env` and an optional `script`
from another checkout. Source hashes are checked before and after every run.

Datasets, dependencies, local runtimes, builds and raw diagnostic workspaces are
ignored under `results/` or their dedicated directories. Reviewed solver results
live in `benchmarks/`; V8 patches, profiles and reproducibility tools live in
`v8-research/`. The solvers run on stock Node, independently of the V8 experiments.

## Attribution

The solvers are new implementations. The challenge, fixtures, station list and
comparison programs come from [1brc/nodejs](https://github.com/1brc/nodejs), under
its Apache-2.0 license. The upstream optimized entry is by Edgar Pogosyan.
