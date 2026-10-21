# Optimizations and research

## Current solvers

The retained Node implementation uses two integer parsing cursors, fully verified
station predictions, half-integral exact sums, a 32K hash table and synchronous
128 KiB reads. The Wasm implementation uses three lanes, delimiter-encoded SIMD
keys, sparse-table retuning, direct temperature deltas, specialized 16–31-byte
names, four-way unrolling and derived branch hints. Both use dedicated workers,
shared scheduling/reading/formatting and complete station-name verification.

On an AMD Ryzen 9 7900 (12 cores / 24 threads, 60 GiB RAM), Node 26.12.0 processed
1,000,000,000 rows / 13,795,455,110 bytes / 413 stations as follows:

| Measurement | Node | Wasm |
| --- | ---: | ---: |
| Final optimization, before cleanup | 1.024 s | 0.476 s |
| Cleanup at `8a52271` | 1.019 s | 0.483 s |
| Cleanup paired elapsed-time change | −0.51% | −0.21% |
| Cleanup 95% interval | −1.17% to +0.21% | −1.30% to +0.96% |

These are warm-filesystem-cache, end-to-end timings including process startup,
compilation, reads, parsing, merging, output and shutdown. Both use 24 workers;
Wasm chunks are 512 KiB. The cleanup comparison uses three warmups per case and
21 alternating pairs per engine, run sequentially. Times are trimmed means;
intervals use all paired log time ratios and 10,000 bootstrap resamples, seed
20261021. Negative time changes mean faster. Both intervals span zero; no
measurable change was detected on this input. Every output matched and every
measured filesystem-input counter was zero. Exact tuples and counts matched
across all billion rows; 57 tests passed on Node 24 and 26.

The last Node optimization gained 4.97% over its own earlier baseline (21/21
paired wins). That comparison and the cleanup comparison have different
baselines. Local results are not leaderboard scores or a theoretical limit.

The deeper cleanup keeps the solver logic and Wasm binary unchanged, relocates
the plain parser, and consolidates benchmarking into one runner. All 57 tests
pass again on Node 24 and 26, and a fresh billion-row verification matches exact
tuples and complete output. The timing figures above remain the recorded
`8a52271` comparison; no new speedup is claimed for repository cleanup.

## Selected V8 patch

[v8.patch](v8.patch) contains the final source and regression tests of the selected
sequence. It excludes rejected experiments, instrumentation, duplicate versions,
and independent alternatives that were not part of that sequence. The two
solvers above run on stock Node and do not require this patch.

| Component | Evidence on unchanged official V8 benchmarks | Measured baseline → candidate |
| --- | --- | --- |
| Inline `ArrayBuffer.prototype.byteLength` | TypedArray BigEndian +31.51%, Floats +33.43%, LittleEndian +17.49%; six-case DataView mean +12.94%. | `293377af` → `f090ad58` |
| Terminal-path loop peeling and bounded dispatch cloning | Six-case DataView mean +8.94% [8.81%, 9.11%]; TypedArray BigEndian +29.84%, Floats +4.68%, LittleEndian +18.62%. Constant-Phi expression handling is a prerequisite inside this change. | `f090ad58` → `fcc58178` |
| Exact-key lookup for fresh allocations | Official Compiler Large-Copy +34.98% [34.59%, 35.36%]. Independently confirmed alone on pristine V8: +35.17% [34.82%, 35.59%], 12/12 wins; DataView control neutral. | `fcc58178` → `87e3481b`; pristine → `e6293c24` |
| Compare encoded node-marker states directly | Compiler Large-Copy +0.65% [0.47%, 0.84%], Medium-Copy +0.66% [0.37%, 0.94%], Medium-Fact +1.05% [0.34%, 1.77%]. Nine-case mean interval spans zero. | `87e3481b` → `c281a2f9` |
| Lazy indexed escape-analysis tables | Compiler Large-Copy +10.70% [10.50%, 10.89%], Medium-Copy +9.40% [9.18%, 9.61%], each 12/12 wins; nine-case mean +2.29% [1.88%, 2.76%]. DataView control neutral. | `c281a2f9` → `cefc3a78` |

These are incremental score gains on different baselines; **do not add them**.
The combined patch is exactly the already-built and tested `cefc3a78` source
tree, not a new combination assembled during cleanup. No end-to-end benchmark
claim for the complete patch against pristine V8 is made.

### Profiling evidence and remaining costs

Sampling first identified the ArrayBuffer getter in 3.9% of DataView ticks;
native code then confirmed its inner-loop calls disappeared. Further IR/native
inspection exposed blocked loop peeling and redundant polymorphic dispatch.

The official Compiler profile attributed 18.9% of compiler ticks to field-cache
invalidation; 89.4% of that function's samples were in dead-node checks and map
iteration. The existing fresh-allocation alias invariant permits an exact-key
lookup. Afterward, its sampled share fell to 1.33%, supporting the benchmark
result without treating sample counts as a speedup measurement.

Reducer disassembly showed repeated mark decoding/clamping, motivating encoded
comparisons. Escape-analysis state/object reads later accounted for 5.43% of
compiler samples. Large-Copy held 90,492 state entries below node ID 99,734,
while 56.84% of its state reads occurred during merges. Lazy 64-entry chunks
remove the hash lookup while preserving sparse default/reference semantics.

The loop/dispatch changes have a real cost: the hot polymorphic function grows
39.08%, five official Compiler controls regress by approximately 0.6–1.0%, and
the original DataView compilation diagnostic increases pipeline time 12.37%
and zone allocation 11.88%. After the allocation fix, a separate historical
comparison still measures +9.62% compilation time and +11.88% zone allocation
versus getter-only. Separate batches do not prove a reduction from 12.37% to
9.62%. The graph-growth cost remains a useful development target.

Indexed storage reduces Large-Copy's total compiler-zone allocation 1.08%, but
increases the smaller DataView diagnostic's total allocation 0.13% and its
escape-analysis allocation 5.74%. Some unchanged benchmark cases have negative
point estimates with intervals spanning zero. The patch is a measured research
candidate, not a claim of universal speedup or upstream approval.

### Reproduce and develop

Apply the patch in an upstream V8 checkout at the exact base:

```sh
git checkout 293377af9f02c268362e5975b7af4baa25688323
git apply --check /path/to/1brc-node/v8.patch
git apply --index /path/to/1brc-node/v8.patch
git write-tree
```

The resulting tree must be `2862cf8b44bd752fc27924e9e44f0c3a971e5844`, matching
`cefc3a78a6708beac8ff001375a6f2d0d55f3735`. Cleanup verified this with a temporary
Git index. Patch SHA-256:
`16337789aa6cab98ed0297c605ad30cd082f540c3619f63cf804d2046000957f`.

Use V8's normal dependency setup at the base revision and the recorded GN args:

```text
is_debug=false target_cpu="x64" v8_target_cpu="x64" v8_enable_disassembler=true v8_enable_object_print=true symbol_level=1 use_remoteexec=false use_siso=false
```

Build `d8`, `cctest` and `v8_unittests` with the pinned toolchain. Tests added by
the patch cover buffer resizing/detachment and exception realms, loop exit/frame
remapping, constant-Phi branches, fresh-allocation invalidation, marker epochs,
revisits and sparse table defaults/reference stability. The final indexed build
passed 122 selected checks; earlier stages also passed their own targeted tests.

Official DataView uses `d8 run.js` from `test/js-perf-test/DataView`. Official
Compiler uses `d8 --allow-natives-syntax run.js` from `test/js-perf-test/Compiler`.
The original protocol pins timed processes to CPU 2, uses identical release
build configurations, one warmup per binary and fixed alternating pairs:
21 DataView pairs, 12 Compiler pairs, and six separate compilation diagnostics.
Every observation remains in the archived analysis. Score intervals use paired
log ratios, 10,000 bootstrap resamples and seed 20261021. Per-case intervals
are not adjusted for multiple comparisons.

Hardware perf counters were unavailable; profiles used V8's sampler, compiler
phase statistics and disassembly. Instrumented scores are not runtime results,
zone allocation is not RSS, and matching generated-code sizes is not proof of
identical machine code. All measurements are local Linux x64 results. Next work
should measure the complete patch against pristine, investigate the remaining
loop/dispatch compilation cost, and broaden platform/workload validation.

## Other V8 experiments

| Attempt | Observed result | Disposition in this tree |
| --- | --- | --- |
| Fold numeric bitcasts into stores | Removed register transfers, but DataView Floats −4.06% and TypedArray Floats −2.56%, 0/21 wins in both. | Removed. |
| Signed-shift range proof | Removed two overflow branches; every score interval included zero. | Removed. |
| Constant-Phi expression proof alone | Did not remove the targeted dispatch without changing the cloning budget. | Kept only as a prerequisite in the selected combined patch. |
| Dominating zero-mask guards | Removed a redundant mask; every score interval included zero. | Removed. |
| Terminal peeling alone | TypedArray BigEndian +29.74%, LittleEndian +5.96%, Floats +3.95%; DataView BigEndian −0.26%. | Superseded by the measured combined dispatch/peeling version. |
| Bounded dispatch cloning alone | TypedArray LittleEndian +12.53%, DataView LittleEndian +3.24%. | Superseded by the measured combined version. |
| Field-name-aware invalidation | Compiler Medium-Copy +0.85% [0.63%, 1.07%], several other modest gains, runtime controls neutral. | Independent beneficial alternative; not stacked with the selected allocation lookup. Source remains in history. |
| Outline reduction tracing | Reducer shrank 1,458 → 370 bytes, but total compilation-time change +0.18% [−1.68%, +2.03%]. | Removed. |
| Simplify safepoint request predicate | One Compiler case +1.00%; suite interval spanned zero with opposing order splits. Parked-with-request overhead during concurrent GC was unmeasured. | Unpromoted; removed. |
| Cache merge-input states | Large-Copy +2.35%, Medium-Copy +2.52%, but three small Compiler cases regressed 0.89–1.09% with negative intervals and both orders negative. | Rejected; removed. |
| Instrument escape-analysis table accesses | Established density/read counts; instrumentation was not a performance candidate. | Removed. |
| Fresh-allocation patch on pristine | Independently confirmed the same production diff. | Duplicate patch removed; result retained above. |

## Solver experiment history

The following tables preserve the recorded attempts and checkpoint IDs, grouped
by round. Timings are historical matched comparisons within each round; they
must not be compared across machines, power modes, dates or configurations.
A change rejected alone may later appear in a measured winning combination.
Timing values without units in these tables are seconds. The full original
protocols and measurements remain accessible through the history references below.

### Retained: Node tier-up, deopt fix and leaner hit path, 2026-10-21

Per-chunk timing inside each worker showed steady 128 KiB chunks at 0.16 ms but
warm-up chunks at 0.55–0.6 ms (Maglev) and 2–26 ms (interpreter): about 78 ms
lost per worker. 24 isolates queued their TurboFan jobs on the shared pool, and
`--trace-deopt` showed `(end - start) / 2` deoptimizing `parseChunk` ("lost
precision") whenever a chunk had odd length, forcing a recompilation. Machine
code then showed a per-row identity check on the module-level `temperatureBase`
function, overflow checks from `* 8` and the branchless negate, and an
always-loaded arena offset. All rows use the presized descriptor table; Node
26.12.0, 24 workers, three-run trimmed means of alternating runs.

| Experiment | Measured result | Decision |
| --- | --- | --- |
| `--no-concurrent-recompilation` alone | 0.9647 vs 0.9455 s | Reject alone |
| `--no-maglev` alone | 0.9597 vs 0.9455 s | Reject alone |
| Both: each worker compiles TurboFan once on its own thread | 0.9455 → 0.8920 s; warm-up loss 70 → 30 ms per worker | Retain |
| `>> 1` midpoint instead of `/ 2` (removes deopt and recompile) | Neutral with background compilation; 0.8894 → 0.8784 s with the flags above | Retain |
| `--invocation-count-for-turbofan=1000` / OSR 100 / `--always-sparkplug` / default pool | 1.0317 / 0.8855 / 0.8856 / 0.8839 vs 0.8854 s | Reject |
| Inlining budgets 1000/2500, 1000/1800, defaults | 0.8834 / 0.9671 / 1.0552 vs 0.8828 s | Keep 1000/4000 |
| `--min-inlining-frequency` 0.3 / 0.6 / 0.95 / 100 / 1000 | Frequencies are per-invocation counts (hot calls ~4,700, `find` ~409); no gain | Reject |
| Chunks 64K / 256K / 512K | 0.8866 / 0.8815 / 0.9408 vs 128K 0.8711 s | Keep 128 KiB |
| Tail word ends with the delimiter, replacing the delimiter load, with a `length < 8` middle branch | 0.9443 vs 0.8788 s, 0/15 | Reject: name lengths make the branch unpredictable |
| Same, branch-free middle word at `min(4, length - 3)` | 0.8773 → 0.8692 s, 10/11 | Retain |
| Prediction misses fall back to the other three slots of an aligned group | Full misses 420K → 141K per 14.5M rows, but 0.9089 vs 0.8742 s | Reject |
| Shifts instead of `* 8`; load the arena offset only inside the long-name loop | 0.8750 → 0.8631 s, 11/11 | Retain |
| Inline the temperature table; truncate the branchless negate | 0.8612 → 0.8468 s, 11/11 | Retain |
| Verification words stored beside each prediction | 0.8538 vs 0.8468 s, 0/11 | Reject, as before |
| Confirmation: previous retained version vs this round via `run.sh` | 0.9475 → 0.8497 s, **−10.3%, 21/21 wins** | Combined result |
| Original `main`, direct launch, vs this round via `run.sh` | 1.0429 → 0.8506 s, −18.4%, 11/11 | Cumulative |

Prediction misses come from three-byte names (`Jos`, `Wau`, never cached),
shared five-byte prefixes (`San J`, `Port `, `Alexa`, `Lake `) and two slot
collisions, about 2.9% of rows. Remaining warm-up is about 23 ms per worker,
mostly one 11 ms synchronous compilation of a graph that also inlines the cold
lookup and insertion paths. All 57 tests pass on Node 24.15.0 and 26.12.0, and
billion-row output matches on both.

### Retained: presized descriptor table and packed Node scan results, 2026-10-21

Startup instrumentation showed Wasm workers reaching their first chunk 58–100 ms
after launch. Under `strace`, descriptor-creating calls in booting workers took
milliseconds (`epoll_create1` averaged 5.5 ms) because each growth of a threaded
process's descriptor table waits for an RCU grace period; 141 descriptors at 24
workers force two growths. Opening 500 descriptors from JavaScript alone took
37–56 ms. Holding descriptor 1023 across `exec` sizes the table before Node
starts any thread. All timings below include process startup; `multi`/paired
runs alternate order, Node 26.12.0, 24 workers, three-run trimmed means.

| Experiment | Measured result | Decision |
| --- | --- | --- |
| Descriptor 1023 held across `exec` | Wasm 0.4827 → 0.4638 s, 15/15 wins; Node 1.0383 → 1.0149 s, 13/15 | Retain in `run.sh` and the benchmark runner |
| `--min-semi-space-size=16` (main-thread 21 ms startup scavenge) | Spawn loop 28 → 4 ms, but end-to-end 0.4660 vs 0.4687 s, 4/11 wins | Reject |
| `UV_USE_IO_URING=0` | 0.4646 vs 0.4670 s, 4/11 wins | Reject |
| Wasm chunks 128K / 256K / 384K / 1M with presized table | 0.4696 / 0.4665 / 0.4665 / 0.4673 vs 512K 0.4638 s | Keep 512 KiB |
| `--no-memory-pool`, `--no-memory-pool-share-memory-on-teardown` | 0.4733 / 0.4708 vs 0.4631 s | Reject |
| Indexed merge loop without destructuring | Merge 5–7 → 2.5–4.5 ms, end-to-end 0.4652 vs 0.4647 s | Reject: overlaps worker teardown |
| WASI `proc_exit` after output, waiting for worker exits | Correct in 600 stress runs, but 0.4650 vs 0.4660 s; `exit_group` still spends ~17 ms freeing ~320 MB RSS | Reject; exiting before workers finish teardown aborts |
| Node: return ID and temperature offset packed instead of via `Int32Array(2)` | 1.0170 → 0.9608 s | Retain |
| Node: branchless sign on top | 0.9632 → 0.9472 s | Retain |
| Node: prediction cache stores packed result | 0.9623 vs 0.9632 s | Reject |
| Node: three lanes on top | 0.9654 vs 0.9524 s | Reject |
| Node: CR skip from LF/CR parity | 0.9540 vs 0.9438 s | Reject |
| Node packed result + branchless sign, confirmation | 1.0221 → 0.9507 s, **−7.0%, 21/21 wins** | Retain |
| End-to-end, original direct launch vs new `run.sh` | Wasm 0.4857 → 0.4705 s, 14/15; Node 1.0336 → 0.9588 s, 15/15 | Combined result |

A no-op parser with the same reads and startup takes about 0.36 s at 24 workers
(0.32 s at 12, with 6 s of system time copying), so Wasm parsing now adds roughly
0.1 s above the read path. All 57 tests pass on Node 24.15.0 and 26.12.0.

### Retained: integer Node loops and background pool, 2026-10-21

| Experiment | Checkpoint(s) | Measured result / decision |
| --- | --- | --- |
| Wasm hash-addressed short-key side table | `ae7fdf1` | 0.466 → 0.483 s; reject, 0/9 wins |
| Same table, earlier bucket load | `25d7c6b` | 0.473 → 0.480 s; reject, 3/9 wins |
| V8 pool sizes 2 and 8 | `0fd4e2a`, `a2af382` | Pool 2 regresses; pool 8 gains 1.38% independently on baseline, 17/21 wins |
| Earlier TurboFan / OSR thresholds | `6ca732e` | TurboFan 1,000 ties; OSR 100 regresses 2.75%; retain normal thresholds |
| Smaller dedicated two-lane entry | `915d3f1` | Bytecode 693 → 170 bytes, but new floating-point conversion guards; 1.087 → 1.099 s, reject |
| Dedicated entry with integer cursors | `87fe74d` | Guards removed; 1.22% in confirmation, 16/21 wins; superseded |
| Eight-byte Node predictor with exact head | `0e186a5` | 1.076 → 1.096 s; reject despite removing both dependent head loads |
| Integer cursors in original entry | `2ae08e2` | Initial 1.77% gain; captured-limit checks remain; superseded |
| Local integer limits and cursors | `cf9bf9b` | First screen gains 4.78%, 9/9 wins; later source-only gain is smaller |
| Local integer version plus V8 pool 8 | `3e59970` | 5.12% in three-case confirmation, 21/21 wins; **4.97% final pairwise gain, 21/21 wins** |

### Previous: two measured improvements from the profile targets, 2026-10-21

| Checkpoint | Experiment / confirmation | Matched result and decision |
| --- | --- | --- |
| `266d94c`, `791de51` | Node packed prediction; native-code evidence and nine rounds | 1.069 vs 1.089 s; 9/9 wins. |
| `becfb15`, `62b0302` | Wasm range specialization; nine rounds | 0.476 vs 0.477 s; inconclusive initial result. |
| `b6a3e22`, `431757d` | Wasm key-load staging; native-code evidence and nine rounds | 0.481 vs 0.481 s; no clear gain. |
| `431757d` | Independent nine-round Node confirmation | 1.077 vs 1.084 s; noisier, so extended to 21 rounds. |
| `431757d`, `654b0d4` | Three-case Wasm confirmation, 21 rounds | Range 0.472, original 0.486, staging 0.487 s. Range wins 20/21; staging rejected. |
| `654b0d4` | Final two-case confirmations, 21 rounds per engine | Node 1.36% and Wasm 2.09% less time; retain both. Wasm's pairwise check also removes the fixed-middle-position concern from the three-case batch. |

### Previous: profile-guided Node sum updates, 2026-10-20

| Checkpoint | Profile-driven experiment | Matched result / decision |
| --- | --- | --- |
| `d015c5c` | Profile both current engines before selecting changes | Baseline observations and reproducibility plan. |
| `ee8bb70` | Short-key XOR plus vector zero test | V8 materialized a Boolean, expanding five native instructions to seven. 0.492 vs 0.481 s in nine rounds; reject. |
| `f50d16b` | Combine long-key equality vectors before one movemask | Removed one native instruction, but 0.484 vs 0.483 s in nine rounds; reject. |
| `cde72aa` | Disable additive-safe-integer feedback as a diagnostic control | Baseline Node 1.190 s, control 1.079 s, half-offset source 1.121 s in the same nine-round batch. |
| `b216096` | Exact half-offset Node sums | Removes the measured conversion checks; retain after correctness and repeated full-machine gains. |
| `ad3ec02` | Profile control versus source fix with all 24 workers | Similar hot code; tier availability differs, but cause of remaining timing gap is unresolved. |
| `c60feda` | Confirm selected Node and retained Wasm | Final 1.144 → 1.086 s Node pair; Wasm 0.482 s. |

### Previous: Wasm hint and attribute experiments, 2026-10-20

| Checkpoint | Experiment | Result and decision |
| --- | --- | --- |
| `4fa66a4` | Existing hints, V8 inlining controls | Baseline 0.491 s; ignore hints 0.513, disable inlining 0.498, larger inline limit 0.506. Retain defaults. |
| `423f1f7` | Hint cold paths only, leave loop backedges neutral | 0.488 vs 0.486 s; reject. |
| `b635eb8` | Emit hints only for `parse_chunk` | 0.491 vs 0.486 s; reject. |
| `c1a197d` | Leave long-name calls neutral in branch metadata | 0.507 vs 0.486 s; reject. |
| `6c1ed11`, `69fa2eb` | Explicit likely/unlikely branches; `hot` parser attribute | Exact same Wasm as baseline; reject ineffective additions. |
| `b95aa4b` | Force-inline long-name handler | 0.484 vs 0.486 s initially, then 0.488 vs 0.488 s; reject. |
| `97b8845` | Two-way loop unrolling | 0.482 vs 0.486 s initially; later 0.493 vs 0.494 s. Four-way is the stronger candidate. |
| `57925d2`, `a760ba8` | Targeted eager optimization of parser | Stalled on second warm-up; terminated and excluded. Remaining hint screen rerun. |
| `dc8d14f` | `minsize` on cold helpers | 0.491 vs 0.488 s; reject. |
| `3e1af90` | Let Clang choose helper inlining | 0.489 vs 0.488 s; reject despite smaller 7,615-byte module. |
| `50f9ebc` | Explicitly disable inner-loop unrolling | Exact same Wasm as baseline; reject ineffective addition. |
| `bbef50b` | Four-way loop unrolling | 0.481 vs 0.488 s screen; 0.491 vs 0.494 s nine-run confirmation; 0.485 vs 0.488 s final paired repeat. Retain with small-gain caveat. |
| `27f8619` | Combine inlined long path and two-way unrolling | 0.487 vs 0.488 s, 19,462-byte module; reject. |
| `c41ba08` | Eight-way loop unrolling | 0.493 vs 0.494 s in confirmation; reject in favor of four-way's smaller/faster module. |
| `152eb0f`, `5e0f5cf`, `e5d5358`, `5268948` | Refinement, pinned-core diagnostic, nine-round and 21-round confirmations | Preserve each comparison configuration. |

### Previous: direct Wasm deltas and simpler Node prediction, 2026-10-20

| Checkpoints | Experiment | Matched result and disposition |
| --- | --- | --- |
| `bd764ea` | Preserve the round-one result before new experiments | Baseline runtime is `5769105`; empty checkpoint records the starting point. |
| `f8aa946` | Node lane count, temperature decoding, equality mode, table size, V8 inlining | Baseline 1.163; one/three/four lanes 1.178/1.234/1.293; compact/arithmetic temperatures 1.178/1.167; branchy equality 1.241; 14/16-bit tables 1.176/1.164; larger inlining budget 1.203. Keep existing settings. |
| `f7cdb99` | Read-only throughput diagnostic using the existing reader | Original reader: 0.337 at 12 workers and 0.363 at 24; batched reader: 0.342/0.373. Diagnostic retained; these measure one IO path without parsing, **not a theoretical bound**, and cannot be subtracted from solver time to isolate parsing cost. |
| `fd50916`, `a4b6d97` | WASM negated maximum; independent fallback for long names in each lane | Individually 0.508/0.507 vs shipped 0.506 and rebuilt Clang 21 control 0.517. No isolated win over shipped binary; combined and re-evaluated later. |
| `d3e89f0`, `cd9205a`, `c8e01ed` | Node grouped equality; decode temperatures before updates; pipeline next group | 1.190/1.211/1.202 vs 1.165. Rejected. |
| `6982b37` | WASM arithmetic combination of delimiter-presence checks | 0.522 vs shipped 0.506 / Clang 21 control 0.517. Rejected. |
| `c0d9600` | Claim sixteen WASM input chunks per atomic operation | 0.504 vs shipped 0.506; negligible solver difference, with no read-only improvement in a separate diagnostic. Rejected. |
| `ebb172a`, `89f8830` | Node fused Float64 statistics; colocated predictor metadata | 1.205/1.203 vs 1.167. Rejected. |
| `a5f6893`, `f7008a3` | WASM aligned 48-byte / 64-byte station records | 0.508/0.512 vs Clang 21 control 0.508 (shipped 0.511). No useful gain; rejected. |
| `2eed87d`, `33a1564` | Node two-way predictor, 64 KiB / 128 KiB | 1.209/1.200 vs 1.167. Rejected. |
| `54cd77f` | Node eight-byte UTF-8 name equality through Float64 loads | Correct but 1.379 vs 1.167. Rejected. |
| `1fc923c` | Combine WASM negated maximum and independent long-name fallback | Initially 0.493 vs shipped 0.511; repeat 0.503 vs 0.509 and later 0.504 vs 0.501. Isolated multicore gain was not stable. Retained as a base for subsequent combined candidates. |
| `1136725`, `393e5c8` | Node cheaper prefix hash; shifted-fifth-byte alternative | First screen 1.177/1.180 vs 1.171; later simple-hash confirmations 1.152 vs 1.175 and 1.156 vs 1.168 (wins eight of nine rounds). Select the simple XOR/multiply hash; reject shifted alternative. |
| `1d06e80` | Node macro queue, async IO, private file descriptors; repeat combined WASM | Node 1.177/1.821/1.193 vs 1.171: reject IO changes. Combined WASM 0.503 at 24 workers / 0.491 at 12 vs baseline 0.509; later worker-count results differ. |
| `74149ef`, `992e8b8` | WASM folded SIMD mask addresses, alone and with combined lane changes | Folded baseline 0.512; folded combined 0.502 at 24 workers / 0.495 at 12 vs shipped 0.501 at 24 / 0.508 at 12. Small/noisy whole-process differences; folded addresses retained for later direct-table candidates. |
| `bdd0a18` | Seven-run confirmation of folded WASM loads and worker counts | Captures the matched repeat above, including simple Node hash. No broad, stable isolated WASM gain established by this batch. |
| `13cb56b`, `8349896` | Advance WASM rows from temperature width; isolate kernels on one CPU | One-core mean: shipped 4.349, folded combined 4.248, temperature advance 6.432. Reject temperature advance; retain newline scan. `8349896` also checkpoints the confirmed simple Node hash. These one-core timings do not predict the multicore gain directly. |
| `805a1c8` | Direct 1 MiB WASM temperature-to-SIMD-delta table, eliminating a dependent lookup | 0.483 vs shipped 0.496 / folded combined 0.501; repeat 0.487 vs shipped 0.503. Retained with three lanes and the existing worker default. |
| `fdc9c79` | Pack direct WASM deltas into a 128 KiB table | 0.502 vs direct 1 MiB 0.487 / shipped 0.503. Extra index work loses the direct-table gain; rejected. |
| `9124f4e`, `b7bf73a`, `7d1e99c` | Direct-table WASM with two/four lanes; rescreen 12/16/24 workers | Lane screen: two 0.488, three 0.491, four 0.497. Worker sweep: three lanes 0.501/0.489/0.493; two lanes 0.514/0.498/0.495. Four lanes rejected; two-lane and worker-count advantages did not repeat consistently. Retain three lanes and the existing worker default. |

### Previous: further Node optimization and Wasm trials, 2026-10-20

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

### Historical Wasm result: eleventh round, 2026-10-19

| Report | Previous winner | Checkpoints |
| --- | ---: | --- |
| `s1-wide1` | 0.977 s | two-vector fallback 0.918 s |
| `s2-nl3a` | 0.994 s | fallback with hints 0.927 s; newline advance 0.911 s |
| `s3-inl1` | 1.002 s | newline advance 0.909 s; inlined fallback 0.882 s |
| `s4-cst2` | 0.997 s | inlined fallback 0.876 s; loaded constants 0.861 s |

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

### Previous audit: learned station caches rejected, 2026-10-19

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

### Previous audit: delimiter checks and SIMD masks, 2026-10-19

| Checkpoint | Attempt | First comparison | Repeat comparison | Decision |
| --- | --- | ---: | ---: | --- |
| `6ed6938` | Previous winner | **1.030 s** | **1.028 s** | Retained |
| `cf4823e` | Combine three bounded delimiter checks | 1.068 s | 1.062 s | Rejected |
| `2a2ef3d` | Generate short-name masks in SIMD | 1.078 s | — | Rejected |
| `3805465` | Combine both changes | 1.104 s | — | Rejected |
| `3a51989` | Refine masks to one signed SIMD comparison | — | 1.065 s | Rejected |

### Previous result: SIMD hash mixing, 2026-10-19

| Checkpoint | Attempt | First comparison | Second comparison | Decision |
| --- | --- | ---: | ---: | --- |
| `8a269ca` | Previous winner | 1.056 s | 1.047 s | Baseline |
| `19c2645` | SIMD short-name hash mixing | **1.034 s** | **1.027 s** | Selected |
| `80c5511` | Place the cached key beside statistics in each 40-byte record | 1.052 s | — | Rejected: no clear gain |
| `af7f5c3` | Combine hash mixing and adjacent keys | 1.035 s | 1.029 s | Rejected: no improvement over hash mixing alone |

### Previous audit: previous winner retained, 2026-10-19

| Checkpoint | Attempt | Previous winner | Candidate | Decision |
| --- | --- | ---: | ---: | --- |
| `d192e4e` | Per-lane long-name fallback | 1.026 s | 1.072 s | Rejected |
| `14d3ab9` | Stage bucket-pointer loads before updates | 1.026 s | 1.039 s | Rejected |
| `6ceef78` | Also preload the cached SIMD keys | 1.034 s | 1.043 s | Rejected |
| `19931bb` | Specialize short lanes only inside mixed triples | 1.034 s | 1.048 s | Rejected |

| Checkpoint | Chunk size | Matched trimmed mean |
| --- | --- | ---: |
| `1e6456b` | 128 KiB | 1.073 s |
| `d9a0525` | 256 KiB | 1.053 s |
| `93e3372` | **512 KiB** | **1.043 s** |
| `5b5b018` | 1 MiB | 1.056 s |
| `3d1f8d5` | 2 MiB | 1.090 s |

### Previous result: delimiter-encoded SIMD keys, 2026-10-19

| Commit | Attempt and matched result | Decision |
| --- | --- | --- |
| `3039a16` | Reuse SIMD name bytes: 1.213 → 1.072 s | Retained and refined |
| `d02123f` | Encode the delimiter in the SIMD key: 1.044 s versus 1.072 s vector reuse alone | Retained |
| `583395f` | Direct 32-byte hash slots with separate metadata: 1.067 s versus 1.046 s pointer table | Rejected |
| `612f268` | Two SIMD-key lanes: 1.144 s versus 1.056 s three lanes | Rejected |
| `3d43317` | Four SIMD-key lanes: 1.094 s versus 1.056 s three lanes | Rejected |
| `ef9afe7` | Complemented maxima for one SIMD min: 1.054 s versus 1.049 s ordinary extrema | Rejected |
| `bbf5de2` | Shared empty record: 1.045 s versus 1.049 s ordinary empty checks; confirmed 1.047 versus 1.056 s in final seven rounds | Selected |

### Previous round: short-name path and lookup scheduling, 2026-10-19

| Commit | Attempt and matched result | Decision |
| --- | --- | --- |
| `e261689` | Consume each lookup immediately after scanning: 1.253 → 1.244 s | Refined in the short-name path |
| `7d44ddb` | Revisit four compact lanes: 1.308 s versus 1.253 s previous winner | Rejected |
| `fb737ce` | Three-row short-name path: 1.253 → 1.222 s | Retained |
| `c65e8c0` | Add immediate updates: 1.215 s versus 1.222 s staged lookups | Refined below; isolated advantage varied |
| `a4ea36e` | SIMD cached head/tail comparison: 1.238 s versus 1.222 s scalar checks | Rejected |
| `f7121b7` | Fully stage the general fallback: 1.231 s versus 1.240 s immediate updates alone, final seven rounds | Selected |

### Previous round: bounded parser and paired hashing, 2026-10-19

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

### Previous round: three-stage pipeline, 2026-10-19

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

### Previous round: branchless solver, 2026-10-19

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

### Rejected experiments

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

## Archived evidence

The current tree contains only the selected code and this document. Git checkpoint
**`8a52271`** retains the complete V8 research directory, all independent patches,
source/build identities, raw paired measurements, disassembly, audits and scripts.
Checkpoint **`351f07f`** also retains the full solver experiment archive. Every
experiment has unsigned checkpoints. Nothing has been published upstream.

```sh
git show 8a52271:v8-research/README.md
git show 8a52271:v8-research/escape-cost/README.md
git show 351f07f:BENCHMARKS.md
git worktree add --detach /tmp/1brc-research-history 8a52271
```

The ignored local `results/v8-general/` workspace retains the pinned V8 checkout,
preserved builds and original profiles for continued research. It is not part of
the repository content a reviewer clones. The current patch preserves the selected
production changes and their semantic regression tests; historical experiments
can be recovered from the checkpoints without adding runtime variants here.
