# Solver benchmarks

## Final optimization results

AMD Ryzen 9 7900, 12 cores / 24 threads, 60 GiB RAM, Linux, Node 26.12.0.
Input: 1,000,000,000 rows, 13,795,455,110 bytes and 413 stations. These are warm
filesystem-cache, end-to-end measurements including startup, compilation, reads,
parsing, merging, output and shutdown. No theoretical optimum is claimed.

| Solver | Before the final optimization | Retained implementation | Less elapsed time |
| --- | ---: | ---: | ---: |
| Plain Node | 1.078 s | 1.024 s | 4.97% |
| Wasm | Unchanged | 0.476 s | — |

The Node change keeps loop bounds and cursors as local integers and uses a V8
background pool of eight. It won 21/21 final paired rounds, following a separate
21-round confirmation. Wasm retains three SIMD lanes, direct temperature deltas,
specialized 16–31-byte names, four-way loop unrolling and derived branch hints.

Each case received three full-file warmups in fresh processes. Node ran for
21 alternating rounds; unchanged Wasm ran separately for seven rounds. Scores
are trimmed means excluding the fastest and slowest measured process. Every
output matched; measured filesystem-input counters were zero. Both used 24
workers, with 128 KiB Node chunks and 512 KiB Wasm chunks. Exact tuples and
counts also matched across all billion rows.

Evidence retained in this tree:

- [Environment, protocol, results and exact verification](benchmarks/solver-results.json)
- [Node final paired measurements](benchmarks/node-final.json)
- [Node independent confirmation](benchmarks/node-confirmation.json)
- [Wasm final measurements](benchmarks/wasm-final.json)

These reports preserve their original commands, source hashes and local artifact
paths. Results describe the recorded commits; they are not measurements of an
arbitrary future checkout.

## Cleanup validation

The cleanup removes experimental runtime modes, shares worker scheduling and
reading, and consolidates duplicate tests. The Wasm C source and shipped binary
remain identical. Against checkpoint `351f07f`, each engine received three warmups
per case and **21 alternating before/after pairs**, using the same Node 26.12.0
runtime, flags, worker count and input as above. The campaigns ran sequentially.

| Solver | Before cleanup | After cleanup | Paired elapsed-time change | 95% interval |
| --- | ---: | ---: | ---: | ---: |
| Plain Node | 1.025 s | 1.019 s | −0.51% | −1.17% to +0.21% |
| Wasm | 0.484 s | 0.483 s | −0.21% | −1.30% to +0.96% |

Times are trimmed means. Changes and intervals use all paired log time ratios
with 10,000 bootstrap resamples (seed 20261021); negative changes mean faster.
Both intervals span zero: no measurable performance change was detected on this
input. This does not establish equivalence on every workload. These cleanup
comparisons use a different baseline from the optimization results above.

Every output matched and every measured filesystem-input counter was zero.
An independent full-file verification matched exact station/minimum/sum/maximum/
count tuples for **1,000,000,000 rows and 413 stations**. All **57 tests pass on
Node 24 and 26**; solver/tooling lint, C formatting and the V8 artifact audit pass.

- [Cleanup validation and source hashes](benchmarks/cleanup-validation.json)
- [All Node cleanup rounds](benchmarks/cleanup-node.json)
- [All Wasm cleanup rounds](benchmarks/cleanup-wasm.json)

## Historical experiments

Checkpoint **`351f07f`** preserves the complete solver experiment log, 139 result
and planning files, source-specific profiling tools and all earlier unsigned
checkpoints. Rejected variants remain in their original commits. Inspect the
archive without changing this checkout:

```sh
git show 351f07f:BENCHMARKS.md
git worktree add --detach /tmp/1brc-history 351f07f
```

The current tree keeps the two selected implementations and their final evidence.
For general compiler work, the [V8 research report](v8-research/README.md) retains
all patches, profiling evidence, official benchmark results, rejected experiments
and reproduction scripts. Its baselines and performance claims are independent
of the solver timings above.
