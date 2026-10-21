# General V8 compiler experiments

This investigation targets current upstream V8, independently of the 1BRC solvers.

## Experiment 1: inline ArrayBuffer.prototype.byteLength

On V8 15.8.0 candidate at `293377af9f02c268362e5975b7af4baa25688323`, the ordinary ArrayBuffer length getter has no JSCallReducer reduction. The unchanged official DataView typed-array benchmarks call it in their inner loops. Sampling attributed 780 of 19,796 ticks (3.9%) directly to the getter; optimized disassembly confirmed the calls.

The patch adds a mutable, sandbox-aware UintPtr field load after receiver validation and a shared-bit check. The shared case calls the original getter through V8’s CallFunction trampoline, preserving its exception and realm without a speculative deoptimization loop. Resizing and detachment update the loaded field. No benchmark, station name, input size, or 1BRC-specific behavior is encoded in V8.

With identical diagnostic flags on both binaries, the optimized `doOneFloatIterationJS` body shrank from 1,100 to 768 bytes; its two getter call sites disappeared. The earlier sampling capture emitted a later 1,172-byte baseline version; matching the tracing configuration avoids conflating different compilation histories. Native code shows fewer call-related spills and number conversions. Static pointer-load counts also decrease, but different loop peeling contributes: loads remain in the loop, so this is not evidence of full invariant-load hoisting.

## Official benchmark measurements

AMD Ryzen 9 7900, Linux x64. Identical pinned toolchain/build options. One warmup per binary, then 21 alternating AB/BA pairs in fresh processes pinned to CPU 2. Stock d8 defaults, no profiling/tuning flags, unchanged `test/js-perf-test/DataView/run.js` and dependencies. Sources and binaries are hashed before/after. Scores are higher-is-better. Intervals use 10,000 bootstrap resamples of paired log score ratios.

| Official DataView test | Baseline median score | Candidate median score | Paired score change | 95% interval | Wins |
|---|---:|---:|---:|---:|---:|
| DataView-BigEndian | 5,090 | 5,080 | -0.03% | -0.33% to +0.30% | 8/21 |
| DataView-Floats | 2,463 | 2,468 | +0.44% | +0.09% to +0.92% | 14/21 |
| DataView-LittleEndian | 5,850 | 5,854 | +0.25% | -0.14% to +0.72% | 11/21 |
| TypedArray-BigEndian | 1,375 | 1,813 | +31.51% | +31.22% to +31.79% | 21/21 |
| TypedArray-Floats | 1,648 | 2,200 | +33.43% | +32.92% to +34.09% | 21/21 |
| TypedArray-LittleEndian | 937 | 1,100 | +17.49% | +17.28% to +17.72% | 21/21 |

The geometric mean across these six tests improves 12.94%. This is a result for this specific official microbenchmark group, not an overall V8, JetStream, Speedometer, or browser-performance claim. The three original DataView cases act as nearby controls; their sub-percent movements are not attributed to this reduction.

Raw paired results: [dataview-results.json](dataview-results.json). Profiling/build evidence: [baseline-evidence.json](baseline-evidence.json). Native code: [before](codegen/before.txt), [after](codegen/after.txt). Selected compiler IR: [ir-evidence.json](codegen/ir-evidence.json).


Two further unchanged official controls ran for 11 alternating pairs with the same binaries and affinity. No control establishes a repeatable regression; all intervals include zero. The large Var-loop interval reflects an outlier retained in the raw results. These controls do not rule out regressions in unmeasured workloads.

| Control | Paired score change | 95% interval |
|---|---:|---:|
| Let-Standard-ForLoop | -0.16% | -0.57% to +0.15% |
| Var-Standard-ForLoop | +3.19% | -0.40% to +10.31% |
| TypedArrays-ConstructWithBuffer | -0.29% | -1.14% to +0.28% |

Raw controls: [ForLoops](forloops-results.json), [TypedArrays/ConstructWithBuffer](typedarray-construct-results.json).

## Patch and regression coverage

Apply [array-buffer-byte-length.patch](array-buffer-byte-length.patch) with `git am` on the exact upstream base above. Local upstream commits are `3eb4f01c` and `f090ad58`; both are unsigned. The production Node/Wasm implementations continue using stock Node.

The new semantic regression covers normal/zero lengths, detached and resizable buffers, mutation across opaque calls, mixed ordinary/shared receiver feedback, invalid borrowed-getter receivers, replaced inherited getters, and foreign-realm exceptions. It passes on baseline too: it verifies preserved semantics, while the IR/native evidence verifies the performance transformation. The new test plus 21 existing related mjsunit scripts passed, including tests skipped by default during V8’s frontend transition (`--run-skipped`). Foreign-realm coverage was added and separately passed afterward.

This is a locally validated upstream candidate. Multi-platform, sanitizer, and full-suite validation remain appropriate before submission. No upstream review or publication has occurred.

## Reproduction

The ignored working area is `results/v8-general/`. It contains the pinned upstream checkout, depot_tools, build logs, raw profiles, and preserved baseline/candidate output directories. Set up V8 dependencies with its normal `gclient sync` workflow at the recorded revision, then generate both builds with:

```text
is_debug=false target_cpu="x64" v8_target_cpu="x64" v8_enable_disassembler=true v8_enable_object_print=true symbol_level=1 use_remoteexec=false use_siso=false
```

Build `d8` with the pinned ninja/Clang toolchain. Preserve the baseline before applying patches. From this repository:

```sh
python3 v8-research/paired_benchmark.py \
  --baseline results/v8-general/v8/out/x64.release-baseline/d8 \
  --candidate results/v8-general/v8/out/x64.release-byte-length/d8 \
  --cwd results/v8-general/v8/test/js-perf-test/DataView \
  --rounds 21 --output v8-research/dataview-results.json
```

V8 registers these unchanged tests in `test/js-perf-test/JSTests5.json`. Its official `tools/run_perf.py` runner also executed the candidate successfully: six test scores plus the group total, with no errors ([output](official-run-perf-byte-length.json)). Use the pinned `vpython3` environment and `--filter=JSTests/DataView` (no trailing slash). The official testing documentation describes `tools/run_perf.py`: https://v8.dev/docs/test.

## Experiment 2: fold bitcasts into numeric stores

Current baseline `makeFloatBuffer` disassembly contains `bswap → vmovd/q GPR-to-XMM → vmovss/sd store`. An independent general store-of-bitcast experiment removed all three extra register transfers and reduced the function from 1,052 to 1,032 bytes. It preserves same-width bits and store metadata; atomic, trapping and incompatible-alignment accesses are excluded.

**Rejected on this machine:** the same 21-pair protocol showed lower scores in both floating-point tests, with zero wins in either. Fewer instructions did not yield a speedup. The cause of the regression has not been isolated; no microarchitectural explanation is assumed.

| Official DataView test | Paired score change | 95% interval | Wins |
|---|---:|---:|---:|
| DataView-BigEndian | +0.02% | -0.15% to +0.20% | 12/21 |
| DataView-Floats | -4.06% | -4.36% to -3.66% | 0/21 |
| DataView-LittleEndian | +0.09% | -0.10% to +0.32% | 11/21 |
| TypedArray-BigEndian | -0.02% | -0.13% to +0.09% | 6/21 |
| TypedArray-Floats | -2.56% | -2.73% to -2.37% | 0/21 |
| TypedArray-LittleEndian | +0.04% | -0.06% to +0.14% | 10/21 |

The six-test geometric mean fell 1.09%. The branch is based directly on the same untouched upstream revision, independently of the getter patch. Its 39 compiler unit tests (including three new graph tests) and 12 semantic mjsunit scripts passed. New Wasm coverage checks exact signed-zero, subnormal, infinity and NaN payload bits, unaligned accesses, and explicit out-of-bounds traps. These passing semantic checks do not override the performance result.

The rejected experiment is retained in [store-bitcast.patch](store-bitcast.patch), [raw results](store-bitcast-results.json), [validation evidence](store-bitcast-evidence.json), and native excerpts [before](codegen/store-before.txt) / [after](codegen/store-after.txt). Local upstream checkpoints are `f2ab8d37` and `be68467f`; the original isolated source draft is `7abc6b4`. Do not stack this patch onto the recommended getter change based on these results.

The local unit-test launcher initially rejected a direct multi-test invocation because current V8 requires a fresh process per test. `tools/run-tests.py` provided the supported isolation and all 39 selected tests passed.

## Follow-up experiments

The [fresh profiling investigation](next-targets/README.md) records three samples of the winning build (58,888 ticks), native code and compiler IR. It identifies redundant polymorphic dispatch, terminal exception paths that block loop peeling, and removable integer checks. The report distinguishes proven compiler gaps from unmeasured performance gains and ranks the next experiments. Hardware perf counters were unavailable; the evidence uses V8's sampling profiler.

Those targets were implemented as independent experiments, each starting from the earlier getter winner `f090ad58`. The numbers below are **incremental to that winner**, using the same unchanged official DataView benchmark and 21 alternating pairs. Every experiment has unsigned source checkpoints, a preserved binary, a tracked patch, native/IR evidence and all raw measurements. Rejected and neutral experiments remain available.

| Experiment | Evidence and outcome | Disposition |
|---|---|---|
| Signed-shift range proof | Removes two overflow branches; hot float function 2,368 → 2,344 bytes. Every score interval includes zero. | Neutral; excluded from combined candidate. |
| Constant-Phi expression proof | Tracks Phi dependence across the whole expression and accepts constant operands outside the merge block. Matched native diagnostics retain the integer dispatch until the cloning budget is also fixed. | Prerequisite for the next experiment. |
| Bounded dispatch cloning | Counts executable operations separately from Phi/FrameState metadata, retaining a total-storage cap and the Wasm deopt restriction. Hot integer function 3,296 → 3,080 bytes; TypedArray LittleEndian **+12.53%**, DataView LittleEndian **+3.24%**. | Included in combined candidate. |
| Dominating zero-mask guards | Removes `i & 3` after a successful `i & 7` guard; hot float function 2,368 → 2,352 bytes. Every score interval includes zero. | Neutral; excluded from combined candidate. |
| Terminal-path loop peeling | Safely copies bounded throwing side paths and their frame states. Monomorphic loop field loads 8 → 0; polymorphic loads 66 → 64. TypedArray BigEndian **+29.74%**, LittleEndian **+5.96%**, Floats **+3.95%**. | Included in combined candidate; measured compilation/code-size costs below. |

The small independent peeling regression in DataView BigEndian is retained: **−0.26%**, interval **−0.47% to −0.06%**. Its matched native function size is unchanged; no cause is assigned. The other two DataView intervals include zero. The helper-only experiment's sub-percent positive movements are also retained without treating them as evidence that the primary dispatch target was removed. Its float result differs substantially by AB/BA order.

Peeling increases native code: monomorphic integer 1,844 → 2,348 bytes and polymorphic integer 3,296 → 5,116 bytes. Native inspection confirms cached metadata in the monomorphic loop; the polymorphic loop still performs reader-map dispatch and most metadata loads. This is not a claim of complete invariant-load hoisting.

Correctness checks passed for each independent candidate: 44 selected tests for shift ranges, 20 for full dispatch cloning, 29 for masks, and 37 for terminal peeling. Mask tests cover dominance, merges, cloning, loop boundaries, JS and Wasm deoptimization; a separate trace confirms actual OSR entry. Peeling tests include direct and transitive dependencies on shared loop exits, external control, nested loops, frame/effect remapping, bounds on graph growth, detached/resizable buffers, and exceptions. Initial draft issues and test corrections are preserved in the unsigned checkpoint history.

The combined dispatch/peeling candidate is `fcc58178`, with 56 selected checks passing. Its polymorphic integer function is 4,584 bytes, and the redundant method constants are absent. The combined 21-pair result improves the six-case geometric mean **8.94%** over the getter winner (paired 95% interval **8.81–9.11%**).

| Official DataView test | Combined score change | 95% interval | Wins |
|---|---:|---:|---:|
| DataView-BigEndian | +0.35% | +0.17% to +0.52% | 14/21 |
| DataView-Floats | +0.03% | −0.14% to +0.20% | 9/21 |
| DataView-LittleEndian | +3.30% | +3.21% to +3.38% | 21/21 |
| TypedArray-BigEndian | +29.84% | +29.48% to +30.27% | 21/21 |
| TypedArray-Floats | +4.68% | +4.17% to +5.35% | 21/21 |
| TypedArray-LittleEndian | +18.62% | +18.47% to +18.80% | 21/21 |

Raw combined measurements: [winning-followups-results.json](followups/winning-followups-results.json). These are local results for this specific official microbenchmark group, not a whole-V8 or browser-performance claim. The combined binary is separately preserved as `out/x64.release-winning-followups/d8`. V8's official `tools/run_perf.py` also completed this candidate with all six scores plus the group total and no errors ([output](followups/official-run-perf-winning.json)); that single run validates the official registration and is not the paired speedup evidence.

Three unchanged official controls ran for **12 fixed alternating pairs each**, with the same CPU affinity and binaries. Five Compiler cases show small regressions with intervals excluding zero. Both loop-control intervals include zero; typed-array construction improves slightly. These controls have limited coverage and do not isolate which change causes the compilation regressions.

| Official control | Score change | 95% interval |
|---|---:|---:|
| Compiler / Small-Empty | −0.38% | −1.30% to +0.54% |
| Compiler / Small-Constant | −0.30% | −1.22% to +0.63% |
| Compiler / Small-Add | **−0.96%** | −1.65% to −0.23% |
| Compiler / Small-Load | −0.30% | −1.35% to +0.84% |
| Compiler / Medium-Copy | **−0.76%** | −0.89% to −0.63% |
| Compiler / Medium-Fact | **−0.72%** | −1.37% to −0.04% |
| Compiler / Medium-Prime | **−0.63%** | −1.17% to −0.07% |
| Compiler / Medium-Eratosthenes | **−0.92%** | −1.19% to −0.60% |
| Compiler / Large-Copy | −0.08% | −0.29% to +0.13% |
| ForLoops / Let | +0.23% | −0.01% to +0.53% |
| ForLoops / Var | +0.20% | −0.36% to +0.73% |
| TypedArrays / ConstructWithBuffer | +0.24% | +0.15% to +0.33% |

Raw controls: [Compiler](followups/winning-compiler-results.json), [ForLoops](followups/winning-forloops-results.json), [construction](followups/winning-typedarray-construct-results.json). The first constructor invocation omitted d8's `--` argument separator and failed during warmup, before any measured pair. Its [failed record](followups/winning-typedarray-construct-failed-command.json) is preserved; the corrected command completed the full declared run.

A separate **six-pair compilation diagnostic** ran the unchanged DataView suite with `--no-concurrent-recompilation --turbo-stats --turbo-stats-nvp --trace-opt`. Every measured process completed 25 TurboFan compilations, including two normal compilations of `doOneIterationJS`, with no target OSR compilation or traced abort. Positive changes in the next table mean **more compilation cost**, not higher benchmark scores.

| Diagnostic | Baseline median | Candidate median | Paired cost change | 95% interval |
|---|---:|---:|---:|---:|
| Total compiler pipeline time | 18.00 ms | 19.78 ms | **+12.37%** | +9.20% to +17.76% |
| Total compiler-zone allocation | 16,815,400 bytes | 18,813,440 bytes | **+11.88%** | +11.88% to +11.88% |
| Loop-peeling phase time | 0.487 ms | 0.604 ms | +24.62% | +23.01% to +26.73% |
| Loop-peeling zone allocation | 679,760 bytes | 991,280 bytes | +45.83% | +45.83% to +45.83% |
| Two integer-target compilations, summed | 2.665 ms | 3.784 ms | **+42.15%** | +41.38% to +43.17% |

Zone allocation is cumulative compiler allocation, not process RSS. Target times sum preparation, execution and finalization across both compilations. The paired percentage is not the ratio of the displayed medians. Instrumented benchmark scores are excluded from throughput claims. Detailed precision, counts and AB/BA results are in the [compilation summary](followups/winning-compile-cost-summary.json), with all [raw diagnostics](followups/winning-compile-cost-results.json) and the [parser](compilation_cost.py).

**Disposition:** retain the combined patch as a measured runtime-performance candidate, with compilation and code-size costs explicitly recorded. The hot polymorphic function grows **39.08%**, from 3,296 to 4,584 bytes. These results justify further upstream work, but do not establish a regression-free or submission-ready change. The next engineering issue is reducing that cost while preserving the proven runtime transformations. No upstream publication has occurred.

The [protocol](followups/plan.json), individual `*-results.json`, `*-evidence.json` and patch series are under [followups](followups/). The combined [patch series](followups/winning-followups.patch) applies on `f090ad58`; do not also apply its overlapping standalone dispatch/peeling patches. Neutral shift/mask patches are independent and are not included in that series.

The [artifact manifest](followups/winning-build-manifest.json) records the preserved builds' source commits, GN arguments, executable, snapshot, ICU data and build-configuration hashes. To reproduce the incremental runtime comparison, use the earlier getter build as `--baseline`, the combined build as `--candidate`, the unchanged `DataView` directory as `--cwd`, and `--rounds 21` with [paired_benchmark.py](paired_benchmark.py). Exact commands, expected score names and source hashes are saved in every raw result. Every source experiment and result stage has an unsigned checkpoint; the production Node/Wasm solvers remain on stock Node.

## Compilation-cost investigation

Compilation cost is the CPU time and memory V8 spends producing optimized machine code. Copying a loop can make that code run faster while making later compiler passes process more nodes. The previous result therefore left two separate questions: can the compiler avoid unnecessary work, and how much of the original graph-growth cost remains afterward?

The [fixed protocol](compile-cost/plan.json) compares each new experiment with the combined runtime candidate `fcc58178`. It uses six alternating compilation-diagnostic pairs, twelve unchanged official Compiler pairs and twenty-one unchanged stock DataView pairs for the candidates receiving full validation. A separate six-pair comparison against the older getter-only `f090ad58` measures the remaining original cost. Builds, tests, profiling and benchmarks run serially; timed processes are pinned to CPU 2. Confidence intervals use paired bootstrap resampling and include every measured pair.

Native compiler profiles were collected before these edits, both for the unchanged official Compiler suite and for repeated compilation of the original DataView integer function. Hardware perf counters remained unavailable, so the evidence uses V8's native sampling profiler, phase statistics and disassembly. Compiler-state filtering excludes other VM states; the denominator is total ticks minus excluded ticks. The [phase evidence](compile-cost/initial-phase-evidence.json) and [native summaries](compile-cost/native-profile-evidence.json) retain both baselines. Phase groups and their child phases overlap and must not be added together.

The official Compiler profile attributed 40,542 of 214,658 included ticks (18.9%) to `LoadElimination::AbstractField::Kill`; 40,531 of its ticks were under Large-Copy's runner. Matching sample PCs to the preserved binary showed that 89.4% of this function's self samples were in the initial dead-node checks and tree iteration. Among alias-check samples that distinguish the paths, 2,387 landed in the existing fresh-allocation identity comparison and 33 in the general alias/map paths. This is evidence of repeated cache scanning when the only possible alias is already known exactly. The [PC analysis](compile-cost/fresh-allocation-pc-evidence.json) records reviewed instruction ranges, input hashes, accounting checks and reproduction commands.

Three independent experiments start from `fcc58178`; their patches must not be assumed to be stacked:

| Experiment | Implementation and evidence | Validation / disposition |
|---|---|---|
| Field-name invalidation, `2e2b333a` | Check both name and object aliasing before constructing a replacement field cache; check the cheap name predicate first. | 81 selected checks passed. Full official results below show modest compiler improvements; retained separately. |
| Outline reduction tracing, `2f98c1e2` | Move cold trace printing to a noinline helper. Native `GraphReducer::Reduce` shrinks from 1,458 to 370 bytes, removing unconditional stream setup; extra stack reservation falls from 328 to 8 bytes. | 52 checks passed; normalized trace-event multisets match, with three independent constant-typing events reordered. Total compilation-time interval includes zero; excluded from the leading candidate. |
| Fresh-allocation lookup, `8944d358` + `87e3481b` | Use the existing Allocate-only alias invariant to look up the exact key in the field map, avoiding a full scan on a miss. | 83 selected checks passed. All fixed benchmarks and the historical cost comparison are complete; retained as the leading compiler-cost candidate. |

The tracing experiment demonstrates why smaller native code is insufficient evidence of a speedup. Its separate cold helper is 930 bytes, and total pipeline time changed **+0.18%**, interval **−1.68% to +2.03%**. Source-position wrappers enabled by profiling also appeared in samples; their overhead was not treated as a stock-benchmark optimization target. The [trace equivalence evidence](compile-cost/trace-equivalence.json), [native/source review](compile-cost/outline-reduction-tracing-evidence.json) and [six-pair cost summary](compile-cost/outline-reduction-tracing-cost-summary.json) preserve the neutral result.

The fresh-allocation path deliberately does not resolve `FinishRegion` or `TypeGuard` aliases before selecting its fast path. Those cases still use the original general logic. Tests cover exact-key invalidation, unrelated cached objects, immutable earlier states, same/disjoint/unknown field names, cache misses and the rename boundary. Native inspection confirms that the miss path makes no calls and performs no replacement-map allocation. All 25 generated DataView functions match the baseline in name and instruction size, including the 2,348-byte and 4,584-byte integer functions. These are size checks, not a claim of byte-identical machine code. See the [patch](compile-cost/fresh-allocation-invalidation.patch), [build/test manifest](compile-cost/fresh-allocation-build-evidence.json), [generated-code evidence](compile-cost/fresh-allocation-native-evidence.json) and [compiler disassembly](compile-cost/fresh-allocation-kill-native.txt).

The short DataView cost diagnostics do not show a large solution to the original overhead. Each process completed 25 TurboFan pipelines, with two normal integer-target compilations and no target OSR compilation or traced abort. Positive numbers below mean more compilation cost.

| Independent candidate vs. `fcc58178` | Total pipeline time change | 95% interval | Integer-target time change | 95% interval |
|---|---:|---:|---:|---:|
| Field-name invalidation | −2.30% | −4.04% to −0.75% | −1.31% | −2.29% to −0.47% |
| Outline reduction tracing | +0.18% | −1.68% to +2.03% | −0.58% | −1.04% to −0.11% |
| Fresh-allocation lookup | −0.81% | −1.97% to +0.30% | −0.63% | −1.27% to −0.13% |

The field-name run also moved several unchanged phases; its whole-suite change cannot be assigned entirely to the edited path. The fresh-allocation total changes sign by AB/BA order (+0.32% / −1.92%). The small target-only improvement is also order-sensitive (−0.09% / −1.18%) and remains exploratory. Its zone-allocation change is negligible (−0.0016%), and loop-peeling allocation stays at 991,280 bytes. These diagnostics are not stock runtime scores. All measurements and order splits are in the individual `*-cost-results.json` and `*-cost-summary.json` files under [compile-cost](compile-cost/).

The completed field-name candidate's official results are below. Compiler uses twelve pairs and stock DataView uses twenty-one. Several Compiler rounds moved together across unrelated cases; all remain in the analysis. DataView's low-scoring nineteenth pair is also retained without assigning an unmeasured cause.

| Official Compiler case | Field-name score change | 95% interval |
|---|---:|---:|
| Small-Empty | +0.75% | -0.46% to +2.12% |
| Small-Constant | +0.67% | -0.55% to +2.04% |
| Small-Add | +0.58% | -0.22% to +1.35% |
| Small-Load | +0.61% | -0.45% to +1.68% |
| Medium-Copy | +0.85% | +0.63% to +1.07% |
| Medium-Fact | +0.79% | +0.10% to +1.57% |
| Medium-Prime | +0.96% | +0.36% to +1.54% |
| Medium-Eratosthenes | +0.72% | +0.28% to +1.16% |
| Large-Copy | +0.29% | +0.04% to +0.55% |

| Official DataView case | Field-name score change | 95% interval |
|---|---:|---:|
| DataView-BigEndian | -0.00% | -0.24% to +0.24% |
| DataView-Floats | -0.51% | -1.81% to +0.37% |
| DataView-LittleEndian | -0.04% | -0.20% to +0.13% |
| TypedArray-BigEndian | +0.05% | -0.09% to +0.21% |
| TypedArray-Floats | -0.13% | -1.46% to +1.06% |
| TypedArray-LittleEndian | +0.01% | -0.11% to +0.15% |

Every field-name runtime interval includes zero. Full raw records are [official Compiler](compile-cost/field-name-compiler-results.json) and [stock DataView](compile-cost/field-name-runtime-results.json). The field-name and tracing experiments are saved separately and are not part of the fresh-allocation binary.

The fresh-allocation candidate completes the same twelve-pair official Compiler comparison with **Large-Copy +34.98%**, interval **+34.59% to +35.36%**, and twelve wins. This corresponds to about **25.92% less time per benchmark operation**. Both orders agree: AB +34.59%, BA +35.38%. The local nine-case geometric mean improves **3.03%** (interval **2.40–3.66%**). The eight other cases have intervals spanning zero; most point estimates are negative, so this is not evidence of universal or regression-free compiler improvement.

| Official Compiler case | Fresh-allocation score change | 95% interval | Wins |
|---|---:|---:|---:|
| Small-Empty | -0.55% | -1.63% to +0.46% | 3/12 |
| Small-Constant | -0.72% | -1.78% to +0.25% | 5/12 |
| Small-Add | -0.42% | -1.20% to +0.27% | 3/12 |
| Small-Load | -0.60% | -1.72% to +0.52% | 1/12 |
| Medium-Copy | +0.17% | -0.06% to +0.42% | 6/12 |
| Medium-Fact | -0.59% | -1.18% to +0.06% | 1/12 |
| Medium-Prime | -0.18% | -0.69% to +0.43% | 3/12 |
| Medium-Eratosthenes | -0.24% | -0.76% to +0.48% | 2/12 |
| Large-Copy | +34.98% | +34.59% to +35.36% | 12/12 |

All pairs are retained, including the broad positive movement in the fourth and negative movement in the twelfth. No cause is assigned to those movements. The [raw Compiler results](compile-cost/fresh-allocation-compiler-results.json) record unchanged input and executable hashes. The source changes touch two files that were unchanged by the earlier runtime patches, but these timings are incremental to `fcc58178`; standalone pristine-upstream timings have not been collected. Exact-key hits still copy the persistent field state, so the change specifically removes the avoidable miss scan and does not eliminate general state-copying or graph-growth cost.

The fresh-allocation candidate also completed **21 fixed stock DataView pairs**. There is no measured runtime regression in these cases. The six-case geometric mean changes **+0.06%**, interval **−0.03% to +0.16%**. DataView BigEndian has a small positive result; its cause has not been isolated, so it is not attributed to the cache-lookup change.

| Official DataView case | Fresh-allocation score change | 95% interval | Wins |
|---|---:|---:|---:|
| DataView-BigEndian | +0.30% | +0.12% to +0.50% | 15/21 |
| DataView-Floats | -0.03% | -0.18% to +0.12% | 8/21 |
| DataView-LittleEndian | +0.08% | -0.15% to +0.38% | 6/21 |
| TypedArray-BigEndian | +0.06% | -0.07% to +0.20% | 10/21 |
| TypedArray-Floats | -0.05% | -0.23% to +0.12% | 11/21 |
| TypedArray-LittleEndian | -0.00% | -0.14% to +0.14% | 8/21 |

The [raw runtime results](compile-cost/fresh-allocation-runtime-results.json) and [audited summary of both fully validated candidates](compile-cost/official-validation-summary.json) retain all observations and AB/BA splits. Confidence intervals are per case and are not adjusted for multiple comparisons. These local microbenchmark results do not establish whole-browser or whole-V8 performance.

A post-change native profile confirms the intended hotspot reduction on unchanged official Compiler input: `AbstractField::Kill` falls from **18.89% to 1.33%** of included compiler-state samples, and `AliasStateInfo::MayAlias` from **3.91% to 0.10%**. Both processed profiles have zero unaccounted ticks. The [capture and comparison](compile-cost/fresh-allocation-post-profile.json) retain commands, binary/source/log hashes and selected symbols. Sample shares corroborate the disassembly; different harness iteration counts and profiler overhead mean raw ticks are not a paired per-compilation speedup measurement.

The declared final **six-pair comparison against getter-only `f090ad58`** quantifies the original cost still present in the full candidate. Every process again completes 25 pipelines, two normal integer-target compilations, zero target OSR compilations and zero traced aborts. Positive changes mean more cost:

| Diagnostic vs. getter-only build | Getter median | Final candidate median | Paired cost change | 95% interval |
|---|---:|---:|---:|---:|
| Total pipeline time | 18.055 ms | 19.798 ms | +9.62% | +9.18% to +10.13% |
| Compiler-zone allocation | 16,815,552 bytes | 18,813,244 bytes | +11.88% | +11.88% to +11.88% |
| Loop-peeling time | 0.4910 ms | 0.6015 ms | +22.53% | +22.00% to +23.06% |
| Loop-peeling zone allocation | 679,760 bytes | 991,280 bytes | +45.83% | +45.83% to +45.83% |
| Two integer-target compilations, summed | 2.674 ms | 3.782 ms | +41.54% | +41.19% to +41.94% |

Thus the earlier loop/dispatch work still carries substantial compilation and allocation overhead. The new comparison does **not** establish that the cache fix reduced the old +12.37% estimate to +9.62%: the direct six-pair comparison against `fcc58178` remains inconclusive for total DataView pipeline time. Those experiments were collected separately, and their difference is not a measured treatment effect. See [remaining-cost summary](compile-cost/fresh-allocation-remaining-cost-summary.json) and [raw pairs](compile-cost/fresh-allocation-remaining-cost-results.json).

The final [DataView target profile](compile-cost/fresh-allocation-target-post-profile.json) repeats the original integer function 4,000 times after the unchanged suite. It contains 32,959 included compiler-state samples with zero unaccounted ticks. `GraphReducer::ReduceTop` and `GraphReducer::Reduce` together account for **12.23%** of those self samples; the field-invalidation function has no sampled self ticks in this capture. This distinguishes the remaining DataView work from the Large-Copy cache bottleneck. Reducing graph traversal/reduction work remains an investigation target, not a proven next speedup; profiler-enabled source-position wrappers must again be excluded from stock-performance claims.

**Disposition:** retain fresh-allocation lookup at V8 `87e3481b` as a general compiler-performance candidate, independently of the two other cost experiments. It has a large, repeated official Large-Copy gain and no measured regression in the six stock DataView runtime cases. Smaller Compiler point estimates and the remaining DataView compilation/code-size costs are explicit limitations. This is not a claim of a regression-free or submission-ready combined patch. The preserved final binary is `out/x64.release-fresh-allocation/d8`; its [manifest](compile-cost/fresh-allocation-build-evidence.json) records source, executable, snapshot, ICU and configuration identities. All experiments have unsigned source and evidence checkpoints. No upstream publication has occurred.

The [final artifact audit](compile-cost/final-artifact-audit.json) verifies the saved patch against the committed V8 diff, the preserved build against its manifest, all eight completed fixed runs, compilation counts, post-profile accounting, test-log identity and local report links.

## Graph-reducer follow-up

The next experiments start independently from the retained `87e3481b` build. The [fixed protocol](reducer-cost/plan.json) declares six DataView compilation-diagnostic pairs and twelve unchanged official Compiler pairs per valid candidate, followed by twenty-one stock DataView pairs for retained candidates. Timed processes remain pinned to CPU 2; builds and tests do not overlap measurements. All observations are retained, and intervals are per case without multiple-comparison correction.

The baseline native compiler profile attributed 2,182 self samples to `GraphReducer::ReduceTop` and 1,849 to `GraphReducer::Reduce`, out of 32,959 included compiler samples. Matching PCs to the saved executable identifies repeated mark decoding and a safepoint predicate inside the reducer loop. The [reproducible PC mapping](reducer-cost/map-native-samples.py), [reviewed instruction ranges](reducer-cost/initial-block-evidence.json) and [source invariants](reducer-cost/source-review.json) distinguish sampled locations from instruction latency or removable time. Hardware perf counters remain unavailable.

The encoded-marker experiment compares full stored marks directly instead of subtracting the marker epoch, clamping old epochs to zero and narrowing the result before comparison. Logical zero still includes all older epochs; bounds assertions and graph traversal remain intact. Source checkpoints are `b6b39719`, `428ce5ce` and final test refinement `c281a2f9`. The [patch](reducer-cost/encoded-marker.patch), [87-check validation manifest](reducer-cost/encoded-marker-build-evidence.json) and [28-check test refinement](reducer-cost/encoded-marker-test-refinement.json) preserve the implementation and coverage. The latter uses a copy of the validated production objects and the generated link command; the measured d8 hash is unchanged.

Native `ReduceTop` shrinks from 1,303 to 1,251 bytes, with the subtraction/clamp sequences replaced by encoded comparisons. `Reduce` remains 1,458 bytes. All 25 generated DataView function names and instruction sizes match the baseline. This is a size check, not proof of byte-identical generated JS code. See the [native evidence](reducer-cost/encoded-marker-native-evidence.json).

| Official Compiler case | Encoded-marker score change | 95% interval | Wins |
|---|---:|---:|---:|
| Large-Copy | +0.65% | +0.47% to +0.84% | 11/12 |
| Medium-Copy | +0.66% | +0.37% to +0.94% | 10/12 |
| Medium-Eratosthenes | +0.40% | -0.20% to +0.96% | 9/12 |
| Medium-Fact | +1.05% | +0.34% to +1.77% | 10/12 |
| Medium-Prime | +0.66% | -0.03% to +1.33% | 7/12 |
| Small-Add | +0.41% | -0.35% to +1.18% | 7/12 |
| Small-Constant | +0.84% | -0.76% to +2.59% | 7/12 |
| Small-Empty | +0.92% | -0.67% to +2.61% | 7/12 |
| Small-Load | +1.07% | -0.29% to +2.43% | 7/12 |

Large-Copy improves **0.65%** (interval **+0.47% to +0.84%**), Medium-Copy **0.66%** (**+0.37% to +0.94%**), and Medium-Fact **1.05%** (**+0.34% to +1.77%**). Both AB and BA orders are positive for these cases. The nine-case geometric mean is **+0.74%**, with interval **−0.03% to +1.51%**; it does not establish an overall suite improvement. [Raw official Compiler pairs](reducer-cost/encoded-marker-compiler-results.json) retain broad movements in several rounds, including the negative eleventh pair.

The six-pair cost diagnostic reports total pipeline time **−1.06%**, interval **−1.74% to −0.38%**, with AB **−0.88%** and BA **−1.23%**. Integer-target compilation time changes **−0.88%**, interval **−1.70% to −0.21%**. Zone allocation is essentially unchanged. Every process completes 25 pipelines and two normal target compilations, with no target OSR compilation or traced abort. These instrumented results are separate from stock runtime scores. [Cost summary](reducer-cost/encoded-marker-cost-summary.json).

| Official DataView case | Encoded-marker score change | 95% interval |
|---|---:|---:|
| DataView-BigEndian | +0.10% | -0.01% to +0.22% |
| DataView-Floats | +0.24% | +0.14% to +0.36% |
| DataView-LittleEndian | +0.20% | +0.13% to +0.28% |
| TypedArray-BigEndian | +0.03% | -0.05% to +0.12% |
| TypedArray-Floats | +0.46% | -0.04% to +1.29% |
| TypedArray-LittleEndian | -0.06% | -0.17% to +0.05% |

No runtime case has a negative interval excluding zero. The six-case geometric mean is **+0.16%**, interval **+0.06% to +0.31%**. Small positive runtime movements have not been causally isolated; they are not attributed to the mark-comparison change. The sixteenth pair remains in the analysis. [Raw stock runtime pairs](reducer-cost/encoded-marker-runtime-results.json) and [audited results](reducer-cost/validation-summary.json).

The matched [post-change native profile](reducer-cost/encoded-marker-post-profile.json) has 32,890 included compiler ticks and zero unaccounted ticks. `ReduceTop` remains 6.43% and `Reduce` 5.09% of self samples, so substantial graph-reduction work remains. Single profile differences do not establish an additional speedup, and profiler-only source-position wrappers are excluded from stock optimization targets.

**Encoded-marker disposition:** retain the independent candidate for modest gains in three official Compiler cases. The original loop/dispatch graph-growth overhead has not been eliminated or remeasured against the historical getter-only build in this round. These incremental percentages must not be subtracted from the earlier historical cost estimate.

The independent safepoint experiment starts from the same `87e3481b` baseline, without the marker change. The inline poll now tests only the request bits; the existing slow-path reload checks whether the owner is parked before proceeding. Only the owning thread changes the parked bit, and no owner transition occurs between these two loads. Request handling, poll frequency, deterministic ticks and atomic ordering remain intact. Source checkpoint: `15e78039`.

All **97 selected checks passed**, including local/global safepoints, the new deterministic parked-poll test, a background-compilation/GC regression and three concurrent-allocation cases. The [patch](reducer-cost/safepoint-predicate.patch) and [build/test manifest](reducer-cost/safepoint-predicate-build-evidence.json) preserve the exact source and binaries. This is release-build coverage; no debug or thread-sanitizer result is claimed.

Disassembly confirms that the reducer's load/test/set/or/test/branch sequence becomes load/test/branch. `GraphReducer::Reduce` shrinks from **1,458 to 1,442 bytes**; `ReduceTop` stays at 1,303. The [native evidence](reducer-cost/safepoint-predicate-native-evidence.json) records unchanged names and instruction sizes for all 25 generated DataView functions. The [slow path](reducer-cost/safepoint-slow-path-after.txt) retains its relaxed reload and returns immediately for parked callers.

There is a concrete concurrency tradeoff: polling while parked with a request pending now takes an out-of-line call and an extra relaxed load. Background compiler phases can perform IR work and poll while parked during GC. The synchronous official Compiler benchmark does not quantify that throughput cost, and passing concurrency tests establishes correctness only. The [source review](reducer-cost/source-review.json) records the relevant owner-state and request invariants.

| Official Compiler case | Safepoint-predicate score change | 95% interval | Wins |
|---|---:|---:|---:|
| Large-Copy | +0.40% | -0.42% to +0.90% | 11/12 |
| Medium-Copy | +0.72% | -0.50% to +1.42% | 11/12 |
| Medium-Eratosthenes | +1.00% | +0.14% to +1.65% | 10/12 |
| Medium-Fact | +0.02% | -0.81% to +0.65% | 8/12 |
| Medium-Prime | -0.25% | -1.01% to +0.34% | 5/12 |
| Small-Add | -0.04% | -0.77% to +0.59% | 7/12 |
| Small-Constant | +0.43% | -0.48% to +1.21% | 9/12 |
| Small-Empty | +0.25% | -0.68% to +1.02% | 8/12 |
| Small-Load | -0.00% | -1.06% to +0.92% | 8/12 |

Medium-Eratosthenes improves **1.00%**, interval **+0.14% to +1.65%**, with AB **+1.61%** and BA **+0.39%**. Every other case interval spans zero. The nine-case geometric mean is **+0.28%**, interval **−0.54% to +0.85%**, with opposing order splits (AB **+0.88%**, BA **−0.32%**). This does not establish a whole-suite improvement. All twelve pairs remain in the [raw official results](reducer-cost/safepoint-predicate-compiler-results.json), including the broad negative sixth pair and the negative tenth and twelfth pairs. No cause has been assigned to those movements.

The six-pair [cost diagnostic](reducer-cost/safepoint-predicate-cost-summary.json) reports total pipeline time **−1.90%**, interval **−2.83% to −1.04%**, with AB **−2.49%** and BA **−1.30%**. Integer-target compilation time changes **−1.33%**, interval **−2.04% to −0.76%**. Zone allocation is essentially unchanged and loop-peeling allocation remains 991,280 bytes. All fourteen diagnostic processes complete 25 pipelines and two normal target compilations, with no target OSR compilation or traced abort. These instrumented results do not replace the mixed official Compiler result.

| Official DataView case | Safepoint-predicate score change | 95% interval |
|---|---:|---:|
| DataView-BigEndian | -0.10% | -0.30% to +0.11% |
| DataView-Floats | +0.03% | -0.06% to +0.11% |
| DataView-LittleEndian | -0.02% | -0.10% to +0.06% |
| TypedArray-BigEndian | +0.12% | +0.05% to +0.20% |
| TypedArray-Floats | +0.02% | -0.06% to +0.09% |
| TypedArray-LittleEndian | +0.04% | -0.04% to +0.12% |

The completed **21-pair stock runtime** comparison has a six-case geometric mean of **+0.015%**, interval **−0.021% to +0.052%**. No individual case has a negative interval excluding zero. The small TypedArray-BigEndian movement has not been causally isolated and is not attributed to the safepoint change. All observations and order splits are retained in the [raw runtime results](reducer-cost/safepoint-predicate-runtime-results.json) and [audited summary](reducer-cost/validation-summary.json).

The [post-change native profile](reducer-cost/safepoint-predicate-post-profile.json) contains 33,178 included compiler ticks and zero unaccounted ticks. `Reduce` accounts for 1,566 self ticks (**4.72%**, versus baseline **5.61%**); `ReduceTop` remains **6.33%**. These sample shares support continued investigation of graph reduction but do not establish another paired speedup. Profiling-only source-position wrappers remain excluded as stock targets.

**Safepoint disposition:** preserve as an independent research candidate for the individual Medium-Eratosthenes improvement. Do not promote it over the marker candidate: the aggregate Compiler result is inconclusive, and the parked-with-request call overhead has not been quantified under concurrent GC. The stock DataView result does not close that gap. The final preserved binary is `out/x64.release-safepoint-predicate/d8`; the marker build remains `out/x64.release-encoded-marker/d8`.

Both experiments and their full results have unsigned checkpoints. Neither is stacked with the other. The marker branch is the preferred follow-up for further validation; neither change removes the earlier loop/dispatch graph-growth cost, and no new comparison against the historical getter-only build is claimed. The production Node and Wasm programs remain unchanged.

The [final artifact audit](reducer-cost/final-artifact-audit.json) checks both saved patches against their committed diffs, preserved build hashes, all six completed fixed runs, raw diagnostic parsing, profile report accounting, test-log identities and the marker test-only refinement. It also verifies unsigned checkpoints and that this follow-up changed no production programs.

## Escape-analysis tables and pristine validation

The [next measured round](escape-cost/README.md) confirms escape-analysis table hashing as a compiler hotspot, measures table density and merge lookup counts, and tests two independent changes against the retained marker build. Lazy 64-entry chunks improve official Compiler Large-Copy **10.70%** (95% interval **+10.50% to +10.89%**) and Medium-Copy **9.40%** (**+9.18% to +9.61%**); the nine-case mean improves **2.29%**. All 122 selected checks pass. Large-Copy total zone allocation falls **1.08%**, while the smaller DataView diagnostic uses **0.13%** more. The 21-pair DataView runtime comparison is neutral.

The independent merge-input cache improves the copy cases but regresses three small Compiler cases by **0.9–1.1%**, with negative intervals in each case. It is rejected as-is, with its 119 passing checks, source, binary and every measured round preserved.

The earlier fresh-allocation lookup patch is also validated **alone on pristine V8 `293377af`**, at source checkpoint `e6293c24`. Its official Large-Copy gain is **35.17%** (**+34.82% to +35.59%**), with twelve wins; the nine-case mean is **+3.29%**. All 58 selected checks pass, generated DataView function names/sizes match pristine, and the 21-pair runtime control is neutral. This isolates the gain from the other optimizations. The chunked-storage and pristine-lookup gains have different baselines and must not be added together.

The [full report](escape-cost/README.md) contains every case, order split, uncertainty interval, memory tradeoff and retained/rejected disposition. The [artifact audit](escape-cost/artifact-audit.json) verifies source and binary identities, all seven fixed campaigns, official default configurations and unsigned checkpoints. Production Node and Wasm programs remain unchanged; no upstream publication has occurred.
