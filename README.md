# 1BRC with Node.js: JavaScript and optional Wasm SIMD

**Node + WebAssembly SIMD: 2.034 seconds for one billion rows**, five-run
trimmed mean; best **2.009 s**, roughly **492 million rows/s** on average.

```sh
ENGINE=wasm ./run.sh measurements.txt
```

The Wasm backend is optional; `./run.sh` alone still uses the pure-JS engine.
A fully warmed, alternating comparison measured **5.670 s JS vs 3.773 s Wasm
SIMD**—about **1.5× faster**. Scalar Wasm was nearly tied at 3.734 s, so the
gain cannot be attributed to SIMD alone. Burst and sustained timings differ
substantially on this laptop. See [Wasm implementation details](wasm/README.md)
and [all benchmark results](BENCHMARKS.md).

The [final JS-only optimization pass](experiments/LAST-PASS.md) found no further
repeatable gain. That JS-only pass did not use Wasm; its kernel remains the JS default.

**Pure-JS default: 3.930 seconds for one billion rows**, five-run trimmed mean.
A matched old/new comparison showed **another 11% improvement**:
**6.116 s → 5.467 s** under the same sustained conditions. The default's best
paired run was **3.066 s**, about **326 million rows/s** or **4.50 GB/s**.
An additional launcher validation completed in **3.03 s** with about **170 MiB RSS**.

Machine: Intel Core Ultra 7 258V, 8 cores, 30 GiB RAM, Linux, Node **26.12.0**;
warm filesystem cache. Burst versus sustained clocks vary substantially on this
active laptop, so compare algorithms within the same alternating run batch.
The previous approximately five-second result is retained in [BENCHMARKS.md](BENCHMARKS.md),
along with the new controlled comparison. These aren't official leaderboard results.

## Run

```sh
./run.sh measurements.txt
```

The default file is `measurements.txt`. Only the sorted result goes to stdout.
The launcher uses the project-local Node 26.12.0 binary already installed in
`.runtimes/`, falling back to `node` on PATH. It doesn't change your system Node.
To choose a different runtime:

```sh
NODE_BIN=/path/to/node ./run.sh measurements.txt
# Or simply:
node calculate.mjs measurements.txt
```

Neither backend needs native addons or npm runtime dependencies. The default
JS path does not use WebAssembly. Its launcher supplies
two measured V8 inlining-budget flags for the phased parser:
`--max-inlined-bytecode-size=1000 --max-inlined-bytecode-size-cumulative=4000`.
Direct `node calculate.mjs` also works, but omits this tuning.
Node 24.16.0 and 26.12.0 both support the implementation.

## How the JS default works

- **Dynamic work distribution.** Workers claim 128 KiB ranges using a shared
  atomic counter. Faster cores process more ranges—important on this hybrid CPU.
  Each worker reuses one small buffer and maintains private aggregates.
- **Exact chunk ownership.** A preceding byte and a small trailing overlap ensure
  that every row is processed exactly once, even when a range splits a UTF-8 name
  or a negative temperature. The entire input is never loaded into the JS heap.
- **Four-byte scanning and hashing.** `DataView` supplies unaligned word loads.
  A documented SWAR zero-byte test finds semicolons four bytes at a time, while
  `Math.imul` builds a 32-bit hash.
- **Flat typed-array aggregates.** A Uint16 hash table points to dense station IDs,
  32-byte integer metadata records, Float64 sums, and Uint32 counts. Station names
  live in one byte arena per worker. Full byte comparisons resolve collisions.
- **Two phased cursors.** Each worker scans station names in two independent
  newline-aligned regions before updating either temperature aggregate. This
  breaks dependency chains. Cold insertion is outlined so V8 can inline the hot
  functions without excessive code growth.
- **No per-row strings or allocations.** Names are copied only when first
  encountered by a worker; UTF-8 decoding happens only for the small result.
  Cached overlapping name words remove an unpredictable middle-word length branch.
- **Branch-light temperature parsing.** An 8 KiB lookup table built from the
  decimal grammar handles `d.d` and `dd.d`. It contains no input-specific data.
- **Exact sums.** Temperatures are integer tenths. Sums use doubles, whose integer
  precision comfortably exceeds the maximum `999 × 1,000,000,000`. Rounding
  follows `Math.round`/Java's ties-toward-positive-infinity rule.

Supported inputs follow the original challenge: valid UTF-8 station names of
1–100 bytes, at most 10,000 stations, and temperatures from -99.9 to 99.9 with
one fractional digit. LF, CRLF, an absent final newline, and an empty file work.
The hot path assumes valid input; it is not a general-purpose CSV validator.
The input must not change while processing.

## Check and format

```sh
npm ci
npm run check       # Biome formatting, imports, and recommended lint rules
npm run format     # Apply Biome's safe fixes
npm test
.runtimes/node-v26.12.0/bin/node --test test/*.test.mjs
```

Biome is a pinned **development-only** dependency. Tests include all eight
upstream fixtures, every temperature, UTF-8 and 100-byte names, 10,000 keys,
shared prefixes, engineered full-hash collisions with matching cached words,
chunk boundaries, rounding, missing newlines, and sums exceeding both signed
and unsigned 32-bit ranges.
An additional differential test checks **60 combinations** of layouts, readers,
cursor counts, table growth, temperature parsers, and statistics storage.

Wasm tests additionally verify the compiled SIMD opcodes, absence of imports,
zero-copy buffer aliasing, memory growth/reset, signed 64-bit sum bounds,
all cursor counts and I/O modes, and forced full-hash collisions. `wabt` is a
development-only inspector; the shipped kernels run without it.
See [wasm/README.md](wasm/README.md) for optional C rebuild/formatting commands.

## Generate and benchmark

`upstream/` is a shallow checkout of <https://github.com/1brc/nodejs>, retained
for its fixtures, generator station list, and unmodified comparison programs.
If recreating the folder elsewhere, clone it first:

```sh
git clone --depth 1 https://github.com/1brc/nodejs.git upstream
```

The files already generated on this machine are:

- `measurements.txt`: **1,000,000,000** rows, approximately 13.8 GB.
- `measurements-100m.txt`: **100,000,000** rows for quicker experiments.
- Each has a `.out` sidecar with aggregates calculated during generation.

To generate a new file (existing files are never overwritten):

```sh
node tools/generate.mjs 1000000000 another-file.txt
```

The seeded generator uses the upstream station names and station-specific
Gaussian temperatures, clamped to the legal range. Every row is generated
independently; the file is **not** constructed by repeating a smaller block.
This is a custom Node generator, not the official Java generator's exact output.

```sh
NODE_BIN="$PWD/.runtimes/node-v26.12.0/bin/node" npm run bench -- measurements.txt

# Alternating old/new comparison, five rounds, with resource/frequency snapshots:
node tools/compare.mjs final measurements.txt

# The upstream optimized implementation, on the exact same input/runtime:
NODE_BIN="$PWD/.runtimes/node-v26.12.0/bin/node" \
  SCRIPT=upstream/src/main/nodejs/Edgar-P-yan/index.js npm run bench -- measurements.txt

# Sequential worker/chunk-size sweep on the smaller file:
NODE_BIN="$PWD/.runtimes/node-v26.12.0/bin/node" RUNS=3 node tools/tune.mjs
```

Each measured run starts a fresh process, includes worker startup, I/O, merging,
sorting, output and shutdown, and checks stdout against the expected result.
Five runs are the default; raw timings, runtime version, machine information,
and code/output SHA-256 hashes are saved under `results/`.
The standard benchmark does **not** drop the OS cache or alter power settings.
The optional `COLD=1` comparison evicts only the challenge input using kernel
advice; see [experiments/README.md](experiments/README.md). Desktop activity and
the laptop's power/thermal state affect results.

Tuning knobs: `WORKERS` (available CPU cores), `CHUNK_BYTES` (131072), `STREAMS`
(2), `ENGINE` (`phased`), and benchmark-only `RUNS`, `SCRIPT`, `FLAGS`.
`NODE_BIN` selects the runtime; both launcher and benchmark prefer the local
Node 26 binary otherwise. `ENGINE=baseline ./run.sh` runs the preserved original
without the new flags. `FLAGS=''` disables automatic flag tuning in benchmarks.
See [experiments/README.md](experiments/README.md) for the alternatives, including
unsuccessful experiments. No system-wide power settings are changed.
See [BENCHMARKS.md](BENCHMARKS.md) for results and experiments.

## Attribution

The solver is a new implementation. The challenge definition, fixtures,
weather-station list and comparison programs come from
[1brc/nodejs](https://github.com/1brc/nodejs), under its Apache-2.0 license.
The upstream optimized entry is by Edgar Pogosyan.
