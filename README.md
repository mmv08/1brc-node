# 1BRC: Node.js, WebAssembly and V8 research

Two optimized One Billion Row Challenge solvers, with no runtime dependencies:

- **Plain Node.js:** two parsing lanes, typed-array aggregates and fully verified
  station-name predictions.
- **WebAssembly:** three SIMD lanes, direct input into Wasm memory and exact
  64-bit sums. The compiled kernel is included.

Both use shared worker scheduling, synchronous reads and formatting. The V8
research is [one patch](v8.patch) containing the measured winning sequence.
[OPTIMIZATIONS.md](OPTIMIZATIONS.md) records the results, tradeoffs, all attempted
optimizations and the upstream base needed to apply the patch. Both solvers run
on stock Node independently of that research.

## Run

Node.js 22 or newer is required; benchmarks used Node 26.12.0.

```sh
./run.sh measurements.txt                 # Wasm, the default
ENGINE=node ./run.sh measurements.txt     # Plain Node.js
```

The input defaults to `measurements.txt`. Only the result goes to stdout. The
launcher prefers `.runtimes/node-v26.12.0/bin/node`, then `node` on PATH;
`NODE_BIN=/path/to/node` overrides it. `WORKERS` defaults to available logical
CPUs, limited by input size. `CHUNK_BYTES` defaults to 131072 for Node and
524288 for Wasm.

The Node launcher supplies the measured flags
`--max-inlined-bytecode-size=1000 --max-inlined-bytecode-size-cumulative=4000
--v8-pool-size=8`. The entry points `plain/calculate.mjs` and `calculate.mjs`
export `calculate(file, { workers, chunkSize })`, returning exact
`[name, min, sum, max, count]` tuples; temperatures are integer tenths.

Input supports valid UTF-8 names of 1–100 bytes, up to 10,000 stations and
one-decimal temperatures from −99.9 to 99.9. Empty files, CRLF and a missing final
newline work. Input must remain unchanged during processing. Names are fully
verified, sums are exact, means use Java-compatible rounding and sorting follows
UTF-16 order. The parsers assume valid challenge input.

The latest matched cleanup measurements on a Ryzen 9 7900 were **1.019 s for
Node** and **0.483 s for Wasm** over one billion rows, including startup and
cached reads. Neither changed measurably against the pre-cleanup versions.
Protocols and uncertainty are in [OPTIMIZATIONS.md](OPTIMIZATIONS.md).

## Build and test

The upstream checkout supplies official fixtures and the generator's station list:

```sh
git clone --depth 1 https://github.com/1brc/nodejs.git upstream
npm ci --ignore-scripts
npm test
npm run check
npm run check:c           # Requires clang-format
npm run build:wasm        # Requires Clang and a Wasm linker
```

`npm run test:node` and `npm run test:wasm` run individual correctness suites.
Tests cover exact tuples, official fixtures, all temperature spellings, Unicode,
NULs, collisions, long names, chunk boundaries and sums beyond 32 bits. The Wasm
suite also checks memory aliases, SIMD, branch hints and source/binary hashes.

`CLANG`, `WASM_LD` and `CLANG_FORMAT` select build tools. Biome and `wabt` are
pinned development dependencies. Running the solvers needs neither npm packages
nor a C toolchain. `wasm/build.json` records the shipped kernel's build and hashes.

## Generate and benchmark

```sh
node tools/generate.mjs 1000000000 measurements.txt
node tools/verify-engines.mjs measurements.txt 1000000000
npm run bench -- measurements.txt         # Both engines, alternating order
npm run bench:node -- measurements.txt
npm run bench:wasm -- measurements.txt
```

The seeded generator creates independent rows and expected output, refusing to
overwrite either file. The verifier compares exact tuples, row counts and stdout.
The single benchmark runner validates every output and hashes each solver's
sources before and after runs. It includes fresh process startup and uses Linux
GNU `/usr/bin/time` for CPU, memory and filesystem counters. `RUNS` and `WARMUP`
control measured and warmup rounds; `FLAGS` overrides runtime flags. JSON `CASES`
can compare named settings or entry scripts in checkouts with the same layout.

Datasets, dependencies, local runtimes and generated results are ignored. The
tracked tree contains the solvers, their support tools/tests, the V8 patch and
one research/history document. Earlier artifacts remain in Git history.

The challenge, fixtures and station list come from
[1brc/nodejs](https://github.com/1brc/nodejs), under Apache-2.0. The upstream
optimized entry is by Edgar Pogosyan; the solvers here are new implementations.
