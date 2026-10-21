# General V8 compiler experiments

This investigation targets current upstream V8, independently of the 1BRC solvers.

## Experiment 1: inline ArrayBuffer.prototype.byteLength

On V8 15.8.0 candidate at `293377af9f02c268362e5975b7af4baa25688323`, the ordinary ArrayBuffer length getter has no JSCallReducer reduction. The unchanged official DataView typed-array benchmarks call it in their inner loops. Sampling attributed 780 of 19,796 ticks (3.9%) directly to the getter; optimized disassembly confirmed the calls.

The patch adds a mutable, sandbox-aware UintPtr field load after receiver validation and a shared-bit check. The shared case calls the original getter through V8’s CallFunction trampoline, preserving its exception and realm without a speculative deoptimization loop. Resizing and detachment update the loaded field. No benchmark, station name, input size, or 1BRC-specific behavior is encoded in V8.

The final optimized `doOneFloatIterationJS` body shrank from 1,172 to 768 bytes; its two getter call sites disappeared. Native code shows fewer call-related spills and number conversions. Static pointer-load counts also decrease, but different loop peeling contributes: loads remain in the loop, so this is not evidence of full invariant-load hoisting.

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

## Further source targets

Current baseline `makeFloatBuffer` disassembly contains `bswap → vmovd/q GPR-to-XMM → vmovss/sd store`. A general same-width store-of-bitcast reduction can remove the register transfer. This is being evaluated as an independent experiment; source presence alone is not a performance result.

Loop-invariant array checks/loads and alignment checks for strided integer division remain in the optimized float loop. Their removal requires proofs about effects and induction ranges; no unchecked assumption or workload-specific shortcut is justified.
