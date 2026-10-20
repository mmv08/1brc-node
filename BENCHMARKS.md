# Benchmark and experiment log

## Current: further Node optimization and Wasm trials, 2026-10-20

Both implementations remain available. The selected plain Node implementation
is faster; the existing Wasm implementation was retained after its experimental
alternatives failed to improve elapsed time. Selected source: **`fd3771a`**.
Every experiment below has an **unsigned checkpoint commit**, including rejected
attempts. No experimental parser or third engine remains in the runtime tree.

### Final matched comparison

- This machine: AMD Ryzen 9 7900, 12 physical cores / 24 logical CPUs, 60 GiB RAM,
  Linux 7.0.0-38-generic; Node **26.12.0**; 24 workers per implementation.
- Unchanged `powersave` governor and `balance_performance` preference. No power
  settings or system-wide caches were changed.
- The existing seeded input contains **1,000,000,000 independently generated
  measurements**, **13,795,455,110 bytes**, and 413 stations. Reused read-only from
  the local checkout; no generation or repeated input blocks enter the timings.
- Two excluded full-file warm-ups per case, then **seven alternating rounds**.
  Each score discards the fastest and slowest run and averages the remaining five.
- Fresh processes include startup, compilation, reads, parsing, aggregation,
  merging, sorting, complete output and shutdown. All 21 measured processes
  matched expected stdout and reported **zero filesystem inputs**: warm-cache results.
- Node uses the two documented inlining flags and 128 KiB chunks; Wasm uses no
  extra flags and 512 KiB chunks. Benchmark source hashes guard each run.

| Implementation | Trimmed mean | Best | Throughput | Peak RSS |
| --- | ---: | ---: | ---: | ---: |
| Previous plain Node, `f5ed40a` | 1.245 s | 1.198 s | 11.08 GB/s | 343,892 KiB |
| **Selected plain Node** | **1.165 s** | **1.137 s** | **11.84 GB/s** | 340,724 KiB |
| **Retained Wasm SIMD** | **0.505 s** | **0.499 s** | **27.32 GB/s** | 318,948 KiB |

Plain Node takes **6.4% less elapsed time** than the preceding implementation in
this matched batch. The Wasm source hash remains exactly
`2efc93726477dab9bb83e0ca8f2b2ebb257bb3f982fdfb14062dcf7d8cc61886`.
Its earlier 0.497 s result is a separate batch, not a source regression.
These are local measurements, not official challenge scores.

Raw results, tuning, source hashes and resource counters:
[`2026-10-20-optimization-round.json`](benchmarks/2026-10-20-optimization-round.json).
Exact billion-row validation:
[`2026-10-20-exact-verification.json`](benchmarks/2026-10-20-exact-verification.json).

### Selected changes and validation

The Node prediction hash now includes a fifth stable byte, which distinguishes
names sharing their first four bytes. For four-byte names it includes their
semicolon. Reducing the prediction table from 128 KiB to **64 KiB per worker**
also helped this input. A hit still verifies every name byte and the delimiter;
the smaller table supports arbitrary valid names through the general fallback.
The equality helper takes the stored length directly on predicted hits, while
hash-table lookups explicitly check the scanned length before comparing bytes.

A dedicated Node worker entry loads only aggregation code. The main thread
starts workers while loading the formatter and merges posted aggregates while
workers exit. Each worker has finished reading before it posts its result.

All **52 tests pass on Node 24.15.0 and 26.12.0**. Exact station-name/minimum/sum/
maximum/count tuples match across both engines for **all one billion rows**, and
their complete stdout matches the independently generated expected output.
Biome and C-format checks pass; the latter used clang-format 21.1.8. The retained
Wasm source, binary, build manifest and host code are unchanged from `f5ed40a`.

The benchmark tools now hash the dedicated Node worker, record inherited tuning
variables, and check source hashes before and after warm-up and measured runs.

### Experiment checkpoints

Values within each row are from its own matched screening batch. Do not combine
separate batches to calculate incremental gains. The initial worker/cache and
chunk screens used three rounds and one warm-up; later parser trials used five
rounds and two warm-ups.

| Checkpoint | Experiment | Matched result and decision |
| --- | --- | --- |
| `5cc6fe6` | Pack name length beside predicted Node station ID | 1.262 s vs 1.234 s; rejected |
| `6cac5bf` | Worker-count screen | Node 24: 1.234 s, 12: 1.258 s; Wasm 12/16/24 about 0.50 s; retain defaults |
| `dfe8dc1` | Derive Node row width from decimal-point position | 1.275 s vs 1.233 s; rejected |
| `9b1d4f6` | Four Wasm parsing lanes | 0.514 s vs 0.509 s same-toolchain three-lane control; rejected |
| `65c7a8f` | Chunk sizes and immediate Wasm optimizing compilation | No chunk improvement; immediate compilation 0.531 s vs 0.507 s; retain defaults |
| `2ab1297` | Fifth byte in Node prediction hash | 1.234 s vs 1.249 s; retained with smaller table |
| `a27dfb5` | Halve Node prediction table | 1.228 s vs 1.234 s with larger fifth-byte table; retained |
| `b644f8d` | Wasm short-name prefix prediction | 0.559 s vs 0.505 s; rejected |
| `ab71544` | Smaller Node worker entry and earlier merging | Alone 1.218 s vs 1.249 s; combined with predictor 1.201 s; retained |
| `c054e10` | Compile Wasm once and share its module with workers | 0.505 s vs 0.504 s; no improvement, rejected |
| `5deaa9f` | Pass known Node name lengths directly to equality | 1.170 s vs selected predictor/startup's 1.191 s; retained |

Wasm rebuild experiments used Clang 21.1.8 / LLD 21.1.8. A separate rebuild of
the original source isolated toolchain effects; the final selection restores the
original shipped binary and provenance. Screening reports are preserved under
[`benchmarks/experiments/`](benchmarks/experiments/).

Reproduce the two selected implementations:

```sh
RUNS=7 WARMUP=2 node tools/compare.mjs node-vs-wasm measurements.txt
node tools/verify-engines.mjs measurements.txt 1000000000
```

To include the preceding Node implementation:

```sh
git worktree add --detach results/baseline-f5ed40a f5ed40a
CASES='[{"name":"Previous plain Node","script":"results/baseline-f5ed40a/plain/calculate.mjs","env":{"ENGINE":"node"}},{"name":"Optimized plain Node","env":{"ENGINE":"node"}},{"name":"Wasm SIMD","env":{"ENGINE":"wasm"}}]' \
  RUNS=7 WARMUP=2 node tools/compare.mjs matched-round measurements.txt
```

The screening reports refer to ignored source snapshots in `results/`.
Their experiment commits preserve the source; the final benchmark used a clean
archive of `f5ed40a` for its preceding-Node baseline. Dataset, runtime and local
dependencies remain ignored.

## Previous: both plain Node.js and Wasm, 2026-10-20

The main branch now includes two selected implementations: the optimized plain
Node.js solver under `plain/`, and the existing Wasm solver under `wasm/`.
`ENGINE=node ./run.sh` selects plain JavaScript; `./run.sh` still defaults to Wasm.
The existing Wasm entry, reader, formatter, kernel and build files are unchanged.

### Matched quiet-machine comparison

- AMD Ryzen 9 7900: 12 physical cores, 24 logical CPUs, 60 GiB RAM; Linux x86-64.
- Node **26.12.0**, 24 workers, unchanged `powersave` / `balance_performance`
  preferences. No competing build was observed during the run.
- Exactly **1,000,000,000 independent measurements**, **13,795,455,110 bytes**,
  413 stations; seeded repository generator and upstream station list.
- Two complete warm-up processes **per case**, excluded from scoring, then five
  alternating rounds. Each case discarded its fastest and slowest measurement.
- Every process was fresh and validated complete expected stdout. Startup,
  compilation, reads, parsing, aggregation, merging, sorting, output and shutdown count.
- All **15 measured processes** reported zero filesystem input, confirming cached
  input. No cached parser output, station dictionary or aggregates were reused.

| Solver | Trimmed mean | Best | Default chunk |
| --- | ---: | ---: | ---: |
| Original Node.js, `6915b53` | 1.441 s | 1.419 s | 128 KiB |
| **Optimized plain Node.js** | **1.242 s** | **1.212 s** | 128 KiB |
| **Unchanged Wasm SIMD** | **0.497 s** | **0.495 s** | 512 KiB |

The optimized plain solver took **13.8% less elapsed time**, or **1.160× throughput**,
than the original Node implementation in this matched batch. Both Node cases used
`--max-inlined-bytecode-size=1000 --max-inlined-bytecode-size-cumulative=4000`;
Wasm used no extra V8 flags. All three cases used their documented default parser
settings. The original Node baseline came from an isolated worktree at
`6915b53d2c919871095a59a645ee265fa9d3e019`.

Raw measured seconds, in execution-round order:

- Original Node: 1.428960, 1.446959, 1.446827, 1.419375, 1.468993.
- Optimized Node: 1.240292, 1.217088, 1.281474, 1.212370, 1.269967.
- Wasm: 0.494677, 0.520639, 0.494769, 0.495278, 0.500511.

Full flags, source hashes, timings, CPU time, peak resident memory and filesystem
counters are recorded in
[`benchmarks/2026-10-20-both-engines.json`](benchmarks/2026-10-20-both-engines.json).
Absolute local paths in that export are portable labels; measured values are unchanged.
The Wasm source hash remains
`2efc93726477dab9bb83e0ca8f2b2ebb257bb3f982fdfb14062dcf7d8cc61886`,
identical to the previous selected Wasm solver.

### Plain-Node change and checks

The new worker-local prefix table predicts a station ID from its first four name
bytes. The cached length is only a hint: the delimiter and **every name byte**
must match before the hit skips scanning and rolling hashing. Misses retain the
general parser and hash table. Names shorter than four bytes are not cached.
This works with arbitrary valid station names, not a hardcoded station list.
Prefix-heavy inputs can have fewer hits or regress; the fallback preserves correctness.

The implementation was independently reviewed. Tests include exact tuples,
collisions, all legal temperature spellings, Unicode/NUL/100-byte names, 10,000
stations, chunk boundaries, CRLF/EOF and sums beyond 32-bit limits. Integration
checks cover both launchers and prove plain Node runs without Wasm files or npm
packages. `tools/verify-engines.mjs` compares every station's exact aggregates
and total measurement count between both implementations on a supplied input.

Reproduce the comparison of the two shipped versions:

```sh
RUNS=5 WARMUP=2 node tools/compare.mjs node-vs-wasm measurements.txt
```

For the original Node baseline as well, first check out `6915b53` separately and
pass its `calculate.mjs` path through the generic comparison cases:

```sh
git worktree add --detach results/baseline-node 6915b53
CASES='[{"name":"Original Node","script":"results/baseline-node/calculate.mjs","env":{"ENGINE":"phased"}},{"name":"Optimized Node","env":{"ENGINE":"node"}},{"name":"Wasm","env":{"ENGINE":"wasm"}}]' \
  RUNS=5 WARMUP=2 node tools/compare.mjs original-node-and-both measurements.txt
```

`phased` is the historical Node implementation's engine name, accepted here only
for external-worktree comparisons. The public launcher accepts `node` and `wasm`.
The comparison tool requires Linux GNU `/usr/bin/time` for resource counters.

### Earlier measurements and limits

The first idle-machine original-Node batch measured 1.434 s. An earlier candidate
comparison during unrelated Rust/C++ compilation measured 1.941 s original versus
1.657 s optimized (14.6% less elapsed time). That loaded batch is **not** directly
comparable with idle-machine results and is superseded by the quiet matched batch
above. The previous 0.866 s Wasm result was measured on a different Core Ultra
7 258V laptop; it remains documented below, not treated as a same-machine baseline.
None of these are official leaderboard measurements or universal speed guarantees.

## Historical Wasm result: eleventh round, 2026-10-19

Entries below describe the checkouts and hardware used at the time. Historical
statements about shipping one solver apply to those checkouts, not the current
two-implementation tree. Current run and test commands are in [README.md](README.md).

The eleventh round shortens each lane's dependency chain, makes the long-name
fallback branch-free, retunes hash mixers away from first-bucket collisions and
derives Wasm branch hints so V8 keeps cold paths out of the hot loop. Workers
also start from a smaller entry module. Defaults remain eight workers and
512 KiB chunks. Only the selected solver is shipped. This round's attempts were
screened in temporary worktrees and are **not committed**; their sources are
saved locally under `results/round11-attempts/`.

Same Core Ultra 7 258V, Node 26.12.0, performance mode, eight workers,
512 KiB chunks and billion-row input. After **16 full-file warm-up processes**,
nine alternating rounds gave:

| Solver | Trimmed mean | Best |
| --- | ---: | ---: |
| Previous winner, `fe74b8e` | 1.005 s | 0.995 s |
| **Eleventh-round solver** | **0.866 s** | **0.849 s** |

**13.8% less elapsed time**, or **1.161× throughput**, in the matched comparison.
The candidate was faster in all nine paired rounds. Scores discard the fastest
and slowest run and average the remaining seven. This is a cached
**15.93 logical GB/s** result including startup, compilation, reads, parsing,
aggregation, merging, sorting, output and shutdown. Average user CPU fell from
6.06 s to 4.98 s; system time, almost entirely the read copy, stayed near 1.4 s.
Peak RSS: 157,872 KiB. The import-free module is **11,499 bytes**.

An initial comparison with the same settings measured 1.006 s for the previous
winner and 0.858 s (14.7% less) for the candidate, whose command-line entry then
awaited the formatter import separately; the shipped entry awaits both together.
The candidate was faster in all nine rounds there too. Separate batches must not
be combined.

### Diagnosis

Pinned single-core counters for the previous winner on the 100M-row file showed
**90 native instructions and 20.7 cycles per row** on a P-core (IPC 4.3), about
five store uops per row of which only one was the statistics store, 12% of user
cycles in the long-name fallback and 0.06 mispredicted branches per row, mostly
from long names. Native code showed V8 spilling values that only cold paths
needed, rebuilding SIMD constants every iteration and inserting masked variable
shifts. A worker timeline put reads at about 20% and parsing at about 80% of
worker time, with roughly 40 ms before all workers parse and 15 ms after.

### Selected changes

Single-core screening ran the production reader and each kernel on the 100M-row
file in one thread, pinned to a P-core (cpu 2 or 3) or an E-core (cpu 5 or 6),
alternating variants and taking medians. Each row compares a matched pair in one
batch; separate rows must not be combined. Values are cycles per row unless noted.

| Change | P-core | E-core | Instructions/row |
| --- | ---: | ---: | ---: |
| Temperature lookup anchored at the decimal point | 20.67 → 20.01 | — | 89.7 → 82.3 |
| Statistics delta vectors selected by that lookup | 20.0 → 18.9 | — | 82.3 → 78.6 |
| Bitmask key verification | 18.8 → 18.8 | — | 78.4 → 76.0 |
| Two overlapping vectors verify long names | 18.98 → 18.7 | — | 76.0 → 77.0 |
| Branch-free two-vector fallback below 32 bytes | 18.78 → 18.51 | 24.5 → 22.7 | 77.1 → 76.0 |
| Outlined miss lookup recomputes the hash | 18.73 → 18.75 | — | 76.1 → 73.7 |
| Derived branch hints, newline kernel | 17.87 → 17.28 | 24.38 → 23.02 | 81.9 → 74.2 |
| Newline row advance and counted loop, both hinted | 18.63 → 17.18 | 22.66 → 23.03 | 69.3 → 73.5 |
| Self-tuning mixers | 16.99 → 16.35 | 22.76 → 21.82 | 73.3 → 72.1 |
| Inlined fallback marked by a cold call | 16.38 → 16.04 | 22.00 → 21.56 | 72.4 → 72.1 |
| Splat and mixer constants loaded from memory | 15.97 → 15.55 | 21.45 → 20.99 | 72.1 → 71.6 |

The temperature index packs the low nibbles of the two bytes before the decimal,
the tenths digit and the sign bit; one `uint16` lookup returns the offset of a
precomputed vector holding the sum increment, a count increment and the value
for the min/max lanes. This removes the sign normalization's variable shift and
the scalar-to-vector moves. Two-vector verification removes the long-name
`length == 16` branch, which caused 16% of mispredictions. The two-vector
fallback hashes canonical 32-byte keys exactly like the general parser and
compares them with the arena copy, so a triple containing a long name no longer
mispredicts inside the fallback.

Branch hints changed nothing measurable on the previous kernel (about 484 ms
single-core either way), but once cold paths dominated register pressure they
removed about eight native instructions per row, mostly spills. The newline
row advance trades about four instructions for a roughly halved dependency
chain: P-cores, which were latency-bound, gain 7.8% while E-cores lose 1.7%;
weighted by their share of chunks it is a clear gain, confirmed in full runs.
Three station pairs share a first bucket under the initial mixers, sending 0.7%
of rows through probing; retuning removes all of them.

Matched full-file checkpoints, seven alternating rounds after six warm-ups,
each compared only within its own batch:

| Report | Previous winner | Checkpoints |
| --- | ---: | --- |
| `s1-wide1` | 0.977 s | two-vector fallback 0.918 s |
| `s2-nl3a` | 0.994 s | fallback with hints 0.927 s; newline advance 0.911 s |
| `s3-inl1` | 1.002 s | newline advance 0.909 s; inlined fallback 0.882 s |
| `s4-cst2` | 0.997 s | inlined fallback 0.876 s; loaded constants 0.861 s |

A dedicated worker entry, merging each result as it arrives and loading the
formatter after spawning measured 0.860 versus 0.866 s, then 0.850 versus
0.860 s in eleven-round batches. The re-swept chunk size kept 512 KiB:
256 KiB 0.873 s, **512 KiB 0.857 s**, 1 MiB 0.873 s.

### Rejected attempts

| Attempt | Matched result | Decision |
| --- | --- | --- |
| Scalar comparison of mixed key words | 82.3 → 85.7 instructions/row; V8 emitted a redundant load beside each memory compare | Rejected |
| Negated maximum with one `i16x8.min` | −2 instructions/row; P 15.92 → 16.25, E 21.50 → 21.62 | Rejected |
| CR flag from a 64-bit temperature word | 73.7 → 79.4 instructions/row; P 18.64 → 18.78 | Rejected |
| Per-lane long-name calls | P 16.22 → 15.99, E 21.72 → 21.79, +2 instructions/row | Rejected: mixed |
| Multivalue fallback returns | P 16.21 → 16.34, E 22.13 → 22.21 | Rejected |
| Newline search in the two-vector path | P 15.87 → 16.24, E 21.47 → 22.10 | Rejected |
| Offset-free digit addressing | −0.9 instructions/row, cycles within noise | Not adopted |
| Four lanes | P 15.48 → 15.47, E 21.07 → 21.79 | Rejected |
| Per-lane fallback helper | P 15.48 → 15.74, E 21.07 → 21.41 | Rejected |
| Twice-unrolled inner loop | P 15.86 → 15.88, E 21.07 → 21.37 | Rejected |
| Outlined general parser | 71.5 → 74.2 instructions/row, E 21.17 → 21.40 | Rejected |
| Main thread parses while workers boot | 0.855 s versus 0.850 s without it | Rejected |
| Explicit `process.exit()` after output | Exit lag unchanged at 5–12 ms | Rejected |
| Zero-copy input: `node:ffi` `mmap` with `MAP_FIXED` into Wasm memory | Correct; system time 1.3 → 0.5 s, but 0.90–0.92 s versus 0.81–0.83 s; one worker spent 17–27% more user cycles parsing from DRAM across 4 KiB pages | Rejected; also needs an experimental API |

Removing the record's now-unread long-name head/tail plumbing perturbed V8's
register allocation of the whole loop (+0.6 instructions/row, about 1% slower),
so the shipped kernel keeps it. Hand-placed hints first confirmed that V8 14.6
applies `metadata.code.branch_hint`; the build now derives them structurally.

### Verification

All **26 tests pass on Node 24 and Node 26**, including new checks for the
shipped branch hints and first-bucket collision retuning; Biome and C-format
checks pass. The retuning test finds two names sharing a first bucket, checks
exact aggregates and confirms every station owns the bucket and fingerprint its
retuned hash selects. Existing tests cover every temperature spelling with LF
and CRLF, every name length from 1 to 100 bytes, 10,000 stations, collisions,
reset and exact sums through the production kernel. Exact-count verification
confirms **1,000,000,000 measurements and 413 stations**; the default launcher's
output matches byte-for-byte. All 68 full-file processes in the two final
batches produced complete expected stdout, and all 36 measured runs reported
zero filesystem input.

Final report: `results/1792435279540-compare-r11-final-verification.json`.
Initial report: `results/1792434966893-compare-r11-final.json`. Checkpoint reports
use `results/*-compare-s[1-7]-*.json`; the summary is
`results/2026-10-19-round11-summary.json`. Temporary worktrees are removed.
Selected production source hash:
`2efc93726477dab9bb83e0ca8f2b2ebb257bb3f982fdfb14062dcf7d8cc61886`.

## Previous audit: learned station caches rejected, 2026-10-19

The tenth round implemented a learned short-name cache with complete key
verification and partial aggregates. The approximately 94% routing hit rate
from the earlier offline simulation did **not** translate into a speedup.
All nine measured variants regressed. The production source, binary and defaults
are identical to `4483611`; restoration checkpoint `ee83ccd` retains the
decimal-point parser. All attempt and restoration commits are unsigned.

Same Core Ultra 7 258V, Node 26.12.0, performance mode, eight workers,
512 KiB chunks and billion-row input. Each batch used 12 full-file warm-ups
and alternating case order. The first used nine rounds; the other three used
seven. Scores discard the fastest and slowest run. Each row below compares
within its own batch; separate batches must not be combined.

| Checkpoint | Attempt | Previous winner | Candidate | More elapsed time |
| --- | --- | ---: | ---: | ---: |
| `f087a84` | 16K learned records with partial aggregates | 1.011 s | 1.081 s | 6.9% |
| `06c9ab2` | Reduce partial cache to 4K records | 1.010 s | 1.129 s | 11.8% |
| `d33000f` | Cache metadata, update dense station statistics directly | 1.010 s | 1.088 s | 7.8% |
| `730b55d` | Stage three independent cache routes | 1.010 s | 1.080 s | 7.0% |
| `b57edfa` | Verify keys with scalar equality bitmasks | 1.006 s | 1.077 s | 7.1% |
| `fa6008b` | Group complete cache hits into one fast path | 1.006 s | 1.095 s | 8.9% |
| `c2678fb` | Decode three temperatures before updating statistics | 1.006 s | 1.114 s | 10.8% |
| `67b5435` | Find temperature addresses independently of cached length | 0.997 s | 1.089 s | 9.2% |
| `3509a7d` | Preload input-derived temperatures before grouped validation | 0.997 s | 1.094 s | 9.7% |

The first design routes on five raw input bytes. Each 64-byte record contains
the complete short-name key, its comparison mask, name length, owner pointer
and exact partial statistics. Hits verify the entire name and delimiter;
misses use the complete existing parser. Partial aggregates merge on eviction
and before every chunk returns, preserving the ordinary result ABI and
supporting shared entries across lanes. Long names use the general parser.

Native inspection and a pinned-core profile showed that fewer instructions
did not produce higher throughput. The initial cache profile recorded more
branch misses and lower IPC than the earlier baseline diagnostic. The cache
also puts its metadata load on the temperature-address dependency path.
The subsequent variants tested footprint, aggregation overhead, comparison
cost and execution overlap; none justified keeping the redesign.

All candidates passed the kernel correctness tests before measurement.
All **143 full-file processes** in the four valid benchmark batches produced
complete expected stdout; all **95 measured runs** reported zero filesystem
input. One interrupted pilot after a build failure used a stale binary for a
case; that entire report is marked invalid and excluded from all results.

The restored solver passes all **25 tests on Node 24 and Node 26** and
Biome/C-format checks. A retained regression test covers shared-prefix
replacements, short names with changing routing bytes, mixed short/long/NUL
names, reset and exact totals after each chunk. Exact-count verification
confirms **1,000,000,000 measurements and 413 stations**, and the default
launcher's output matches byte-for-byte. The selected import-free module
remains **7,693 bytes**, with the original memory and runtime defaults.

Reports:
`results/1792430223286-compare-r10-learned-cache.json`,
`results/1792430431647-compare-r10-cache-refinements-validated.json`,
`results/1792430567323-compare-r10-cache-hit-pipeline.json`, and
`results/1792430702353-compare-r10-independent-temperatures.json`.
Summary: `results/2026-10-19-round10-summary.json`. Initial native code and
counters are in `results/round10-partial-cache-assembly.txt` and
`results/round10-partial-cache-counters.txt`. All temporary worktrees are
removed. The selected production source hash remains
`b1b71b79679a57c282982078416336c21ab0d34460986546e02f7f7aaf5ccdf8`.

## Previous result: direct decimal-point row advancement, 2026-10-19

The ninth round determines the temperature's decimal position directly from
its first four bytes. This makes row advancement and the fractional-digit
address independent of sign normalization. The numeric lookup, hashing,
station layout, SIMD statistics and runtime defaults remain unchanged.
The selected source checkpoint is `bbdc73f`; `18f946f` adds regression coverage.
Only the fastest verified implementation is shipped. All commits are unsigned.

Same Core Ultra 7 258V, Node 26.12.0, performance mode, eight workers,
512 KiB chunks and billion-row input. After **16 full-file warm-up processes**,
nine alternating rounds with reversed case order gave:

| Solver | Trimmed mean | Best |
| --- | ---: | ---: |
| Previous winner, `342abbc` | 1.027 s | 1.020 s |
| **Direct decimal advancement, `bbdc73f`** | **1.002 s** | **0.993 s** |

**2.4% less elapsed time**, or **1.025× throughput**, in the matched comparison.
Scores discard the fastest and slowest run and average the remaining seven.
This is a cached **13.77 logical GB/s** result including startup, compilation,
reads, parsing, aggregation, merging, sorting, output and shutdown.
Selected peak RSS: 157,208 KiB. The import-free Wasm module is **7,693 bytes**,
down from 7,729 bytes.

An initial nine-round comparison after 12 warm-ups measured 1.037 s for the
previous winner and 1.006 s for the candidate. The candidate was faster in
every paired round across both batches. Separate batches must not be combined.

The trial followed diagnostics showing approximately 81% of instrumented
worker read/parse time inside the parser, with little DRAM stalling in a
separate pinned-core profile (`results/assessment-summary.json`). The change
targets a dependency rather than relying on the count of branches or loads.
For valid temperatures, the decimal is at byte 1, 2 or 3. Digits have ASCII
bit 4 set; the decimal does not. Masking out byte 0 excludes the optional minus
sign, so `ctz((~word) & 0x10101000) >> 3` gives the decimal offset. Adding three
gives the row width, plus one for CRLF. Native inspection confirms `tzcnt`
determines that offset before the sign-dependent digit shift.

All **24 tests pass on Node 24 and Node 26**, and Biome/C-format checks pass.
The new production-parser test checks all **4,400 temperature/newline
combinations**: both signs, one/two integer digits, every digit combination,
leading zeros and negative zero, with LF/CRLF and an absent final newline.
Repeated short keys exercise the parsing lanes, multiple chunk sizes and
worker counts. Existing collision, arbitrary-name and exact-sum tests pass.

All **64 full-file benchmark processes** produced complete expected stdout.
All **36 measured runs** reported zero filesystem input. Exact-count
verification confirms **1,000,000,000 measurements and 413 stations**;
the default launcher's output matches byte-for-byte.

Final report: `results/1792429482910-compare-r9-final-verification.json`.
Initial report: `results/1792429427443-compare-r9-decimal-advance.json`.
Summary: `results/2026-10-19-round9-summary.json`; inspected native code is in
`results/round9-decimal-assembly.txt`. The temporary baseline worktree is
removed. Selected production source hash:
`b1b71b79679a57c282982078416336c21ab0d34460986546e02f7f7aaf5ccdf8`.

## Previous audit: delimiter checks and SIMD masks, 2026-10-19

The eighth round tested a combined delimiter-presence check and generated
short-name masks. Neither improved the complete program. The production source,
binary and defaults are identical to `6ed6938`; restoration checkpoint `6a614e2`
retains SIMD hash mixing, three parsing lanes and 512 KiB chunks.
All attempt and restoration commits are unsigned.

Same Core Ultra 7 258V, Node 26.12.0, performance mode, eight workers and
billion-row input. The first batch used 12 warm-ups and seven alternating rounds;
the repeat used 16 warm-ups, nine rounds and reversed case order. Each score is
a trimmed mean, discarding the fastest and slowest run. Separate batches must
not be combined.

| Checkpoint | Attempt | First comparison | Repeat comparison | Decision |
| --- | --- | ---: | ---: | --- |
| `6ed6938` | Previous winner | **1.030 s** | **1.028 s** | Retained |
| `cf4823e` | Combine three bounded delimiter checks | 1.068 s | 1.062 s | Rejected |
| `2a2ef3d` | Generate short-name masks in SIMD | 1.078 s | — | Rejected |
| `3805465` | Combine both changes | 1.104 s | — | Rejected |
| `3a51989` | Refine masks to one signed SIMD comparison | — | 1.065 s | Rejected |

The delimiter check uses the 16-bit bitmask bounds: subtracting one sets bit 31
only for a zero mask, allowing one OR reduction and a single branch for the
three lanes. Native inspection confirms the branch reduction, but the repeat
still takes **3.4% more elapsed time** than its matched baseline.

Mask generation compares byte positions against the name length, replacing
the indexed mask-table load on the hot short-name path. Clang initially selects
an unsigned comparison that takes several native vector operations. Shifting
the positions negative preserves a signed comparison and produces one native
`vpcmpgtb`. The refinement still takes **3.7% more elapsed time** than its
matched baseline. These trials do not justify changing the selected parser.

All four candidates passed the kernel correctness tests before benchmarking.
Across the two batches, all **83 full-file benchmark processes** produced
complete expected stdout. All **55 measured runs** reported zero filesystem
input. After restoration, all **23 tests pass on Node 24 and Node 26**, and
Biome/C-format checks pass. Exact-count verification confirms
**1,000,000,000 measurements and 413 stations**; the default launcher's stdout
matches byte-for-byte. The selected import-free Wasm module remains
**7,729 bytes**. The seventh-round headline below remains unchanged.

Reports: `results/1792428645684-compare-r8-delimiters-and-masks.json` and
`results/1792428734864-compare-r8-signed-mask-confirmation.json`.
Summary: `results/2026-10-19-round8-summary.json`. Inspected native code is in
`results/round8-combined-assembly.txt` and
`results/round8-signed-mask-assembly.txt`. Temporary experiment worktrees are
removed; all four attempts remain in their checkpoint commits. The selected
production source hash is unchanged:
`44bd983a2ad21923217190e6abc809155afc5cec52c6ba7421da2897219e4622`.

## Previous result: SIMD hash mixing, 2026-10-19

The seventh round keeps the canonical short-name key in SIMD for the hash's
two XOR operations, then extracts both mixed words for multiplication.
The original key remains available for comparison; its low word is extracted
only on a lookup miss. The hash and valid-input behavior are unchanged.
Inspection confirms one native vector XOR replaces the two scalar XORs.
The optimized `parse_chunk` body shrinks from 11,328 to 11,228 native bytes;
the import-free Wasm module shrinks from 7,741 to **7,729 bytes**.

Same Core Ultra 7 258V, Node 26.12.0, performance mode, eight workers,
512 KiB chunks and billion-row input. Source checkpoint `9eee974` selects
the SIMD hash change with the original 40-byte station layout.
All attempt and selection commits are unsigned. Only the selected solver
is shipped; discarded alternatives remain in git history.

After **16 full-file warm-up processes**, nine alternating rounds gave:

| Solver | Trimmed mean | Best |
| --- | ---: | ---: |
| Previous winner, `8a269ca` | 1.054 s | 1.035 s |
| **SIMD hash mixing, `9eee974`** | **1.027 s** | **1.003 s** |

**2.6% less elapsed time**, or **1.027× throughput**, in the matched comparison.
Scores discard the fastest and slowest run and average the remaining seven.
This is a cached **13.44 logical GB/s** result including startup, compilation,
reads, parsing, aggregation, merging, sorting, output and shutdown.
Selected peak RSS: 156,680 KiB. Separate batches below must not be combined.

### Seventh-round attempt checkpoints

The first comparison used 12 warm-ups and seven alternating rounds. A second
used 16 warm-ups, nine rounds and reversed case order. Each score is a trimmed
mean within its batch.

| Checkpoint | Attempt | First comparison | Second comparison | Decision |
| --- | --- | ---: | ---: | --- |
| `8a269ca` | Previous winner | 1.056 s | 1.047 s | Baseline |
| `19c2645` | SIMD short-name hash mixing | **1.034 s** | **1.027 s** | Selected |
| `80c5511` | Place the cached key beside statistics in each 40-byte record | 1.052 s | — | Rejected: no clear gain |
| `af7f5c3` | Combine hash mixing and adjacent keys | 1.035 s | 1.029 s | Rejected: no improvement over hash mixing alone |

The field reorder moved the cached key from offset 24 to 16 and inspection
metadata to the end, retaining the same dense records and pointer table.
It did not add a clear improvement; the final selection restores the original
layout, host decoding and collision-test offsets. Defaults remain unchanged.

Across all three batches, **117 full-file benchmark processes** produced
complete expected stdout. All **73 measured runs** reported zero filesystem
input. All **23 tests pass on Node 24 and Node 26**, and Biome/C-format checks
pass. Exact-count verification confirms **1,000,000,000 measurements and
413 stations**; the default launcher's stdout also matches byte-for-byte.
Coverage includes forced hash collisions, trailing NUL bytes, all name lengths,
10,000 stations, temperature bounds and exact sums/counts.

Final report: `results/1792428389395-compare-r7-final-verification.json`.
The initial and confirmation reports are
`results/1792428252033-compare-r7-hash-and-layout.json` and
`results/1792428314477-compare-r7-hash-confirmation.json`.
The summary is `results/2026-10-19-round7-summary.json`; final native code
is in `results/round7-final-assembly.txt`. Temporary experiment worktrees
are removed. The selected production source hash is
`44bd983a2ad21923217190e6abc809155afc5cec52c6ba7421da2897219e4622`.

## Previous audit: previous winner retained, 2026-10-19

The sixth round tested independent long-name fallback, overlapped bucket/key
loads and chunk-size defaults. None produced a repeatable improvement.
The production code and defaults are identical to `93e3372`; restoration
checkpoint `0678e2f` retains the SIMD-key parser and **512 KiB** chunks.
All attempt and restoration commits are unsigned.

Same Core Ultra 7 258V, Node 26.12.0, performance mode, eight workers and
billion-row input. Within each row below, scores are matched five-run trimmed
means. Separate batches must not be combined.

| Checkpoint | Attempt | Previous winner | Candidate | Decision |
| --- | --- | ---: | ---: | --- |
| `d192e4e` | Per-lane long-name fallback | 1.026 s | 1.072 s | Rejected |
| `14d3ab9` | Stage bucket-pointer loads before updates | 1.026 s | 1.039 s | Rejected |
| `6ceef78` | Also preload the cached SIMD keys | 1.034 s | 1.043 s | Rejected |
| `19931bb` | Specialize short lanes only inside mixed triples | 1.034 s | 1.048 s | Rejected |

The chunk sweep used the same winning parser, with only the default changed:

| Checkpoint | Chunk size | Matched trimmed mean |
| --- | --- | ---: |
| `1e6456b` | 128 KiB | 1.073 s |
| `d9a0525` | 256 KiB | 1.053 s |
| `93e3372` | **512 KiB** | **1.043 s** |
| `5b5b018` | 1 MiB | 1.056 s |
| `3d1f8d5` | 2 MiB | 1.090 s |

A seven-round follow-up was inconclusive: 1.050 s for 512 KiB versus 1.049 s
for 256 KiB. A second seven-round check used the **same script path** for both,
explicit chunk settings and reversed case order, after 16 full-file warm-ups:

| Configuration | Trimmed mean | Best |
| --- | ---: | ---: |
| **512 KiB retained** | **1.038 s** | **1.029 s** |
| 256 KiB challenger | 1.054 s | 1.047 s |

The controlled check favors 512 KiB by 1.5%; the earlier 1 ms reversal was not
repeatable. This audit retains the existing implementation and settings.
The headline fifth-round result below still describes the selected program.

Across this audit, all **139 full-file benchmark processes** produced complete
expected stdout. All **83 measured runs** reported zero filesystem input.
All **23 tests pass on Node 24 and Node 26**, and Biome/C-format checks pass.
Exact-count verification confirms **1,000,000,000 measurements and 413 stations**;
the default launcher's stdout matches byte-for-byte. The selected import-free
SIMD module remains **7,741 bytes**. Its production source hash exactly matches
the fifth round's selected winner.

Final controlled report: `results/1792427697647-compare-r6-chunk-confirmation.json`.
The earlier seven-round report is
`results/1792427615807-compare-r6-final-verification.json`. Other attempt reports
use `results/*-compare-r6-*.json`; the summary is
`results/2026-10-19-round6-summary.json`. Temporary experiment worktrees are
removed; all eight attempts remain in their checkpoint commits.

## Previous result: delimiter-encoded SIMD keys, 2026-10-19

The fifth round removes repeated short-name loads, masks and scalar comparisons.
Same Core Ultra 7 258V, Node 26.12.0, performance mode, eight workers, 512 KiB
chunks and billion-row input. The selected source checkpoint is `bbf5de2`.
Only the fastest measured implementation is shipped. All commits are unsigned.

After **16 full-file warm-up processes**, seven alternating rounds gave:

| Solver | Trimmed mean | Best |
| --- | ---: | ---: |
| Previous winner, `ea198f0` | 1.217 s | 1.197 s |
| Delimiter-encoded SIMD keys, `d02123f` | 1.056 s | 1.046 s |
| **SIMD keys with shared empty record, `bbf5de2`** | **1.047 s** | **1.028 s** |

**14.0% less elapsed time**, or **1.163× throughput**, against the previous
winner in the same batch. Scores discard the fastest and slowest run and
average the remaining five. All **37 full-file processes** produced complete
expected stdout. All **21 measured runs** reported zero filesystem input:
this is a cached **13.18 logical GB/s** result including startup, compilation,
reads, parsing, aggregation, merging, sorting, output and shutdown.
Peak RSS: 156,596 KiB.

The short-name path retains each first-block vector from the delimiter scan,
masks it once and reuses it for hashing and full-key comparison. Short records
store the name, its delimiter and zero padding as a canonical 16-byte key.
The delimiter encodes length, including trailing NUL bytes, removing the
separate length comparison from the hot lookup. Hashing includes the delimiter
for all names and extracts short-name words from the same vector.

Empty buckets point to a shared zero record. A valid canonical short key always
contains the delimiter, so it cannot equal an empty record. The same vector
comparison handles the common match and routes misses to the complete insertion
and probe path, without a separate empty-bucket branch. The general parser
continues to support arbitrary valid names up to 100 UTF-8 bytes. Full name
verification, exact sums, the 40-byte record layout, input handling and runtime
settings are preserved. No station dictionary or precomputed answers are used.

### Fifth-round attempt checkpoints

Matched five-round trimmed means within each row; separate batches must not
be combined. Final selection uses the seven-round comparison above.

| Commit | Attempt and matched result | Decision |
| --- | --- | --- |
| `3039a16` | Reuse SIMD name bytes: 1.213 → 1.072 s | Retained and refined |
| `d02123f` | Encode the delimiter in the SIMD key: 1.044 s versus 1.072 s vector reuse alone | Retained |
| `583395f` | Direct 32-byte hash slots with separate metadata: 1.067 s versus 1.046 s pointer table | Rejected |
| `612f268` | Two SIMD-key lanes: 1.144 s versus 1.056 s three lanes | Rejected |
| `3d43317` | Four SIMD-key lanes: 1.094 s versus 1.056 s three lanes | Rejected |
| `ef9afe7` | Complemented maxima for one SIMD min: 1.054 s versus 1.049 s ordinary extrema | Rejected |
| `bbf5de2` | Shared empty record: 1.045 s versus 1.049 s ordinary empty checks; confirmed 1.047 versus 1.056 s in final seven rounds | Selected |

All **23 tests pass on Node 24 and Node 26**. New production-kernel collision
fault injection checks short names differing only by trailing NUL bytes, the
15/16-byte boundary, and collisions with long records. Twelve equal rows drive
the short path in every lane. Existing tests cover all legal temperatures,
every name length, 10,000 stations, complete long-name comparison, exact sums,
chunk boundaries, reset and memory growth. Biome and C-format checks pass.
Exact-count verification confirms **1,000,000,000 measurements and 413 stations**
and complete expected stdout. The default launcher matches it byte-for-byte.
The selected import-free SIMD module is **7,741 bytes**.

Raw final report: `results/1792426803442-compare-r5-final-verification.json`.
Its baseline source hash matches the fourth round's final winner exactly.
Per-attempt reports use `results/*-compare-r5-*.json`; the summary is
`results/2026-10-19-round5-summary.json`. Native inspection and WAT are saved in
`results/round5-final-assembly.txt` and `results/round5-final.wat`. Temporary
experiment worktrees are removed; all attempts remain in their checkpoint commits.

## Previous round: short-name path and lookup scheduling, 2026-10-19

The fourth round separates short-name scanning from the general parser and
changes when lookup results are consumed. Same Core Ultra 7 258V, Node 26.12.0,
performance mode, eight workers, 512 KiB chunks and billion-row input.
The selected source checkpoint is `f7121b7`; `6ca6210` adds regression coverage.
Only the fastest measured implementation is shipped. All commits are unsigned.

After **16 full-file warm-up processes**, seven alternating rounds gave:

| Solver | Trimmed mean | Best |
| --- | ---: | ---: |
| Previous winner, `a74fc22` | 1.266 s | 1.254 s |
| Short-name path, staged lookups, `fb737ce` | 1.236 s | 1.211 s |
| Short-name path, immediate updates, `c65e8c0` | 1.240 s | 1.218 s |
| **Immediate updates with staged fallback, `f7121b7`** | **1.231 s** | **1.216 s** |

**2.7% less elapsed time**, or **1.028× throughput**, against the previous winner
in the same batch. Scores discard the fastest and slowest run and average the
remaining five. All **44 full-file processes** produced complete expected stdout.
All **28 measured runs** reported zero filesystem input: this is a cached
**11.20 logical GB/s** result including startup, compilation, reads, parsing,
aggregation, merging, sorting, output and shutdown. Peak RSS: 156,720 KiB.

Each iteration scans all three first blocks. If every delimiter is present,
names are 1–15 bytes long; a compact path hashes them together, then resolves
and updates each row immediately. If any delimiter needs another block,
a C-outlined helper uses the fully staged general parser, supporting arbitrary
valid names up to 100 bytes. Keys are completely verified and shared-station
updates remain ordered. The hash, exact sums, 40-byte record ABI, input handling
and runtime settings are unchanged. No input dictionary is embedded.

The inspected Node 26 optimized `parse_chunk` body shrank from 10,624 to
8,960 bytes. It still uses stack slots, including around the fallback call.
The Wasm module grew from 5,798 to 7,328 bytes because general parsing also
exists in its separate helper.

### Fourth-round attempt checkpoints

Results within each row are matched five-round trimmed means unless marked
as the final seven-round comparison. Separate batches must not be combined.

| Commit | Attempt and matched result | Decision |
| --- | --- | --- |
| `e261689` | Consume each lookup immediately after scanning: 1.253 → 1.244 s | Refined in the short-name path |
| `7d44ddb` | Revisit four compact lanes: 1.308 s versus 1.253 s previous winner | Rejected |
| `fb737ce` | Three-row short-name path: 1.253 → 1.222 s | Retained |
| `c65e8c0` | Add immediate updates: 1.215 s versus 1.222 s staged lookups | Refined below; isolated advantage varied |
| `a4ea36e` | SIMD cached head/tail comparison: 1.238 s versus 1.222 s scalar checks | Rejected |
| `f7121b7` | Fully stage the general fallback: 1.231 s versus 1.240 s immediate updates alone, final seven rounds | Selected |

All **22 tests pass on Node 24 and Node 26**. The new differential test covers
every name length from 1 to 100 bytes, short/long transitions, repeated keys,
UTF-8, CRLF, missing final newline, chunk sizes and worker counts. Existing
coverage includes every legal temperature, 10,000 stations, whole-key collision
fault injection and the billion-row sum bound. Biome and C-format checks pass.
Exact-count verification confirms **1,000,000,000 measurements and 413 stations**
and complete expected stdout. The default launcher matches it byte-for-byte.
The selected import-free SIMD module is **7,328 bytes**.

Raw final report: `results/1792425763901-compare-r4-final-verification.json`.
The baseline source hash exactly matches the third round's final winner.
Per-attempt reports use `results/*-compare-r4-*.json`; the summary is
`results/2026-10-19-round4-summary.json`. Native inspection is saved in
`results/round4-final-assembly.txt`. Temporary experiment worktrees are removed;
all attempts remain available through their checkpoint commits.

## Previous round: bounded parser and paired hashing, 2026-10-19

The third round uses the challenge's 100-byte name bound to reduce carried
parser state and bound full-name verification. It also uses a cheaper hash
and a direct first-bucket lookup. Same Core Ultra 7 258V, Node 26.12.0,
performance mode, eight workers, 512 KiB chunks and billion-row file.
The final source checkpoint is `3d83125`; only the fastest implementation is
shipped. Every checkpoint in this round is unsigned.

After **16 full-file warm-up processes**, seven alternating rounds gave:

| Solver | Trimmed mean | Best |
| --- | ---: | ---: |
| Previous winner, `7947d0d` | 1.347 s | 1.336 s |
| **Selected bounded parser** | **1.257 s** | **1.246 s** |

**6.7% less elapsed time**, or **1.072× throughput**, in the same batch.
Each score drops the fastest and slowest run and averages the remaining five.
All 30 full-file processes produced complete expected stdout. All 14 measured
runs reported zero filesystem input: this is a cached **10.98 logical GB/s**
result including startup, compilation, reads, parsing, aggregation, merging,
sorting, output and shutdown. Peak RSS: 156,932 KiB.

The name length fits in seven bits beside its full 32-bit pointer. Carrying
that descriptor and the hash, then loading the head word during lookup,
reduces the state live between phases. Names over 16 bytes use bounded SIMD
middle comparisons and a final overlapping vector, covering every byte
without reading beyond the name. The new hash mixes each masked word pair
with one multiplication. Lookup checks the first bucket directly, with the
remaining collision probe loop outlined in C. Normal V8 settings stay enabled.
Exact signed 64-bit sums, the 40-byte record ABI and input handling are preserved.
No dictionary or data-set-specific station names are embedded.

### Third-round attempt checkpoints

Matched five-round trimmed means within each row; separate batches must not
be combined. Attempts remain in git history, with only the winner in the tree.

| Commit | Attempt and matched result | Decision |
| --- | --- | --- |
| `f4fd49a` | Outline long-name middle check: 1.337 → 1.334 s | No clear isolated gain; refined below |
| `791a8b5` | Bound middle vectors to 100 bytes: 1.362 → 1.340 s | Retained in combination |
| `3264521` | Pack name pointer/length alone: 1.412 s versus 1.362 s baseline | Rejected alone |
| `4d73de5` | Packed descriptor plus deferred head load: 1.321 s versus 1.362 s baseline | Retained |
| `414fb5a` | Add bounded name verification: 1.316 s versus 1.333 s compact state alone | Retained |
| `e67f649` | Outline collision probing: 1.301 s versus 1.316 s previous combination | Retained |
| `f7a635c` | One multiplication per word pair: 1.292 s versus 1.316 s previous combination | Retained |
| `09b8062` | Paired hashing plus outlined probing: 1.258 s versus 1.276 s paired hashing alone | Selected |
| `0bae486` | Exploit 10K bound for 16-bit bucket references: 1.328 s versus 1.258 s 32-bit pointers | Rejected |
| `3d83125` | Restore only the selected combination | Final source checkpoint |

Disabling Wasm inlining failed to improve the baseline: 1.375 s versus 1.362 s
with normal settings in the same batch. Outlined checks with inlining disabled
measured 1.395 s. These flags are not shipped.
The smaller table saved space, but decoding its scaled offsets cost more time
on this input. The 10K-station limit was already used for fixed-size allocation.

All **21 tests pass on Node 24 and Node 26**. The added differential test checks
10,000 short UTF-8/NUL names, exact aggregates, three lanes, multiple chunk
sizes and worker counts. Existing tests cover all legal temperatures, 100-byte
names, long-name collision fault injection and the billion-row sum bound.
Biome and C-format checks pass. Full-file verification confirms exactly
**1,000,000,000 measurements and 413 stations**, with complete expected output.
The default launcher matches it byte-for-byte. The import-free SIMD kernel is
**5,798 bytes**, down from 6,267 bytes.

Raw final report: `results/1792425110465-compare-r3-final-verification.json`.
Its baseline source hash matches the second round's final winner exactly.
Per-attempt reports use `results/*-compare-r3-*.json`; the summary is
`results/2026-10-19-round3-summary.json`. Temporary experiment worktrees are
removed after verification; checkpoints can recreate them.

## Previous round: three-stage pipeline, 2026-10-19

A second optimization round retained direct bucket indexing, staged processing,
and fixed-lane SIMD shuffles. Same Core Ultra 7 258V, Node 26.12.0, performance
profile, eight workers, 512 KiB chunks, billion-row file and complete output checks.
The final source checkpoint is `df1abe9`; only this implementation is shipped.

After **16 full-file warm-up processes**, seven alternating rounds gave:

| Solver | Trimmed mean | Best |
| --- | ---: | ---: |
| Previous winner, `e535c54` | 1.446 s | 1.419 s |
| **Selected three-stage parser** | **1.344 s** | **1.338 s** |

**7.1% less elapsed time**, or **1.076× throughput**,
versus the previous winner in the same batch. Each score drops the fastest and
slowest run and averages the remaining five. All 30 full-file processes were
correct; all 14 measured runs reported zero filesystem input. This is a cached
**10.27 logical GB/s** result including startup, compilation, I/O,
parsing, merging, sorting, output and shutdown. Peak RSS: 157,292 KiB.

The rolling hash is unchanged, but its high 15 bits now select the bucket
without two fingerprint folds. The inspection fingerprint is computed only on
cold insertion. Each three-row iteration scans all names, resolves all station
records, then applies temperature/statistics updates in order. Fixed shuffles
merge the SIMD fields using two immediate blends rather than six bitwise mask
operations in the inspected generated code. Full name verification, exact
64-bit sums, record ABI and input handling are preserved.

### Second-round attempt checkpoints

All attempts were committed unsigned before measuring. Results within a row
are matched five-round trimmed means; separate batches must not be combined.

| Commit | Attempt and matched result | Decision |
| --- | --- | --- |
| `bcbf7c3` | Direct high-bit bucket index: 1.442 → 1.414 s | Retained |
| `edfbcd4` | Lookups before temperature/statistics: 1.416 → 1.389 s | Retained, then further staged |
| `dce10cc` | SIMD shuffles instead of masked merges: 1.372 → 1.355 s | Retained |
| `f278519` | Separate scan / lookup / update phases: 1.348 s versus 1.365 s for two-stage processing | Retained |
| `09b509d` | Two staged lanes: 1.465 s | Rejected |
| `f47224f` | Four staged lanes: 1.355 s versus 1.348 s for three fully staged lanes | Rejected |
| `df9d9f2` | Hoisted SIMD constants: 1.342816 s versus 1.342936 s inline | No measurable gain; rejected |
| `df1abe9` | Selected three-stage implementation with no runtime variants | Final source checkpoint |

All **20 production tests pass on Node 24 and Node 26**. Biome and C-format
checks pass. Exact-count verification confirms **1,000,000,000 measurements and
413 stations** and complete expected stdout; the default launcher is checked
separately. The import-free kernel is **6,267 bytes**. The table mapping change
is also covered by the production-kernel collision fault-injection tests.

Raw final report: `results/1792423660307-compare-r2-final-verification.json`.
The baseline source hash exactly matches the previous round's final report.
Per-attempt reports use `results/*-compare-r2-*.json`; the summary is
`results/2026-10-19-round2-summary.json`. Generated code inspection is saved in
`results/round2-final-assembly.txt`. Recreate comparison worktrees from the
checkpoint commits; temporary experiment checkouts are removed after verification.

## Previous round: branchless solver, 2026-10-19

The current tree ships only the selected Wasm solver. `./run.sh` uses it by
default; the JavaScript solver and rejected alternatives remain in git history.
Core Ultra 7 258V, Node 26.12.0, all eight cores, `performance` profile/governor/EPP,
same billion independent rows and 13,795,455,110-byte file.

Final verification used **16 full-file warm-ups and seven alternating rounds**.
Every process validates complete stdout. Scores discard the fastest and slowest
run, averaging the remaining five. Both programs ran in the same benchmark batch.

| Solver | Trimmed mean | Best |
| --- | ---: | ---: |
| Original Wasm, `5fb6e47`, four lanes / 128 KiB | 1.997 s | 1.973 s |
| **Final solver, three lanes / 512 KiB** | **1.447 s** | **1.442 s** |

**27.5% less elapsed time; 1.38× throughput**
(9.53 logical GB/s). Every one of the 30 full-file processes was correct,
and all 14 measured processes reported zero filesystem input. Final Wasm peak
RSS was 156,996 KiB. This is a cached-input result with startup,
compilation, I/O, aggregation, merge, output and shutdown included.

The largest gains came from comparing masked head/tail words unconditionally
and masking both final hash words before selecting the result. This removes
name-length branches while preserving the hash and complete name verification.
SIMD updates exact 64-bit sums, counts and 16-bit extrema together. Three parsing
lanes won the later comparisons, with a smaller **6,244-byte** module. Automatic
worker count stays enabled; the selected default chunk size is **512 KiB**.

### Attempt checkpoints

All attempts were committed before comparison. Slower attempts were reverted
or replaced by the winning checkpoint; no runtime strategy registry remains.
Numbers below are matched within each row, and must not be combined across rows.
Except the lane screening, these used five rounds with fastest/slowest discarded.

| Checkpoint | Attempt and matched result | Decision |
| --- | --- | --- |
| `a13abb2` | SIMD statistics: 1.995 → 1.976 s | Retained; rechecked later |
| `52a9807` | Full-name verification without redundant hash equality: 1.958 → 1.902 s | Retained |
| `d623826` | Direct cache-line records: 1.907 → 1.967 s | Rejected |
| `463ef0a` | Branchless name matching: 1.906 → 1.563 s | Retained |
| `2e73454` | Branchless final hash words: 1.571 → 1.462 s | Retained |
| `c7fc418` | Packed arithmetic temperatures: 1.450 → 1.506 s | Rejected |
| `9ced9b2` | Two lanes: 1.543 s, three-run screening mean | Rejected |
| `87ecf7f`, `03e39f8` | Three / four / six lanes: 1.457 / 1.470 / 1.475 s | Three selected |
| `d339097` | Six lanes, SIMD / scalar statistics: 1.475 / 1.505 s | SIMD retained |
| `2420c4c` | Remove slower backend; select three lanes and 512 KiB default | Retained |
| `b252f1f` | Single-load temperature parser: 1.449 → 1.482 s | Rejected |

Eager optimizing compilation (`--no-liftoff`) showed no useful gain: 1.472 s
versus 1.475 s with ordinary tiering. No extra V8 flags are required.

Scheduling checks, five rounds each:

| Setting, three lanes | Trimmed mean |
| --- | ---: |
| 64 / 128 / 256 / 512 KiB, first batch | 1.486 / 1.466 / 1.452 / 1.447 s |
| Six / seven / eight workers, 128 KiB | 1.665 / 1.563 / 1.466 s |
| 512 KiB / 1 MiB / 2 MiB / 4 MiB, follow-up | 1.449 / 1.461 / 1.494 / 1.554 s |

Final validation: all **20 tests pass on Node 24 and Node 26**, including every
legal temperature, official fixtures, 10,000 keys, whole-key collision injection,
chunk boundaries and exact sums. Biome and C formatting checks pass. Exact-count
verification confirms **1,000,000,000 rows and 413 stations** against full expected
output. The default shell launcher's stdout also matches the expected file exactly.

Raw final comparison: `results/1792422301889-compare-final-original-vs-winner.json`.
Baseline source hash matches the saved pre-optimization
report exactly. Detailed per-attempt timing, CPU usage, RSS and source hashes
are in the corresponding local `results/*-compare-*.json` files; the final summary
is `results/2026-10-19-optimization-summary.json`.

For reproduction, create worktrees from the attempt commits and pass their
absolute `calculate.mjs` paths to `CASES`, with `ENGINE=wasm` for historical trees.
The benchmark driver hashes dependencies from each script's own worktree.

## Historical method and measurements

- Core Ultra 7 258V, 4 P + 4 E cores, 30 GiB RAM, Linux, Node 26.12.0.
- Unless noted otherwise, OS `powersave` / `balance_power` preference unchanged;
  desktop apps remain running.
- Input: **1,000,000,000 rows**, **13,795,455,110 bytes**, 413 stations.
- Custom seeded Node generator, upstream station names/Gaussian distributions,
  clamped to ±99.9. Independent generated rows, not repeated data blocks.
- Every measurement starts a fresh process and checks full stdout. Startup,
  compilation, I/O, computation, result decoding, sorting and shutdown count.
- Five-run scores discard fastest/slowest. Comparisons alternate execution
  order and may use explicitly logged full-file hardware warm-up processes.
- Raw timing, usage and hash reports remain locally under `results/`.

Burst/sustained clocks are a major confounder. The identical JS program has
measured around 3 s initially and 5.8–6 s under sustained load. Do not compare
unrelated batches as if power state were fixed. Historical optimization batches
used no system power changes or system-wide cache drops. The user-selected
performance-mode rerun is recorded separately below.

## Recorded milestones

| Measurement | Result |
| --- | ---: |
| First optimized JS, five-run trimmed mean | 4.969 s |
| Phased JS, later ordinary five-run batch | 3.930 s |
| Matched first/second JS tuning round | 6.116 → 5.467 s |
| Initial Wasm SIMD, ordinary five-run batch | 2.034 s; best 2.009 s |
| Exact-count Wasm verification, including startup | 2.04 s, 159,444 KiB peak RSS |

The ordinary Wasm run data were 2.009, 2.017, 2.027, 2.058, 2.254 s. This is a
warm-cache, largely burst-clock score, not a sustained-state comparison.

After 16 JS warm-ups, a separate matched five-round comparison measured:

| Backend | Trimmed mean |
| --- | ---: |
| Optimized JS | 5.670 s |
| Scalar 64-bit Wasm control | 3.734 s |
| Initial Wasm SIMD | 3.773 s |

Wasm was about 1.5× faster than JS. Scalar and SIMD Wasm were nearly tied on
the weather dataset's short names: most of the gain cannot be credited to SIMD
alone. Scalar/control implementations are now historical, not runtime options.

## Earlier compact-record change

The winning combination is **40-byte records plus outlined cold insertion**,
compiled at `-O3`. Same billion-row input, 16 warm-up processes, five alternating
rounds and complete output checks:

| Kernel | Trimmed mean |
| --- | ---: |
| Previous 48-byte Wasm | 3.998 s |
| Cold insertion, `-O3` | 3.898 s |
| **40-byte records + cold insertion, `-O3`** | **3.842 s** |
| Cold insertion, `-O2` | 3.917 s |
| Cold insertion, `-Os` | 4.004 s |

About **4% lower elapsed time**, with a corresponding CPU-time reduction.
The initial small-core tests alone weren't used as proof of a speedup.

## Verification after removing the variant framework

A second worktree at `ff83918` supplied both the original Wasm backend and
the experimental winner. The main worktree contained the simplified single
kernel. After 16 warm-ups and five alternating rounds on all billion rows:

| Source | Trimmed mean |
| --- | ---: |
| Previous Wasm, checkpoint | 4.049 s |
| Experimental compact/cold winner, checkpoint | 3.840 s |
| **Clean single kernel** | **3.874 s** |

The cleanup preserved the gain: about **4.3% faster** than the previous Wasm
backend, with no convincing difference versus the experimental winner.
A pinned-core check also found no JS-reference regression: 1.640 s checkpoint
vs 1.624 s clean for 100M rows (three-run means).

The cleaned CLI's ordinary five-run cached-input timings were 2.004, 1.937,
1.942, 2.168, 2.265 s: **2.038 s trimmed mean, best 1.937 s**. Burst-clock
variation makes this batch unsuitable for computing the incremental speedup;
use the matched comparison above instead.

Exact-count verification returned **1,000,000,000 measurements and 413 stations**,
matching the complete expected output, in 1.949 s (1.98 s including Node startup,
**156,552 KiB peak RSS**, about 153 MiB). All **20 production tests** pass on
Node 24/26, and Biome and C-format checks pass. The Wasm binary at that checkpoint was only
**7,868 bytes**, with no imports.

## Performance-mode rerun, 2026-10-19

The user selected performance mode. Read-only sysfs checks confirmed
`performance` for the ACPI platform profile, all eight CPU governors and all
eight energy-performance preferences. Same billion-row file, Node 26.12.0,
eight workers and 128 KiB chunks; no implementation changes. The Wasm source
hash matches both historical baselines exactly.

An initial full-file Wasm pass populated the file cache (4.803 s, excluded from
scores). The ordinary batch then used five fresh processes. The sustained
comparison used 16 full-file JavaScript warm-ups followed by five alternating
rounds of JavaScript and Wasm. Every score discards its fastest and slowest run.

| Measurement | Historical powersave / balance_power | Performance | Less elapsed time |
| --- | ---: | ---: | ---: |
| Wasm, ordinary cached batch | 2.038 s | 1.933 s | 5.2% |
| Wasm, sustained comparison | 3.874 s | 2.017 s | 47.9% |
| JavaScript, sustained comparison | 5.670 s | 3.014 s | 46.9% |

Ordinary Wasm runs: 1.901, 1.928, 1.902, 2.005, 1.968 s.
Sustained Wasm runs: 2.186, 2.043, 2.004, 1.989, 2.004 s.
Sustained JavaScript runs: 3.022, 3.027, 3.002, 3.017, 2.998 s.
All 32 full-file processes, including warm-ups, matched complete expected stdout.
All ten measured sustained runs reported zero filesystem input, confirming
cached input. Wasm peaked at 155,068 KiB RSS in the sustained batch.

The results are consistent with performance mode maintaining much more of the
initial burst performance under sustained load. These are historical comparisons,
not a same-session alternating power-profile experiment; other machine-state
differences cannot be isolated. The Wasm comparison uses identical source;
the JavaScript baseline predates the documented framework cleanup.

Local raw reports: `results/1792420870152-bench.json` and
`results/1792420876035-compare-performance-sustained.json`. The environment
snapshot and baseline references are in
`results/2026-10-19-performance-environment.json` and
`results/2026-10-19-performance-summary.json`.

## Rejected experiments

| Experiment | Finding |
| --- | --- |
| JS station-prefix cache | Added complexity without a repeatable speedup |
| Ordinary additional JS cursors | No useful gain without changing dependency/inlining structure |
| JS fused records / small-batch reduction / alternate hashes | No repeatable full-file improvement |
| Mixed P/E JS kernels | Apparent gain disappeared after warm-up: 5.845 s vs 5.845 s |
| JS metadata SoA / packed stats / masked indexes | No convincing benefit over the retained JS reference |
| Extra workers and affinity | No default-worthy improvement |
| Async/double-buffered reads | Extra overhead; slower in warm and cold experiments |
| Larger contiguous work regions, private FDs | Small cold-file gain only; not retained |
| Wasm adaptive 1K/2K/4K bucket tables | Extra probing outweighed cache locality; about 8–30% slower in screening |
| Wasm contiguous 32-byte separator masks and 16/32/64-row batches | More token/reduction work; substantially slower than independent lanes |
| Wasm compact records alone | Roughly tied on one core; useful in the final combined kernel |
| Wasm `-O2` / `-Os` | Didn't beat the selected `-O3` kernel |
| Smaller temperature tables / direct arithmetic / alternative hash constants | No repeatable improvement |

Cold-file preparation in historical tests used per-file `POSIX_FADV_DONTNEED`,
not a system-wide cache drop. On the compressed Btrfs mount this caused about
4.8 GiB of physical input for 12.85 GiB of logical data. Late cold runs were
roughly 12.5 s for sync, 12.0 s for sequential macro-ranges, and 15.2 s for async.

## Source history, not permanent variants

Checkpoint **`ff83918`** preserves all experimental source, binaries and drivers.
The current tree keeps one Wasm solver; the JS reference and other implementations
are available only in git history.
For reproduction without disturbing the current checkout:

```sh
git worktree add --detach /tmp/opencode/1brc-experiments ff83918
```

`tools/compare.mjs` accepts generic `CASES` (`name`, `env`, optional `script` and
`revision`) so scripts from different commits/worktrees can be compared without
adding strategies to the production runtime. Use absolute input/script paths
when comparing worktrees. Results are local, not official leaderboard timings.
