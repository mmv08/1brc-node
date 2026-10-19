# Benchmark and experiment log

## Current result: bounded parser and paired hashing, 2026-10-19

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
