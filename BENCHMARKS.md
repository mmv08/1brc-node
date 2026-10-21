# Benchmark and experiment log

## Current: two measured improvements from the profile targets, 2026-10-21

The retained Node change is **`266d94c`**: pack the predicted station ID and
length in one 32-bit cache entry. The retained Wasm change is **`becfb15`**:
specialize the two-vector name path for its proven 16–31-byte range. Production
selection is `654b0d4`. The third candidate, staged Wasm key loads, was rejected.
Every experiment and selection checkpoint is unsigned.

### Final independent paired comparisons

Same Ryzen 9 7900, Node 26.12.0 and independently seeded **1,000,000,000-row /
13,795,455,110-byte / 413-station** input. Both engines used 24 workers and their
existing chunk sizes and flags. Each final batch used three excluded full-file
warm-ups per case followed by **21 alternating rounds**. The fastest and slowest
run of each case are discarded. Node and Wasm were measured in separate,
sequential batches; comparisons below use the matched baseline in each batch.

| Solver | Baseline `9ee0ee3` | Retained | Less elapsed time | Paired wins | Retained throughput |
| --- | ---: | ---: | ---: | ---: | ---: |
| Plain Node | 1.092 s | **1.077 s** | **1.36%** | 15/21 | 12.81 GB/s |
| Wasm | 0.487 s | **0.477 s** | **2.09%** | 17/21 | 28.95 GB/s |

Node's best run was 1.043 s and peak RSS was 340,360 KiB. Wasm's best was
0.466 s and peak RSS was 327,144 KiB. Untrimmed paired savings averaged
16.47 ms (4.15 ms standard error) for Node and 11.04 ms (2.51 ms standard error)
for Wasm. These include process/worker startup, compilation, reads, parsing,
aggregation, merging, formatting, output and shutdown. Power settings remained
`powersave` / `balance_performance`; these are cached-file results.

[Final results and all batch summaries](benchmarks/2026-10-21-target-results.json)
link the complete [Node timings](benchmarks/experiments/targets-node-final-results.json)
and [Wasm timings](benchmarks/experiments/targets-wasm-final-results.json).
Separate batches are not pooled to calculate gains.

### What changed and what the native code proves

Node's fresh CPU profiles placed 21.2–21.6% of samples at predictor lookup and
station-length loading. Packing ID and length removes the dependent record load
and its bounds check from both predicted-hit lanes; native code extracts the
length with a shift. The optimized parser shrinks from 12,884 to 12,520 bytes.
The predictor grows from 64 to 128 KiB per worker. Full-name/delimiter checking
and the authoritative collision fallback remain. Unlike the older rejected
packing trial, the equality helper no longer reloads the stored length.

Wasm's `process_wide` is called only when the second vector contains a delimiter
and the first does not. The explicit 16–31-byte path uses the low vector directly,
masks the high vector with the existing short-mask table, and always takes the
second hash. Native code loses the low-mask load/AND and conditional hash choice;
the long-name function shrinks from 1,484 to 1,460 bytes. The removed 1 KiB mask
table helps reduce the module from **13,175 to 12,110 bytes**. Full two-vector
equality and the 32+ byte fallback remain. Rebuilding the original source with
the same Clang/LLD 21.1.8 tools reproduced its binary exactly.

The staging experiment did issue all three key loads before the first equality
check. Its optimized parser grew from 11,932 to 17,444 bytes, with 930 versus
696 static stack references across the whole function, including cold paths.
Those counts are not dynamic spill costs and do not establish why timings tied.
The candidate was rejected on the full-file measurements. The added collision
regression remains: three equal-size lanes insert and reuse colliding station
IDs across mixer retuning, checking exact aggregates.

### Experiment record

| Checkpoint | Experiment / confirmation | Matched result and decision |
| --- | --- | --- |
| `266d94c`, `791de51` | Node packed prediction; native-code evidence and nine rounds | 1.069 vs 1.089 s; 9/9 wins. |
| `becfb15`, `62b0302` | Wasm range specialization; nine rounds | 0.476 vs 0.477 s; inconclusive initial result. |
| `b6a3e22`, `431757d` | Wasm key-load staging; native-code evidence and nine rounds | 0.481 vs 0.481 s; no clear gain. |
| `431757d` | Independent nine-round Node confirmation | 1.077 vs 1.084 s; noisier, so extended to 21 rounds. |
| `431757d`, `654b0d4` | Three-case Wasm confirmation, 21 rounds | Range 0.472, original 0.486, staging 0.487 s. Range wins 20/21; staging rejected. |
| `654b0d4` | Final two-case confirmations, 21 rounds per engine | Node 1.36% and Wasm 2.09% less time; retain both. Wasm's pairwise check also removes the fixed-middle-position concern from the three-case batch. |

All **264 full-file benchmark processes** matched complete expected stdout;
all **219 measured processes** reported zero filesystem inputs. Sources were
checked before and after every warm-up and measured run. The three separate
native-profile captures also matched expected stdout; their instrumented times
are not benchmark scores. Hardware counters remain unavailable under the
existing `perf_event_paranoid=4`, so no cache-miss or misprediction cause is
claimed. No theoretical optimum has been established.

All **54 tests pass on Node 24.15.0 and 26.12.0**. The final selected solvers match
exact station/minimum/sum/maximum/count tuples for every billion-row aggregate,
the total count is one billion, and complete output matches the expected file.
[Exact verification](benchmarks/2026-10-21-target-verification.json) and the final
report preserve source hashes and test-log hashes. Biome and C-format checks pass.

To reproduce the final paired comparisons from the selected source:

```sh
git worktree add --detach results/targets-base 9ee0ee3
CASES="$(cat benchmarks/experiments/targets-node-packed-cases.json)" \
  RUNS=21 WARMUP=3 node tools/compare.mjs targets-node-final measurements.txt
CASES="$(cat benchmarks/experiments/targets-wasm-range-cases.json)" \
  RUNS=21 WARMUP=3 node tools/compare.mjs targets-wasm-final measurements.txt
node tools/verify-engines.mjs measurements.txt 1000000000
```

## Target selection: fresh profiles, 2026-10-21

Both production solvers are unchanged from `338c04c`. This pass profiles that
version and ranks experiments; it does not claim another speedup. The unsigned
profiling checkpoint is `33d732c`. Commands, source/output hashes, sample counts,
native instructions and raw-artifact hashes are in
[the target report](benchmarks/2026-10-21-optimization-targets.json).

On the same Ryzen 9 7900 and Node 26.12.0, each engine received three fresh
full-billion-row CPU-profile captures with 24 workers, alternating engine order
by round. All 150 main/worker profiles were included. A separate single-worker
raw-tick capture per engine supplied PCs and native disassembly from the same
process. All eight captures matched complete expected stdout, had stable source
hashes, and reported zero filesystem inputs. Profiled durations are not scores.

| Measured region | Share of raw CPU-profile samples across three captures |
| --- | ---: |
| Node station scanning (`scan`) | 40.4–41.3% |
| Node predictor lookup plus station-length source lines, within `scan` | 21.2–21.6% |
| Node updates / key equality (`update` / `equal`) | 25.8–26.6% / 8.3–8.6% |
| Wasm main parser (`parse_chunk`) | 68.6–69.3% |
| Wasm long-name path (`process_long`) | 5.7–6.3% |
| Reads, Node / Wasm | 5.1–5.2% / 15.1–16.1% |
| GC, either engine | 0.37–0.66% |

Percentages include the main isolate and its idle samples. Rows overlap where
stated; they are not elapsed-time components or predicted savings. Hardware
counters remain unavailable at `perf_event_paranoid=4`, so there is no measured
cache-miss or branch-misprediction explanation. No system settings were changed.

Recommended order:

1. **Node: pack only predicted ID and length in the current 32,768-entry table.**
   Native code confirms `predictor → station length → delimiter address` in
   both lanes, with a dependent length load and bounds check. A packed 128 KiB
   table can remove that load. This is a controlled revisit: `5cc6fe6` lost
   (1.262 versus 1.234 s), but used a 256 KiB table and an equality helper that
   still reloaded the length. Today's helper takes the length directly. The
   larger 512 KiB metadata layout in `89f8830` also lost. Verify that the load
   actually disappears before benchmarking; doubling today's 64 KiB table
   could still outweigh the saving. Full-name and delimiter checks must remain.
2. **Wasm: specialize the wide helper for 16–31-byte names.** Its only caller
   passes a nonzero delimiter mask shifted left by 16, proving that range.
   Nevertheless, native code loads an all-ones mask and ANDs the low vector,
   then conditionally selects the first hash for a length below 16. Use the
   low vector directly, mask only the high vector, and always take the second
   hash. This is a small, concrete target: the redundant blocks receive only
   60 of 13,621 single-worker raw ticks; the entire long-name function is about
   6% of the multiworker samples. Removing instructions need not improve time.
3. **Wasm: revisit lookup scheduling across the existing three lanes.** The
   station-head-load/equality blocks receive 3,976 of 9,426 optimized parser
   ticks (42.2%, or 29.2% of all ticks) in the single-worker capture. Test earlier
   bucket/key loads before consuming each lane's equality result, checking
   emitted ordering and spills. This has lower confidence: related staging
   attempts `14d3ab9` and `6ceef78` lost on the earlier machine/kernel. The recent
   XOR/zero-test comparison also lost; another comparison spelling alone is
   not the proposed experiment. Updates for lanes sharing a station must stay
   ordered, and full key verification must remain.

GC and generic Node collision probing are small targets in these profiles.
Read costs remain secondary, but do not establish that a new I/O strategy will
help. The prior Node runtime-control gap is still unresolved; compiler timing
needs separate evidence before attributing it to startup. Theoretical limits
have not been established. For each candidate, inspect the changed native code,
validate exact results, then require a repeatable matched full-file improvement
before changing the retained solvers.

## Previous: profile-guided Node sum updates, 2026-10-20

The retained source change is **`b216096`**, confirmed at **`c60feda`**. Plain
Node now keeps each worker-local sum biased by exactly 0.5 and removes the bias
once when exporting that station. This makes V8 emit direct Float64 addition
instead of the measured integer-conversion and range-check sequence. Wasm is
byte-for-byte unchanged from **`bd04b60`**, including its four-way loop hint.
There are still two production solvers. Every experiment has an unsigned commit.

### Final full-machine comparison

Same Ryzen 9 7900 (12 cores / 24 threads), Node 26.12.0 and independently seeded
**1,000,000,000-row / 13,795,455,110-byte / 413-station** input. Power settings
were unchanged. Each case used three excluded full-file warm-ups followed by
nine alternating rounds; the fastest and slowest times are discarded. Fresh
process timings include startup, compilation, reads, parsing, merging, output
and shutdown. Node uses its existing two inlining flags and 128 KiB chunks;
Wasm uses no extra flags and 512 KiB chunks. Both use 24 workers.

| Solver | Trimmed mean | Best | Throughput | Peak RSS |
| --- | ---: | ---: | ---: | ---: |
| Previous Node, `bd04b60` | 1.144 s | 1.137 s | 12.06 GB/s | 340,880 KiB |
| **Profile-guided Node** | **1.086 s** | **1.076 s** | **12.70 GB/s** | 341,420 KiB |
| Retained Wasm | 0.482 s | 0.474 s | 28.60 GB/s | 326,920 KiB |

Node took **5.01% less elapsed time**, winning all nine paired rounds. The
untrimmed paired saving averaged 57.86 ms with a 1.69 ms standard error.
An earlier nine-round comparison independently measured 1.121 versus 1.190 s
(5.8% less time), also winning all nine. Separate batches are not combined.
All 27 final measured processes matched complete expected stdout and reported
zero filesystem inputs: these are cached-file results. Sources were checked
before and after every process, including warm-ups.

[Final raw results](benchmarks/2026-10-20-profile-guided-results.json) and
[exact verification](benchmarks/2026-10-20-profiling-verification.json) preserve
commands, hashes and observations. All **53 tests pass on Node 24.15.0 and
26.12.0**. Full-billion-row station-name/minimum/sum/maximum/count tuples match
between engines, including expected output. Biome and C formatting pass.

### What the profiles actually show

Hardware counters were unavailable under this machine's existing
`perf_event_paranoid=4`; no system settings were changed. The investigation used
V8 CPU profiles from the main thread and all 24 workers, separate single-worker
profiles, raw V8 tick PCs joined to same-process native disassembly, and a
successful Wasm filesystem trace. Diagnostic durations are not benchmark scores.

Across all isolates, the baseline Node CPU profile attributes 35.4% of samples
to `scan`, 34.4% to `update`, and 7.6% to `equal`; GC is 0.48%. The sum-update
source line receives 18.3% of samples with 24 workers and 19.6% with one worker.
Native sampling resolves that source attribution: the dominant optimized
parser converts each Float64 sum to int64 and back, compares it, checks its
range, performs shifted integer addition with an overflow guard, then converts
back for storage. Both inlined update lanes emit this sequence.

With the half-unit bias, both lanes emit temperature-to-double conversion,
`vaddsd` and a store. The sum regions shrink from 57 to 14 static instructions
including cold paths; the optimized parser shrinks from 13,268 to 12,884 bytes.
The sum line's raw-sample share falls from 15.5% to 10.0% in those single-worker
captures. In the later 24-worker CPU capture it falls from 18.3% to 7.8%.
These are sample distributions, not elapsed-time components or cache counters.

Exactness follows from the input contract: at most one billion measurements,
each in [-999, 999] integer tenths, keep every intermediate sum below 2^40 in
absolute value. Every `sum + 0.5` is exactly representable in binary64 there.
Adding integer tenths preserves that invariant; subtracting 0.5 once per
worker's station restores the exact integer before merging. Zero and negative
totals need no special handling. Existing exact-tuple tests cover these cases,
multiple workers, parser modes, and sums beyond unsigned 32-bit limits.

Wasm's baseline CPU profile attributes 69.9% of samples to `parse_chunk`, 6.2%
to the long-name path and 14.7% to native reads. Raw PCs locate 4,071 of 9,444
optimized parser samples in the short-key lookup/equality blocks. The trace
records 26,313 large reads. Across workers, the median read span is 387.5 ms,
the median sum of read durations is 70.4 ms, and the median summed read thread
CPU time is 64.7 ms. The per-worker sums overlap and cannot be subtracted from
whole-process time. CPU-profile Wasm
columns identify function starts, so they were not treated as instruction PCs.

[Profile evidence](benchmarks/2026-10-20-profiling.json) and the
[Node native-code comparison](benchmarks/experiments/profile-node-half-native.json)
contain counts, source hashes, instruction sequences and caveats. Node tracing
with `node.fs.sync` terminated with signal 11 in two diagnostic runs, both with
and without the `v8` category; those runs were excluded. CPU and raw-PC captures
completed with correct output. The reason for that tracing failure is unresolved.

### Rejected Wasm changes and runtime control

| Checkpoint | Profile-driven experiment | Matched result / decision |
| --- | --- | --- |
| `d015c5c` | Profile both current engines before selecting changes | Baseline observations and reproducibility plan. |
| `ee8bb70` | Short-key XOR plus vector zero test | V8 materialized a Boolean, expanding five native instructions to seven. 0.492 vs 0.481 s in nine rounds; reject. |
| `f50d16b` | Combine long-key equality vectors before one movemask | Removed one native instruction, but 0.484 vs 0.483 s in nine rounds; reject. |
| `cde72aa` | Disable additive-safe-integer feedback as a diagnostic control | Baseline Node 1.190 s, control 1.079 s, half-offset source 1.121 s in the same nine-round batch. |
| `b216096` | Exact half-offset Node sums | Removes the measured conversion checks; retain after correctness and repeated full-machine gains. |
| `ad3ec02` | Profile control versus source fix with all 24 workers | Similar hot code; tier availability differs, but cause of remaining timing gap is unresolved. |
| `c60feda` | Confirm selected Node and retained Wasm | Final 1.144 → 1.086 s Node pair; Wasm 0.482 s. |

The control uses `--no-additive-safe-int-feedback` alongside the normal Node
inlining flags. It explains why the original sum sequence is avoidable. The
control and source fix emit equivalent optimized sum sequences. In 24-worker
raw samples, 97.76% of mapped parser samples are TurboFan for the control versus
96.62% for the source fix. Median first optimized-parser availability after
bytecode creation is 133.6 versus 175.0 ms. These delays include preceding work
and scheduling; they are not compiler CPU times and do not establish the cause
or magnitude of the separate timing gap. Both have four workers with an extra
optimized parser version that receives no samples.

The portable source fix is selected; the new engine flag remains a documented
control. Local Node 26 enables that feedback by default, while local Node 24
leaves it disabled. The flag is absent from
[Node 22.0.0's V8 definitions](https://github.com/nodejs/node/blob/v22.0.0/deps/v8/src/flags/flag-definitions.h)
and appears, defaulting off, in
[Node 24.0.0](https://github.com/nodejs/node/blob/v24.0.0/deps/v8/src/flags/flag-definitions.h).
No blanket runtime requirement was added. A theoretical optimum is not claimed:
the measured improvement proves the preceding Node version had avoidable work;
read-only throughput is not a theoretical bound.

Raw rejected results: [short XOR](benchmarks/experiments/profile-short-xor-results.json),
[wide mask](benchmarks/experiments/profile-wide-mask-results.json), and
[Node three-case control](benchmarks/experiments/profile-node-addition-results.json).

### Reproduce

```sh
git worktree add --detach results/profile-baseline bd04b60
CASES="$(cat benchmarks/experiments/profile-final-cases.json)" \
  RUNS=9 WARMUP=3 node tools/compare.mjs profile-final measurements.txt
node tools/verify-engines.mjs measurements.txt 1000000000
```

For a CPU profile, create a fresh output directory and run the selected Node
runtime with `--cpu-prof --cpu-prof-interval=1000 --cpu-prof-dir=ABSOLUTE_DIR`.
Preserve the normal inlining flags when profiling plain Node. Summarize the
main and worker files together with
`node tools/profile-summary.mjs ABSOLUTE_DIR`; it reports raw samples separately
from interval weights and preserves scheduling outliers.

Saved capture commands and hashes are in the profile evidence. Wasm native
capture uses `--prof --prof-sampling-interval=250 --print-wasm-code --code-comments`
with one worker. Pass its matching V8 log and stdout disassembly to
`node tools/profile-wasm-pc.mjs V8_LOG DISASSEMBLY`. The mapper rejects overlapping
code ranges and code moves. For Node, `--print-opt-code --log-source-code
--log-source-position --trace-deopt` supplies optimized instruction and inlining
metadata alongside `--prof`. Each capture's solver output was checked against
the expected complete result; native-code diagnostics were separated from it.
Large raw profiles remain under ignored `results/profiles/`.

## Previous: Wasm hint and attribute experiments, 2026-10-20

Selected runtime: **`801ecc5`**, equivalent to the four-way experiment `bbef50b`.
The sole C change from **`e7d1d1a`** is
`#pragma clang loop unroll_count(4)` before the existing bounded three-lane loop.
The binary and build manifest were regenerated. Plain Node, the reader, host
code and branch-hint generator are unchanged. Both production solvers remain.
Every experiment below has an **unsigned checkpoint commit**.

### Final paired comparison

Same Ryzen 9 7900 machine, Node **26.12.0**, 24 workers, 512 KiB chunks, and the
existing **one-billion-row / 13,795,455,110-byte / 413-station** dataset. Power
settings are unchanged (`powersave`, `balance_performance`). Both binaries use
Clang/LLD **21.1.8**; rebuilding the baseline reproduced its binary exactly.

Three excluded full-file warm-ups per case precede **21 alternating rounds**.
Scores discard the fastest and slowest run, averaging the remaining 19. Fresh
process timings include startup, compilation, IO, parsing, merging, output and
shutdown. All 42 measured processes matched expected stdout and reported zero
filesystem inputs. There are no extra V8 flags in either final case.

| Implementation | Trimmed mean | Best | Throughput | Peak RSS |
| --- | ---: | ---: | ---: | ---: |
| Previous Wasm | 0.488 s | 0.479 s | 28.25 GB/s | 326,732 KiB |
| Four-way loop hint | 0.485 s | 0.470 s | 28.42 GB/s | 326,600 KiB |

The hint took **0.62% less elapsed time**, winning **14 of 21** paired rounds.
The preceding nine-round batch measured 0.491 vs 0.494 s; an earlier five-run
screen measured 0.481 vs 0.488 s. This is a small, workload-specific trend:
the final untrimmed paired saving averaged 3.42 ms with a 2.50 ms standard error,
so this paired batch alone does not establish a statistically clear speedup.
Retention follows the repeated small positive averages and trades them for **13,175 bytes of Wasm versus 9,442 bytes** before.
Compiler, engine and input changes warrant remeasurement.

A diagnostic pinned to CPU 0 with one worker measured means of 4.248 s for the
baseline, 4.188 s with two-way unrolling, 4.134 s with four-way unrolling and
4.160 s with eight-way unrolling. It used one warm-up and three alternating
rounds, without trimming. This supports investigating the loop change but is
not the full-machine score; the baseline's first measured run was noticeably
slower than its next two.

Raw final results:
[`2026-10-20-wasm-hints.json`](benchmarks/2026-10-20-wasm-hints.json).
Exact verification:
[`2026-10-20-wasm-hints-verification.json`](benchmarks/2026-10-20-wasm-hints-verification.json).
These are local cached-file results, not official leaderboard scores.

### What the experiments established

The existing branch metadata already helps. Ignoring it with
`--no-experimental-wasm-branch-hinting` increased a matched five-run trimmed mean
from **0.491 to 0.513 s**, about **4.6% more time**. Disabling V8 Wasm inlining
or raising its inline-size limit also regressed that screen. Metadata-only
variants preserved every non-custom section byte, isolating their hint changes.

Adding `hot` to the parser, adding likely/unlikely `__builtin_expect` annotations,
or explicitly disabling inner-loop unrolling produced **byte-for-byte identical
Wasm** with this toolchain. Those additions were rejected without redundant
timing. Marking cold helpers `minsize`, relaxing forced C inlining, inlining the
long-name path, and changing branch-hint coverage did not give a useful repeated
win. Combining long-name inlining and loop unrolling also failed to improve on
the simpler hint. Eight-way unrolling increased the binary to 16,859 bytes and
was slower than four-way unrolling in the final multi-case confirmation.

The experimental `--wasm-eager-tier-up-function=8` flag completed one warm-up,
then stalled on the second. That process was terminated after more than 50
seconds and the flag was rejected. Its incomplete report is saved separately
and contributes to no timing score. Normal comparisons resumed without it.

All **53 tests pass on Node 24.15.0 and Node 26.12.0** for the selected artifact.
Exact station-name/minimum/sum/maximum/count tuples match the plain Node engine
across all one billion measurements, including complete expected stdout.
Biome, clang-format and source/build hash checks pass. A separate code review
confirmed that the pragma leaves full-name checks, the 108-byte row bound,
remainder handling, tail loops and host ABI intact.

### Unsigned checkpoints and evidence

Times in each row belong to that experiment's matched batch. Different rows
must not be combined to calculate incremental speedups. Screening uses five
runs and two warm-ups, with fastest/slowest removed, unless noted otherwise.

| Checkpoint | Experiment | Result and decision |
| --- | --- | --- |
| `4fa66a4` | Existing hints, V8 inlining controls | Baseline 0.491 s; ignore hints 0.513, disable inlining 0.498, larger inline limit 0.506. Retain defaults. [R] |
| `423f1f7` | Hint cold paths only, leave loop backedges neutral | 0.488 vs 0.486 s; reject. [S] |
| `b635eb8` | Emit hints only for `parse_chunk` | 0.491 vs 0.486 s; reject. [S] |
| `c1a197d` | Leave long-name calls neutral in branch metadata | 0.507 vs 0.486 s; reject. [S] |
| `6c1ed11`, `69fa2eb` | Explicit likely/unlikely branches; `hot` parser attribute | Exact same Wasm as baseline; reject ineffective additions. [B] |
| `b95aa4b` | Force-inline long-name handler | 0.484 vs 0.486 s initially, then 0.488 vs 0.488 s; reject. [S, F] |
| `97b8845` | Two-way loop unrolling | 0.482 vs 0.486 s initially; later 0.493 vs 0.494 s. Four-way is the stronger candidate. [S, C] |
| `57925d2`, `a760ba8` | Targeted eager optimization of parser | Stalled on second warm-up; terminated and excluded. Remaining hint screen rerun. [E] |
| `dc8d14f` | `minsize` on cold helpers | 0.491 vs 0.488 s; reject. [F] |
| `3e1af90` | Let Clang choose helper inlining | 0.489 vs 0.488 s; reject despite smaller 7,615-byte module. [F] |
| `50f9ebc` | Explicitly disable inner-loop unrolling | Exact same Wasm as baseline; reject ineffective addition. [B] |
| `bbef50b` | Four-way loop unrolling | 0.481 vs 0.488 s screen; 0.491 vs 0.494 s nine-run confirmation; 0.485 vs 0.488 s final paired repeat. Retain with small-gain caveat. [F, C, P] |
| `27f8619` | Combine inlined long path and two-way unrolling | 0.487 vs 0.488 s, 19,462-byte module; reject. [F] |
| `c41ba08` | Eight-way loop unrolling | 0.493 vs 0.494 s in confirmation; reject in favor of four-way's smaller/faster module. [C] |
| `152eb0f`, `5e0f5cf`, `e5d5358`, `5268948` | Refinement, pinned-core diagnostic, nine-round and 21-round confirmations | Preserve each comparison configuration. [F, O, C, P] |

Evidence (all under `benchmarks/experiments/` except P):

- R: [runtime controls](benchmarks/experiments/hints-runtime-controls-results.json).
- S: [first attribute screen](benchmarks/experiments/hints-screen-results.json).
- F: [refinement screen](benchmarks/experiments/hints-refine-results.json).
- B: [binary/core comparisons](benchmarks/experiments/hints-bytecode-comparison.json).
- E: [failed eager-tier-up record](benchmarks/experiments/hints-eager-tier-up-failure.json),
  [incomplete warm-up report](benchmarks/experiments/hints-eager-tier-up-partial-results.json).
- O: [one-core diagnostic](benchmarks/experiments/hints-single-core-results.json).
- C: [nine-round confirmation](benchmarks/experiments/hints-confirm-results.json).
- P: [21-round paired confirmation](benchmarks/2026-10-20-wasm-hints.json).

The hints are compiler guidance, not added input assumptions. References:
[Clang loop hints](https://releases.llvm.org/21.1.0/tools/clang/docs/LanguageExtensions.html#extensions-for-loop-hint-optimizations),
[Clang attributes](https://clang.llvm.org/docs/AttributeReference.html),
and the [WebAssembly branch-hint format](https://github.com/WebAssembly/branch-hinting/blob/main/proposals/branch-hinting/Overview.md).
No global tools, power settings or runtime flags were changed.

To reproduce the final pair in a fresh checkout (the source snapshots used
locally occupy these ignored paths):

```sh
git worktree add --detach results/hints-baseline e7d1d1a
git worktree add --detach results/hints-unroll-four bbef50b
CASES="$(cat benchmarks/experiments/hints-paired-confirm.json)" \
  RUNS=21 WARMUP=3 node tools/compare.mjs hints-paired-confirm measurements.txt
node tools/verify-engines.mjs measurements.txt 1000000000
```

The one-core diagnostic used `WORKERS=1` cases from `hints-single-core.json`
and `taskset -c 0`, with `RUNS=3 WARMUP=1`. All benchmark inputs and local
runtimes remain ignored. The earlier plain-Node and Wasm results follow.

## Previous: direct Wasm deltas and simpler Node prediction, 2026-10-20

Further experiments improved both selected implementations. The clearest gain is
Wasm: **4.1% less elapsed time** in the final matched batch. Node's simpler
prediction hash measured **0.5% less time**, a small gain sensitive to noise.
The selected runtime is **`bf11dbb`** (the `7969ca6` selection with its build manifest
formatted). There are still exactly two production solvers. Every experiment has
an unsigned checkpoint; rejected source remains in history.

### Final matched comparison

- AMD Ryzen 9 7900, 12 physical cores / 24 logical CPUs, 60 GiB RAM,
  Linux 7.0.0-38-generic; Node **26.12.0**.
- Unchanged `powersave` governor and `balance_performance` preference. No power
  settings or system-wide caches were changed.
- **1,000,000,000 independently generated rows**, **13,795,455,110 bytes**,
  413 stations; same seeded input as the preceding round, reused read-only.
- Three excluded full-file warm-ups per case, then **nine alternating rounds**.
  Each score drops the fastest and slowest run and averages the remaining seven.
- Fresh processes include startup, compilation, reading, parsing, aggregation,
  merging, sorting, complete output and shutdown. All **45 measured processes**
  matched expected stdout and reported **zero filesystem inputs**: warm-cache results.
- Default comparisons use 24 workers. Node keeps its two documented inlining
  flags and 128 KiB chunks; Wasm uses no extra flags and 512 KiB chunks.
  A fifth case checks Wasm with 16 workers. Sources are hashed before and after
  every process, including warm-ups.

| Implementation | Trimmed mean | Best | Throughput | Peak RSS |
| --- | ---: | ---: | ---: | ---: |
| Previous plain Node | 1.174 s | 1.155 s | 11.75 GB/s | 340,364 KiB |
| Optimized plain Node | 1.168 s | 1.151 s | 11.81 GB/s | 341,192 KiB |
| Previous Wasm | 0.511 s | 0.499 s | 26.98 GB/s | 319,728 KiB |
| Optimized Wasm | 0.490 s | 0.480 s | 28.13 GB/s | 325,720 KiB |
| Optimized Wasm 16 workers | 0.489 s | 0.480 s | 28.20 GB/s | 244,168 KiB |

Both preceding versions are from **`5769105`**. The Node change won eight of nine
rounds in its earlier dedicated confirmation (1.156 vs 1.168 s), but only four
of nine in this final mixed-engine batch despite the slightly lower trimmed
mean. Treat it as a modest workload-dependent improvement, not a large or
uniform win. The direct Wasm table improved time in repeated seven-run screens
and this final comparison. Sixteen workers are effectively tied with 24 in the
final batch; the portable default remains the available CPU count.

Raw timings, source hashes, tuning and resource counters:
[`2026-10-20-round2-optimization.json`](benchmarks/2026-10-20-round2-optimization.json).
Exact validation:
[`2026-10-20-round2-exact-verification.json`](benchmarks/2026-10-20-round2-exact-verification.json).
These are local measurements, not official challenge scores.

### Selected changes and correctness

Node's prediction hash now XORs the fifth byte directly into the first four
before multiplication, removing three bit operations. Its 64 KiB cache still
verifies every byte and the delimiter; cache collisions use the general parser.
The previous round's smaller worker entry and early merging remain.

Wasm stores each temperature spelling's complete 128-bit update vector in a
sparse **1 MiB table**. A single load replaces the dependent offset-table and
delta-table loads. The table is initialized from the legal temperature range,
not station names or input data. Its extra address space is private per worker;
the selected module starts with 4 MiB of memory.

A negated maximum at raw station offset 14 allows one signed SIMD minimum to
update both extrema. Host decoding preserves positive zero. A long name takes
only its own lane through fallback, leaving the other lanes on their short-name
path. Removing unused mask entries also folds table bases into load offsets.
The selected kernel uses three lanes and is **9,442 bytes**, built with the
available Clang/LLD **21.1.8**. The shipped baseline used Clang 22.1.8 / LLD 20.0.0;
rebuild controls separate some toolchain effects, but final scores compare the
complete artifacts, not a compiler-independent algorithm estimate.

All **53 tests pass on Node 24.15.0 and 26.12.0**, including exhaustive legal
spelling checks, official fixtures, long/Unicode/NUL names, collisions, 10,000
stations, boundaries, CRLF, EOF and large exact sums. A focused test checks the
negative-maximum ABI and zero. Both engines also match every exact station
name/minimum/sum/maximum/count tuple across **all one billion rows**, and their
complete stdout matches the generator's independent expected output. Biome and
clang-format checks pass. A separate read-only code review found no correctness
blocker in the selected indexing, SIMD update, fallback or benchmark hashing.

### Headroom and experimental limits

`tools/read-bandwidth.mjs` runs the production reader with a no-op parser. Full
process times averaged **0.337 s at 12 workers** and **0.363 s at 24 workers**.
It checks the number of consumed chunks; the saved diagnostic runs also include
full-process IO/resource counters. It does not produce station aggregates. This is a diagnostic for one cached-file read path,
**not a theoretical lower bound**. Reading and parsing overlap, so subtracting
these values from solver time would not measure parsing cost. Hardware counters
were unavailable under this machine's existing perf permissions.

The one-core screen exposed a substantial regression in an apparently simpler
row-advance loop. Other experiments lost to cache footprint, dependency chains
or extra arithmetic. The measured Wasm gain establishes that the previous
version was not the practical limit. These experiments do not prove that the
current version is optimal, nor that every dataset will improve equally.

### Experiment checkpoints

The initial 31 checkpoints after `5769105` are grouped below; the final confirmation is recorded separately. Times are seconds for the same 1,000,000,000-row / 13,795,455,110-byte input on this machine with Node 26.12.0. Each comparison uses its own matched baseline; rows from separate batches must not be compared as though they were one controlled run. Screens used three or five runs, confirmations seven or nine; runs of five or more discard the fastest and slowest observation. Read-only figures below are the untrimmed mean of five full-process measurements.

| Checkpoints | Experiment | Matched result and disposition |
| --- | --- | --- |
| `bd764ea` | Preserve the round-one result before new experiments | Baseline runtime is `5769105`; empty checkpoint records the starting point. |
| `f8aa946` | Node lane count, temperature decoding, equality mode, table size, V8 inlining | Baseline 1.163; one/three/four lanes 1.178/1.234/1.293; compact/arithmetic temperatures 1.178/1.167; branchy equality 1.241; 14/16-bit tables 1.176/1.164; larger inlining budget 1.203. Keep existing settings. [N] |
| `f7cdb99` | Read-only throughput diagnostic using the existing reader | Original reader: 0.337 at 12 workers and 0.363 at 24; batched reader: 0.342/0.373. Diagnostic retained; these measure one IO path without parsing, **not a theoretical bound**, and cannot be subtracted from solver time to isolate parsing cost. [R] |
| `fd50916`, `a4b6d97` | WASM negated maximum; independent fallback for long names in each lane | Individually 0.508/0.507 vs shipped 0.506 and rebuilt Clang 21 control 0.517. No isolated win over shipped binary; combined and re-evaluated later. [P] |
| `d3e89f0`, `cd9205a`, `c8e01ed` | Node grouped equality; decode temperatures before updates; pipeline next group | 1.190/1.211/1.202 vs 1.165. Rejected. [P] |
| `6982b37` | WASM arithmetic combination of delimiter-presence checks | 0.522 vs shipped 0.506 / Clang 21 control 0.517. Rejected. [P] |
| `c0d9600` | Claim sixteen WASM input chunks per atomic operation | 0.504 vs shipped 0.506; negligible solver difference, with no read-only improvement in a separate diagnostic. Rejected. [P, R] |
| `ebb172a`, `89f8830` | Node fused Float64 statistics; colocated predictor metadata | 1.205/1.203 vs 1.167. Rejected. [L] |
| `a5f6893`, `f7008a3` | WASM aligned 48-byte / 64-byte station records | 0.508/0.512 vs Clang 21 control 0.508 (shipped 0.511). No useful gain; rejected. [L] |
| `2eed87d`, `33a1564` | Node two-way predictor, 64 KiB / 128 KiB | 1.209/1.200 vs 1.167. Rejected. [L] |
| `54cd77f` | Node eight-byte UTF-8 name equality through Float64 loads | Correct but 1.379 vs 1.167. Rejected. [L] |
| `1fc923c` | Combine WASM negated maximum and independent long-name fallback | Initially 0.493 vs shipped 0.511; repeat 0.503 vs 0.509 and later 0.504 vs 0.501. Isolated multicore gain was not stable. Retained as a base for subsequent combined candidates. [L, H, F] |
| `1136725`, `393e5c8` | Node cheaper prefix hash; shifted-fifth-byte alternative | First screen 1.177/1.180 vs 1.171; later simple-hash confirmations 1.152 vs 1.175 and 1.156 vs 1.168 (wins eight of nine rounds). Select the simple XOR/multiply hash; reject shifted alternative. [H, F, NC] |
| `1d06e80` | Node macro queue, async IO, private file descriptors; repeat combined WASM | Node 1.177/1.821/1.193 vs 1.171: reject IO changes. Combined WASM 0.503 at 24 workers / 0.491 at 12 vs baseline 0.509; later worker-count results differ. [H] |
| `74149ef`, `992e8b8` | WASM folded SIMD mask addresses, alone and with combined lane changes | Folded baseline 0.512; folded combined 0.502 at 24 workers / 0.495 at 12 vs shipped 0.501 at 24 / 0.508 at 12. Small/noisy whole-process differences; folded addresses retained for later direct-table candidates. [F] |
| `bdd0a18` | Seven-run confirmation of folded WASM loads and worker counts | Captures the matched repeat above, including simple Node hash. No broad, stable isolated WASM gain established by this batch. [F] |
| `13cb56b`, `8349896` | Advance WASM rows from temperature width; isolate kernels on one CPU | One-core mean: shipped 4.349, folded combined 4.248, temperature advance 6.432. Reject temperature advance; retain newline scan. `8349896` also checkpoints the confirmed simple Node hash. These one-core timings do not predict the multicore gain directly. [S] |
| `805a1c8` | Direct 1 MiB WASM temperature-to-SIMD-delta table, eliminating a dependent lookup | 0.483 vs shipped 0.496 / folded combined 0.501; repeat 0.487 vs shipped 0.503. Retained with three lanes and the existing worker default. [D, C] |
| `fdc9c79` | Pack direct WASM deltas into a 128 KiB table | 0.502 vs direct 1 MiB 0.487 / shipped 0.503. Extra index work loses the direct-table gain; rejected. [C] |
| `9124f4e`, `b7bf73a`, `7d1e99c` | Direct-table WASM with two/four lanes; rescreen 12/16/24 workers | Lane screen: two 0.488, three 0.491, four 0.497. Worker sweep: three lanes 0.501/0.489/0.493; two lanes 0.514/0.498/0.495. Four lanes rejected; two-lane and worker-count advantages did not repeat consistently. Retain three lanes and the existing worker default. [DL, DW] |

Evidence key (individual runs and source hashes; solver reports also validate complete output):

- N: `benchmarks/experiments/round2-node-tuning-results.json`.
- R: `benchmarks/experiments/round2-read-original-results.json` and `round2-read-bandwidth-results.json`.
- P: `benchmarks/experiments/round2-parser-io-results.json`.
- L: `benchmarks/experiments/round2-layouts-results.json`.
- H: `benchmarks/experiments/round2-hash-io-results.json`.
- F: `benchmarks/experiments/round2-fold-confirm-results.json`.
- NC: `benchmarks/experiments/round2-node-confirm-results.json`.
- S: `benchmarks/experiments/round2-single-core-results.json`.
- D: `benchmarks/experiments/round2-direct-deltas-results.json`.
- C: `benchmarks/experiments/round2-compact-deltas-results.json`.
- DL: `benchmarks/experiments/round2-direct-lanes-results.json`.
- DW: `benchmarks/experiments/round2-direct-workers-results.json`.

The shipped baseline was built with Clang 22.1.8, while this round's rebuilds use the available Clang 21.1.8. The rebuilt control is included where available; comparisons against the shipped baseline measure the complete artifact and do not isolate the compiler's contribution. Read-only reports contain source hashes but intentionally have no parsed output to verify. All reported performance is for cached input; filesystem input counters were zero. No theoretical optimum has been established.

The final comparison configuration is checkpointed in `d53be12`, updated to the
formatted runtime in `6fbe3d3`. An initial confirmation was interrupted to fix
manifest whitespace before taking final source hashes; its incomplete report
is excluded. The completed final batch and exact verification both describe
`bf11dbb` byte-for-byte.

Reproduce the selected solvers and exact validation:

```sh
RUNS=9 WARMUP=3 node tools/compare.mjs node-vs-wasm measurements.txt
node tools/verify-engines.mjs measurements.txt 1000000000
WORKERS=12 node tools/read-bandwidth.mjs measurements.txt
```

To reproduce the matched comparison against the start of this round:

```sh
git worktree add --detach results/round2-baseline 5769105
CASES="$(cat benchmarks/experiments/round2-final.json)" \
  RUNS=9 WARMUP=3 node tools/compare.mjs round2-final measurements.txt
```

Screening source paths under `results/` are ignored snapshots. Their checkpoint
commits preserve the implementations; recreate snapshots or update `script`
paths when reproducing those screens. Dataset, tools and local runtimes remain
ignored. Historical batches below retain their original context and results.

## Previous: further Node optimization and Wasm trials, 2026-10-20

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
