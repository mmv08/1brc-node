# Further V8 targets from fresh profiles

Investigation date: 2026-10-21. These are demonstrated compiler gaps, **not measured speedups**. No V8 patch or production solver change was made in this investigation.

## Measurement

Profiled the preserved winning `ArrayBuffer.byteLength` build (`f090ad58`, upstream base `293377af9f02c268362e5975b7af4baa25688323`), not the rejected store-bitcast build. Three fresh processes ran the unchanged official `test/js-perf-test/DataView/run.js`, pinned to CPU 2, with V8's sampler at 250 µs. They produced **58,888 samples**, with zero unresolved leaf samples. Compilation concurrency used its normal setting. Neither compiler tracing nor native-code printing was enabled in these three runs.

Linux `perf stat` was attempted both inside and outside the sandbox. Hardware counters were denied with `perf_event_paranoid=4`; `sudo -n perf stat` required interactive authentication. No machine security setting was changed. Consequently, these results contain no hardware cycle, cache-miss, or branch-miss measurements.

| Measured region | Run 1 | Run 2 | Run 3 | Interpretation |
|---|---:|---:|---:|---|
| Optimized `doOneIterationJS` bodies | 31.77% | 31.84% | 31.74% | Largest individual generated-code target; integer typed-array reader |
| `doOneFloatIterationJS`, including inlined copies | 8.60% | 8.56% | 8.46% | Source-position attribution across tiers/callers |
| Remaining byteLength getter builtin | 0.50% | 0.50% | 0.53% | Almost all sampled callers are Maglev |
| GC VM state | 0.26% | 0.31% | 0.30% | Does not make allocation/GC the first target here |

The apparent 12–13% `Measure` hotspot includes inlined benchmark work. Resolving inline source positions attributes much of it to DataView loops; it should not be described as timing-harness overhead. The C++ cosine implementation also receives about 10.7% of samples, but this investigation established no compiler defect responsible for that cost.

These tests use time budgets and perform different amounts of work as throughput changes. Profile percentages identify coverage; they are neither recoverable-time estimates nor benchmark gains.

Evidence: [three captures and hashes](profiles.json), [official summaries](sampling-1.txt), [native excerpts](native-excerpts.txt), [native metadata](native-evidence.json), [selected compiler IR](ir-evidence.json). Raw captures remain under `results/v8-general/profiles/next-targets-20261021/`.

## 1. Redundant dispatch after choosing between constant methods

The hot polymorphic integer-reader body is 3,296 bytes and receives 3,182 of 19,663 samples in the separate native diagnostic capture. It chooses an accessor from the receiver's map, then compares that chosen accessor with one of the same constant functions to select the inlined implementation. For example, native offsets `0x2dc–0x2fd` select `getUint8`; offsets `0x312–0x319` compare the selected function and branch again. The overflow check for `i + 1` lies between them.

Fresh integer trace 51, `V8.TFTurboshaftLoopUnrolling`, contains:

```text
B26, predecessors B24/B25:
  Phi269(Constant266 /* LittleEndian.getUint8 */,
         Constant255 /* BigEndian.getUint8 */)
  ... arithmetic and deoptimization state ...
  Comparison284(Phi269, Constant255)
  Branch285(Comparison284)
```

The comparison is constant on each incoming edge. Two independent barriers prevent the existing branch-threading optimization:

1. `src/compiler/turboshaft/branch-elimination-reducer.h:659–699`: `CanBeConstantFolded` takes `has_phi` by value. Its external call at line 418 starts with `false`; recursively discovering a Phi does not update the enclosing expression's flag. A non-Phi/non-Constant root therefore returns `false` even if all operands succeed. A constant outside the merge block also returns false when its own recursion path has not crossed a Phi. The intended condition is “all operands can fold, and at least one depends on a Phi,” which is a property of the whole expression.
2. Lines 350–378 reject cloning above 13 `OpCountUpperBound` units before examining the condition. B26/B32 have 12 actual operations but an upper-bound count of 18; B38/B50 have 13/19; B44 has 16/22. FrameState metadata contributes to this discrepancy. `graph.h:452` defines the upper bound from the difference between operation IDs. The source explicitly calls the threshold arbitrary.

**Experiment:** repair the expression analysis with focused graph tests, then separately evaluate a bounded cloning-cost calculation or an equivalent edge-aware comparison fold. Preserve arithmetic overflow exits and frame-state mappings. Measure generated size and compilation cost as well as throughput. Merely raising the threshold would leave the expression-analysis defect in place.

This is a general opportunity for polymorphic inlining and comparisons of merged constants. No knowledge of these particular reader classes belongs in the optimization.

## 2. Keep loop peeling available after introducing terminal exception paths

This limitation is exposed by our byteLength candidate. It is a follow-up to that patch, not evidence of a new regression in untouched upstream V8.

The fresh integer and float traces show that these loops remain unpeeled. In integer trace 51, `V8.TFTypedLowering`, the getter's exceptional path is:

```text
Loop46 ... Branch164 -> IfTrue165 -> Call169 -> Unreachable170 / Throw171 -> End151
                    -> IfFalse166 -> continuing body -> backedge
```

There is no LoopExit marker on the terminal path. The loop has uses crossing its boundary, including `Branch164 -> IfTrue165`, `LoadField160 -> Call169`, and `StateValues53 -> FrameState56`.

`LoopPeeler::CanPeel` (`src/compiler/loop-peeling.h:46`) requires `LoopFinder::HasMarkedExits` (`loop-analysis.cc:705–733`), which rejects such edges. `GraphAssembler::ConnectUnreachableToEnd` (`graph-assembler.cc:1323`) connects Throw directly to End; existing exit-marker construction is in `GraphAssembler::MergeState` (`graph-assembler.h:697`). This pattern appears in integer traces 31/34/51 and float traces 50/52.

The cold call is **not on the continuing backedge's effect chain**. Walking that chain finds only `NoWrite` operations, so blaming the call for invalidating those load facts would be incorrect. Instead, `LoadElimination::ReduceEffectPhi` (`load-elimination.cc:1269`) starts with facts available before entering the loop. It does not create hoisted loads. Without peeling, the first iteration's map, length, and backing-pointer loads do not establish reusable preheader facts. The native code confirms these loads remain inside the loop.

**Experiment:** represent terminal exits so that peeling can safely clone them, or extend peeling with correct control/effect/value and deoptimization-state handling. Do not bypass `HasMarkedExits`; it protects those invariants. This is a broader compiler change than the local arithmetic reductions below.

`--trace-turbo-loop` is a read-only disabled flag in this release build and its diagnostic attempt stopped during flag parsing. The conclusion above comes from the separately captured IR and source, not a claimed runtime trace message.

## 3. Carry simple integer facts through lowering

The hot **inlined** float loop retains both exactness tests and unnecessary overflow branches. This is not based solely on the nearly unused standalone function. Two inlined inner-loop regions account for 1,014 / 19,663 diagnostic samples (5.16%); their samples do not quantify the cost of any individual check.

Three progressively larger experiments are possible:

| Experiment | Proof available in the actual graph | Current gap |
|---|---|---|
| Remove overflow checks after a narrowing shift | For any signed 32-bit `i`, `q = i >> 2` lies in `[-536870912, 536870911]`; neither `q + 2` nor `q + 3` can overflow. | `MachineOptimizationReducer::ReduceOverflowCheckedBinop` handles constants and selected Smi patterns, but not this shifted-range proof. |
| Eliminate implied mask checks | On the continuing path after `(i & 7) == 0`, `(i & 3) == 0` follows for the same SSA value. | `BranchEliminationReducer::ReduceDeoptimizeIf` tracks exact condition identity, without deriving this mask implication. |
| Track induction alignment | Normal-entry IR has `PhiWord32(0, checkedAdd(phi, 16))`, which preserves four zero low bits. | Current induction typing carries intervals rather than this stride/congruence fact. |

In native code version 66378, the `/8` and `/4` tests occur at decimal offsets 1472/1476 and 1547/1551; overflow branches for `q+2` and `q+3` remain at 1571 and 1642. Another hot inlined version repeats them. Selected final IR50 contains mask/deopt nodes 91/92 and 115/116, followed by shift118 and checked additions119/144.

The first two experiments do not require whole-loop induction reasoning. The third must validate every incoming edge: fresh trace52 is an OSR compilation with unknown incoming tagged values. It must not inherit the normal-entry alignment proof blindly. The `i + 16` overflow deoptimization must remain unless separately proven redundant.

## Priorities and validation

For a small first implementation, shifted-range overflow elimination has the narrowest proof. For the larger opportunity in the hottest code, investigate the constant-Phi dispatch analysis and cloning policy. Restoring peeling is a worthwhile follow-up to the getter patch, with more control-flow complexity.

A Maglev getter reduction still has coverage, but its remaining direct builtin samples are only about 0.5% here. That makes it a lower priority in this profile; the percentage is not an upper bound on all call-related overhead.

Each implementation experiment should have an unsigned checkpoint, semantic/compiler regressions, and the same alternating baseline/candidate protocol on unchanged official tests. Branch-threading work additionally needs code-size and compilation-cost controls. No gain is forecast from instruction counts alone.

## Reproducing the analysis

The exact sampling arguments, cwd, binary/source hashes and raw-log hashes are in `profiles.json`. Native printing and `--trace-turbo` used separate processes, recorded in the capture metadata.

V8's official processor handles code moves and address reuse before analysis:

```sh
D8_PATH=out/x64.release-byte-length/d8 tools/linux-tick-processor \
  --preprocess /absolute/path/to/capture/v8.log > /absolute/path/to/capture/profile.json
```

Then, from this repository:

```sh
python3 v8-research/analyze_profile.py /absolute/path/to/capture \
  --output /absolute/path/to/capture/analysis.json
# Add --native for the same-process capture containing stdout.txt disassembly.
```

The analyzer rejects ambiguous code-creation/disassembly matches. Its grouped JavaScript sample counts were checked against all three official text summaries. Binary and benchmark-source hashes were checked again after capture and matched. These checks validate the evidence pipeline; they do not replace testing a future compiler patch.
