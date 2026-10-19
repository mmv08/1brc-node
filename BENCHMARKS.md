# Benchmark and experiment log

## Method

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

## Latest retained change

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
Node 24/26, and Biome and C-format checks pass. The current Wasm binary is only
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
The current tree intentionally keeps just the JS reference and one Wasm kernel.
For reproduction without disturbing the current checkout:

```sh
git worktree add --detach /tmp/opencode/1brc-experiments ff83918
```

`tools/compare.mjs` accepts generic `CASES` (`name`, `env`, optional `script` and
`revision`) so scripts from different commits/worktrees can be compared without
adding strategies to the production runtime. Use absolute input/script paths
when comparing worktrees. Results are local, not official leaderboard timings.
