# Final JavaScript-only pass

**No repeatable improvement over the existing default. Its hot path and default
configuration were left unchanged.** No Wasm, native addons, global cache drops,
or power-setting changes were used.

## Experiments

- Fused 48-byte station records: metadata/min/max, Float64 sum, and Uint32 count
  in one ArrayBuffer; also tested 64-byte record spacing.
- Tiled tokenization/reduction with 16, 32, 64, 128 and 256 rows, using scalar
  or four-way reduction.
- Rotate/XOR, shift/add and independent dual-accumulator hashes, with an
  avalanche-mix variant. Complete name comparisons remain mandatory.
- Eight-byte scanning using two ordinary 32-bit loads, without BigInt or SIMD.
- Larger inlining budgets and separately specialized/minimal-diff versions,
  controlling for experiment-framework overhead.
- Different P/E-core kernels: P2/E3 and P3/E2 cursors, with per-worker affinity.

## Profile and counters

The current winner's pinned-core CPU profile attributed approximately 36% to
scanning, 20% to station lookup, 22% to temperature/aggregate updates, 8% to
full-name comparisons, and 7% to reads. GC remained negligible.

`PERF=1` now records instructions, cycles, branches and branch misses. The
current kernel typically retired about **29.4 billion instructions per 100M
rows**; many alternatives retired 33–44 billion. Cheaper arithmetic and shorter
source didn't necessarily yield cheaper optimized code. Generic, specialized
and minimal-diff versions were all tested.

## Full-billion-row comparison

Fresh Node 26.12.0 processes; five rounds; reversed ordering every other round;
warm input; stdout validated every time. Drop each case's fastest and slowest:

| Implementation | Trimmed mean |
| --- | ---: |
| **Existing default** | **5.794 s** |
| Fused 48-byte records, minimal-diff version | 5.822 s |
| Fused 64-byte records, generic version | 5.924 s |
| Tiled 64-row parsing/reduction | 6.814 s |
| Rotate/XOR plus avalanche mixing | 5.912 s |
| Uniform two-cursor workers, pinned | 5.826 s |
| P3/E2 hybrid | 5.588 s, requiring confirmation |

The apparent hybrid gain came from early high-clock samples. In the final
three rounds it effectively tied the default. We repeated the comparison
after **eight output-checked billion-row warm-up processes**, then five
alternating rounds:

| Implementation | Warmed-up trimmed mean |
| --- | ---: |
| **Existing default** | **5.845 s** |
| P3/E2 hybrid | **5.845 s** |

Warm-ups prepare hardware/cache state only. Every execution is a fresh process
that reads and computes all billion rows. No dictionaries, aggregates or parsed
data are reused. There are no artificial cooling pauses or power-mode changes.

These sustained-state timings aren't directly comparable to the earlier
3.930-second mixed burst/sustained batch: the unchanged default shows the same
clock-state difference. There is no new faster headline result from this round.

## Reproduction and files

- `round3.mjs`: generic layout, batch, hash and scan experiments.
- `lean.mjs`: separately specialized scanner functions.
- `direct.mjs`: minimal-diff record/hash changes without per-word callbacks.
- `hybrid.mjs`: per-worker cursor selection, without global setting changes.
- `test/last-pass.test.mjs`: 78 new configurations/collision checks. It compares
  exact min/sum/max/count values as well as formatted output. Covers short,
  NUL, UTF-8 and 100-byte names, 10K keys, CRLF, missing final LF and forced
  full-hash collisions with matching cached name words.

```sh
CPU_SET=0 WORKERS=1 PERF=1 node tools/last-pass.mjs layout
CPU_SET=0 WORKERS=1 PERF=1 node tools/last-pass.mjs hash
CPU_SET=0 WORKERS=1 PERF=1 node tools/last-pass.mjs lean
CPU_SET=0 WORKERS=1 PERF=1 node tools/last-pass.mjs direct

# Run groups sequentially, not concurrently:
RUNS=5 node tools/last-pass.mjs hybrid measurements.txt
```

`tools/compare.mjs` accepts `WARMUP=N` for explicitly reported warm-up processes
and `CASES` for a JSON array of `{name, env}` cases. Raw timing/usage/conditions
reports, source/output hashes, profiles and perf CSVs remain under `results/`.
