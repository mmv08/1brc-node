# Escape-analysis table experiments

This round follows the measured compiler hotspots on the retained marker build (`c281a2f9`, production d8 hash `e50dd57b…`). It tests two independent changes, then validates the earlier fresh-allocation lookup patch alone on pristine V8. Source and evidence checkpoints are unsigned. The official benchmark files are unchanged.

## Evidence and design

The refreshed [official Compiler native profile](marker-baseline-profile.json) contains 169,430 included compiler-state samples, with zero unaccounted ticks. State-table reads account for 5,749 samples (3.39%), and virtual-object-table reads for 3,443 (2.03%). The [native PC mapping](marker-native-samples.json) matches all those samples to the saved executable and identifies hash-bucket division and chain traversal. The two getter symbols have unique native addresses. Sample shares are not promised speedups, and hardware perf counters remain unavailable.

The separate [instrumented experiment](table-diagnostics.json) runs all nine original Compiler callbacks once, retaining their original 100/10/1 compilation counts, plus the unchanged DataView suite. It records 441 and 25 compilations respectively. Counters are flushed both after analysis and after replacement verification, so replacement and deoptimization-state reads are included.

Large-Copy has 90,492 state entries below node ID 99,734, but only 28 virtual-object entries. Its state table receives 1,530,955 reads, including 870,249 inside `MergeInputs` (56.84%). Its virtual table receives 1,503,286 reads, almost all misses. Medium-Copy also spends 52.47% of its state reads inside the merge routine. These measurements justify both experiments; no workload-specific behavior is added to V8.

The indexed-storage candidate uses lazy 64-entry chunks and a presence bitmap. Missing reads and default writes do not allocate. Stored references survive growth, and a missing reference continues to refer to the shared default even after that node receives a value. The measured density supports compact chunks for the large state table; small sparse tables can consume more space. The [source review](source-review.json) records these contracts and the merge-state invariants.

The merge-cache candidate starts independently from the same baseline. It snapshots predecessor states and the old effect-phi state once per merge, before iterating variables. Persistent-map copies share immutable trees. The table is updated only after the merge returns, and reducer revisits queue work. Empty states avoid the extra reads; traversal, phi updates and safepoint checks are retained. The candidates have not been combined.

## Measurement protocol

[Fixed protocol](plan.json), with commands checked against the [official default registrations](official-registrations.json): AMD Ryzen 9 7900, Linux x64 release builds, CPU 2, fresh processes, one warmup per binary, six alternating DataView compilation-cost pairs and twelve alternating official Compiler pairs for each correctness-valid escape-analysis candidate. Retained candidates receive twenty-one stock DataView pairs. The separate pristine confirmation uses twelve Compiler and twenty-one DataView pairs. Builds, tests, profiles and benchmark workloads run serially. Every observation is retained. Intervals use 10,000 paired bootstrap resamples, seed 20261021, and are not corrected for multiple comparisons. The nine-case mean summarizes this Compiler group, not whole-V8 or browser performance.

The separate one-compilation Large-Copy diagnostic compares zone allocation only. Its durations are not paired timing evidence. Zone allocation is not RSS. Instrumented DataView scores are not used as stock throughput evidence.

## Indexed storage

Source: `cefc3a78`. [Patch](indexed-storage.patch), [build and 122-check validation](indexed-storage-build-evidence.json), [native evidence](indexed-storage-native-evidence.json), [symbol sizes](indexed-storage-symbol-sizes.json).

Both table getters are inlined in the resulting executable. The state write function shrinks from 391 to 353 bytes, the virtual-object write function from 338 to 266, and `MergeInputs` from 2,594 to 2,477. All 25 generated DataView function names and instruction sizes match the baseline; this does not establish byte-identical generated code.

The completed [Compiler comparison](indexed-storage-compiler-summary.json) improves Large-Copy by **10.70%** (95% interval **+10.50% to +10.89%**) and Medium-Copy by **9.40%** (**+9.18% to +9.61%**), each winning all twelve pairs. Medium-Eratosthenes improves **1.84%** (**+1.48% to +2.25%**). Both execution orders are positive for these cases. The nine-case mean improves **2.29%** (**+1.88% to +2.76%**). All other case intervals span zero; their negative point estimates remain in the full results.

| Official case | Score change | 95% interval | AB / BA | Wins |
|---|---:|---:|---:|---:|
| Large-Copy | +10.70% | +10.50% to +10.89% | +10.71% / +10.68% | 12/12 |
| Medium-Copy | +9.40% | +9.18% to +9.61% | +9.51% / +9.30% | 12/12 |
| Medium-Eratosthenes | +1.84% | +1.48% to +2.25% | +1.92% / +1.76% | 12/12 |
| Medium-Fact | -0.50% | -0.99% to +0.04% | -0.56% / -0.44% | 3/12 |
| Medium-Prime | -0.33% | -1.01% to +0.33% | +0.18% / -0.84% | 3/12 |
| Small-Add | -0.51% | -1.13% to +0.08% | -0.82% / -0.20% | 4/12 |
| Small-Constant | +0.42% | -0.55% to +1.44% | +1.28% / -0.43% | 6/12 |
| Small-Empty | +0.37% | -0.63% to +1.48% | +1.01% / -0.26% | 4/12 |
| Small-Load | -0.08% | -0.84% to +0.82% | -0.16% / -0.01% | 3/12 |

The six-pair [DataView cost diagnostic](indexed-storage-cost-summary.json) reports escape-analysis time **−8.21%** and total pipeline time **−0.70%** (interval **−1.24% to −0.04%**). Total zone allocation increases **0.13%**; escape-analysis allocation increases **5.74%**, or 24,744 bytes per suite process. Every process completes 25 pipelines and two normal target compilations, with no target OSR compilation or traced abort.

The [Large-Copy allocation diagnostic](indexed-storage-large-allocation.json) reduces escape-analysis zone bytes from **64,083,056 to 60,535,840** (**−5.54%**) and total pipeline bytes from **329,186,760 to 325,639,376** (**−1.08%**). These are actual instrumented allocations, separate from the initial live-storage estimates.

The [21-pair runtime comparison](indexed-storage-runtime-summary.json) is neutral: the six-case mean is **+0.002%**, with interval **−0.047% to +0.067%**. Every individual interval spans zero. All observations, including the thirteenth pair, remain in the result.

| Official case | Score change | 95% interval | AB / BA | Wins |
|---|---:|---:|---:|---:|
| DataView-BigEndian | -0.08% | -0.28% to +0.12% | -0.02% / -0.16% | 7/21 |
| DataView-Floats | +0.05% | -0.09% to +0.25% | +0.13% / -0.04% | 7/21 |
| DataView-LittleEndian | -0.09% | -0.20% to +0.02% | -0.11% / -0.07% | 5/21 |
| TypedArray-BigEndian | +0.05% | -0.04% to +0.14% | -0.03% / +0.14% | 10/21 |
| TypedArray-Floats | +0.04% | -0.10% to +0.20% | +0.06% / +0.01% | 10/21 |
| TypedArray-LittleEndian | +0.04% | -0.04% to +0.12% | +0.02% / +0.07% | 11/21 |

The [post-change native profile](indexed-storage-post-profile.json) has 156,011 included compiler samples and zero unaccounted ticks. The getters no longer have separate out-of-line symbols; their indexed reads are inlined. Profile shares are not an additional speedup measurement.

**Disposition:** retain indexed storage as a compiler-performance candidate. Its gains are measured against the earlier marker build, and it has not been combined with the merge-cache candidate. The [artifact audit](artifact-audit.json) verifies the committed patch, preserved binaries, positive test count, every fixed run and the allocation capture.

## Merge-input cache

Source checkpoints: `796241d8`, refined to `b6943c13` before building. [Patch](merge-input-cache.patch), [119-check validation](merge-input-cache-build-evidence.json), [Compiler results](merge-input-cache-compiler-summary.json).

The [native control-flow analysis](merge-loop-evidence.json) confirms that the repeated hash work leaves the variable loop. The baseline has two out-of-line table-read call sites and an inlined lookup containing three division instructions in nested loops. The candidate has three read call sites: two outside loops and one in the predecessor-cache loop. `MergeInputs` shrinks from 2,594 to 2,466 bytes. The underlying getter bodies remain 269 bytes. This is static control-flow evidence, not a measurement of instruction latency.

Large-Copy improves **2.35%** (interval **+2.10% to +2.60%**), Medium-Copy **2.52%** (**+2.35% to +2.69%**), and Medium-Eratosthenes **1.16%** (**+0.96% to +1.36%**); all three win twelve pairs. However, Small-Constant, Small-Empty and Small-Load regress **0.89%, 1.09% and 0.91%** respectively, with negative intervals and negative AB/BA splits. The nine-case mean is **+0.40%**, interval **+0.18% to +0.63%**. The small-case regressions have not been causally isolated; no microarchitectural explanation is assumed.

| Official case | Score change | 95% interval | AB / BA | Wins |
|---|---:|---:|---:|---:|
| Large-Copy | +2.35% | +2.10% to +2.60% | +2.41% / +2.28% | 12/12 |
| Medium-Copy | +2.52% | +2.35% to +2.69% | +2.41% / +2.63% | 12/12 |
| Medium-Eratosthenes | +1.16% | +0.96% to +1.36% | +1.04% / +1.28% | 12/12 |
| Medium-Fact | -0.14% | -0.52% to +0.22% | -0.48% / +0.20% | 6/12 |
| Medium-Prime | +0.39% | +0.15% to +0.66% | +0.18% / +0.60% | 8/12 |
| Small-Add | +0.26% | -0.15% to +0.71% | +0.46% / +0.05% | 5/12 |
| Small-Constant | -0.89% | -1.35% to -0.42% | -0.93% / -0.85% | 1/12 |
| Small-Empty | -1.09% | -1.71% to -0.50% | -1.09% / -1.09% | 0/12 |
| Small-Load | -0.91% | -1.51% to -0.38% | -1.36% / -0.45% | 0/12 |

The [DataView cost result](merge-input-cache-cost-summary.json) has total pipeline time **−0.71%**, interval **−1.64% to +0.29%**, and total zone allocation **+0.005%**. Escape-analysis allocation increases by 896 bytes per suite process. All fourteen processes complete 25 pipelines, two normal target compilations, no target OSR compilation and no traced abort. The [single Large-Copy allocation check](merge-input-cache-large-allocation.json) increases escape-analysis storage by only 80 bytes; its durations are not used as timing evidence.

**Disposition: rejected as-is.** The copy-case improvements do not justify promoting a candidate with repeated regressions in three small cases, especially when indexed storage provides larger gains. The rejected source, binary and every measured round remain preserved. As declared in the protocol, the rejected candidate does not receive a 21-pair runtime campaign. The two candidates remain independent.

## Standalone fresh-allocation lookup

The exact earlier lookup patch is committed as `e6293c24` on pristine `293377af`, without the other optimizations. Only `src/compiler/load-elimination.cc` and its unit tests differ from pristine. Those two files were identical between pristine and the earlier experiment baseline, and the new patch is byte-for-byte identical to the saved earlier patch. The preserved pristine d8 hash matches the original baseline measurements.

The standalone build passes **58 selected checks**, including all four new fresh-allocation regression tests. The [native comparison](standalone-fresh-allocation-native-evidence.json) has matching names and instruction sizes for all 23 generated DataView functions on pristine and candidate. This does not prove byte-identical generated code. The completed [twelve-pair Compiler comparison](standalone-fresh-allocation-compiler-summary.json) confirms the gain independently: **Large-Copy +35.17%**, interval **+34.82% to +35.59%**, with twelve wins and positive AB/BA results. The nine-case mean is **+3.29%**, interval **+2.74% to +3.78%**. Small-case negative point estimates remain in the table; their intervals include zero, which does not establish that they are regression-free. The small Medium-Copy movement has not been causally isolated.

| Official Compiler case | Score change | 95% interval | AB / BA | Wins |
|---|---:|---:|---:|---:|
| Large-Copy | +35.17% | +34.82% to +35.59% | +34.81% / +35.54% | 12/12 |
| Medium-Copy | +0.36% | +0.01% to +0.75% | +0.22% / +0.51% | 7/12 |
| Medium-Eratosthenes | +0.24% | -0.12% to +0.52% | +0.08% / +0.40% | 8/12 |
| Medium-Fact | -0.12% | -0.73% to +0.44% | -0.04% / -0.19% | 7/12 |
| Medium-Prime | +0.21% | -0.09% to +0.51% | +0.12% / +0.30% | 7/12 |
| Small-Add | +0.28% | -0.60% to +1.09% | -0.03% / +0.59% | 9/12 |
| Small-Constant | -0.72% | -1.85% to +0.30% | -0.68% / -0.76% | 3/12 |
| Small-Empty | -0.58% | -1.91% to +0.60% | -0.67% / -0.50% | 5/12 |
| Small-Load | -0.68% | -1.57% to +0.15% | -0.91% / -0.44% | 2/12 |

The completed [twenty-one-pair DataView control](standalone-fresh-allocation-runtime-summary.json) is neutral: the six-case mean is **−0.034%**, interval **−0.129% to +0.042%**. Every individual interval spans zero. The second and all other pairs remain in the analysis; small runtime movements have not been causally attributed to the compiler change.

| Official DataView case | Score change | 95% interval | AB / BA | Wins |
|---|---:|---:|---:|---:|
| DataView-BigEndian | +0.00% | -0.18% to +0.19% | +0.07% / -0.07% | 10/21 |
| DataView-Floats | -0.10% | -0.38% to +0.12% | -0.10% / -0.09% | 13/21 |
| DataView-LittleEndian | -0.03% | -0.15% to +0.14% | +0.05% / -0.11% | 5/21 |
| TypedArray-BigEndian | +0.03% | -0.06% to +0.12% | +0.05% / +0.01% | 11/21 |
| TypedArray-Floats | -0.11% | -0.38% to +0.09% | +0.03% / -0.26% | 8/21 |
| TypedArray-LittleEndian | -0.01% | -0.10% to +0.08% | +0.08% / -0.11% | 7/21 |

**Disposition:** retain the fresh-allocation lookup as an independently validated candidate on pristine V8. Its strong Large-Copy gain does not depend on the other patches. This is local Linux x64 release validation, not a claim about all workloads or platforms. It has not been published upstream.

The final checkout is `compiler-standalone-fresh-allocation` at `e6293c24`; the retained indexed-storage source remains on `compiler-escape-indexed-storage` at `cefc3a78`. Preserved executables are `results/v8-general/v8/out/x64.release-escape-standalone-fresh-allocation/d8` and `results/v8-general/v8/out/x64.release-escape-indexed-storage/d8`. The rejected cache remains on `compiler-escape-merge-input-cache` at `b6943c13` with its preserved executable and full measurements.

The [final artifact audit](artifact-audit.json) checks all three patches, preserved binaries and configurations, positive test counts, all seven fixed campaigns, native/profile and allocation captures, official benchmark registrations, local report links and unsigned checkpoints. It also verifies that this round changed no production Node or Wasm program. The two retained gains use different baselines and must not be added together.
