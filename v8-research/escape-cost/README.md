# Escape-analysis table experiments

This round follows the measured compiler hotspots on the retained marker build (`c281a2f9`, production d8 hash `e50dd57b…`). It tests two independent changes, then validates the earlier fresh-allocation lookup patch alone on pristine V8. Source and evidence checkpoints are unsigned. The official benchmark files are unchanged.

## Evidence and design

The refreshed [official Compiler native profile](marker-baseline-profile.json) contains 169,430 included compiler-state samples, with zero unaccounted ticks. State-table reads account for 5,749 samples (3.39%), and virtual-object-table reads for 3,443 (2.03%). The [native PC mapping](marker-native-samples.json) matches all those samples to the saved executable and identifies hash-bucket division and chain traversal. The two getter symbols have unique native addresses. Sample shares are not promised speedups, and hardware perf counters remain unavailable.

The separate [instrumented experiment](table-diagnostics.json) runs all nine original Compiler callbacks once, retaining their original 100/10/1 compilation counts, plus the unchanged DataView suite. It records 441 and 25 compilations respectively. Counters are flushed both after analysis and after replacement verification, so replacement and deoptimization-state reads are included.

Large-Copy has 90,492 state entries below node ID 99,734, but only 28 virtual-object entries. Its state table receives 1,530,955 reads, including 870,249 inside `MergeInputs` (56.84%). Its virtual table receives 1,503,286 reads, almost all misses. Medium-Copy also spends 52.47% of its state reads inside the merge routine. These measurements justify both experiments; no workload-specific behavior is added to V8.

The indexed-storage candidate uses lazy 64-entry chunks and a presence bitmap. Missing reads and default writes do not allocate. Stored references survive growth, and a missing reference continues to refer to the shared default even after that node receives a value. The measured density supports compact chunks for the large state table; small sparse tables can consume more space. The [source review](source-review.json) records these contracts and the merge-state invariants.

The merge-cache candidate starts independently from the same baseline. It snapshots predecessor states and the old effect-phi state once per merge, before iterating variables. Persistent-map copies share immutable trees. The table is updated only after the merge returns, and reducer revisits queue work. Empty states avoid the extra reads; traversal, phi updates and safepoint checks are retained. The candidates have not been combined.

## Measurement protocol

[Fixed protocol](plan.json): CPU 2, fresh processes, one warmup per binary, six alternating DataView compilation-cost pairs and twelve alternating official Compiler pairs for each correctness-valid candidate. Retained candidates receive twenty-one stock DataView pairs. Builds, tests, profiles and benchmark workloads run serially. Every observation is retained. Intervals use 10,000 paired bootstrap resamples, seed 20261021, and are not corrected for multiple comparisons. The nine-case mean summarizes this Compiler group, not whole-V8 or browser performance.

The separate one-compilation Large-Copy diagnostic compares zone allocation only. Its durations are not paired timing evidence. Zone allocation is not RSS. Instrumented DataView scores are not used as stock throughput evidence.

## Indexed storage

Source: `cefc3a78`. [Patch](indexed-storage.patch), [build and 122-check validation](indexed-storage-build-evidence.json), [native evidence](indexed-storage-native-evidence.json), [symbol sizes](indexed-storage-symbol-sizes.json).

Both table getters are inlined in the resulting executable. The state write function shrinks from 391 to 353 bytes, the virtual-object write function from 338 to 266, and `MergeInputs` from 2,594 to 2,477. All 25 generated DataView function names and instruction sizes match the baseline; this does not establish byte-identical generated code.

The completed [Compiler comparison](indexed-storage-compiler-summary.json) improves Large-Copy by **10.70%** (95% interval **+10.50% to +10.89%**) and Medium-Copy by **9.40%** (**+9.18% to +9.61%**), each winning all twelve pairs. Medium-Eratosthenes improves **1.84%** (**+1.48% to +2.25%**). Both execution orders are positive for these cases. The nine-case mean improves **2.29%** (**+1.88% to +2.76%**). All other case intervals span zero; their negative point estimates remain in the full results.

The six-pair [DataView cost diagnostic](indexed-storage-cost-summary.json) reports escape-analysis time **−8.21%** and total pipeline time **−0.70%** (interval **−1.24% to −0.04%**). Total zone allocation increases **0.13%**; escape-analysis allocation increases **5.74%**, or 24,744 bytes per suite process. Every process completes 25 pipelines and two normal target compilations, with no target OSR compilation or traced abort.

The [Large-Copy allocation diagnostic](indexed-storage-large-allocation.json) reduces escape-analysis zone bytes from **64,083,056 to 60,535,840** (**−5.54%**) and total pipeline bytes from **329,186,760 to 325,639,376** (**−1.08%**). These are actual instrumented allocations, separate from the initial live-storage estimates.

Runtime comparison, post-change profile, independent cache measurement and pristine validation are still in progress. This report will be completed with their full results and artifact audit.
