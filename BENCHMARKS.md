# Local benchmark notes

## Machine and method

- Intel Core Ultra 7 258V: 4 performance + 4 efficiency cores, no SMT.
- 30 GiB RAM; Linux x86-64; encrypted Btrfs-backed home filesystem.
- Default OS `powersave` governor, `balance_power` preference; unchanged.
- Desktop applications remained running. Benchmarks were run sequentially.
- Input: 1,000,000,000 separately generated measurements, using the upstream
  generator's 413 station names and Gaussian temperature distributions.
- Input size: **13,795,455,110 bytes** (12.85 GiB).
- Upstream revision: `9975dfbfa32143fb7502e63374a48f9fde1c381d`.
- Seed: `0x12345678`; xorshift32; legal temperatures clamped to ±99.9.
- Warm OS filesystem cache. Every run starts a new Node process.
- End-to-end timing includes process/worker startup, reads, aggregation, merging,
  sorting, stdout and shutdown. Every output is checked against generation-time
  aggregates. No results or station dictionary are reused by the solver.

## First optimization round, Node 26.12.0

8 workers, dynamically assigned 128 KiB chunks; no V8 flags.

| Run | Seconds |
| --- | ---: |
| 1 | 5.059 |
| 2 | 4.987 |
| 3 | 4.961 |
| 4 | 4.955 |
| 5 | 4.957 |
| **Trimmed mean** | **4.969** |

Best throughput: about 202 million rows/s, 2.78 GB/s.

A second five-run Node 26 batch using the documented `npm run bench` command
measured **5.034 s** trimmed mean: 5.089, 4.982, 5.050, 5.014, 5.038 seconds.
All outputs matched, confirming the approximately five-second result.

The raw reports are retained in `results/`. Their hashes identify the exact code
and expected output for each run.

## Same-machine comparison

Same billion-row file, output checks, fresh processes, and warm filesystem cache:

| Implementation | Node | Five-run trimmed mean | Best |
| --- | --- | ---: | ---: |
| This solver | 26.12.0 | **4.969 s** | 4.955 s |
| This solver | 24.16.0 | 6.510 s | 4.856 s |
| Upstream optimized entry (Edgar-P-yan) | 26.12.0 | 52.456 s | 43.413 s |

The Node 26 solver's trimmed mean is about **10.6× faster** than the upstream
optimized entry on this machine. Individual runs fluctuate substantially on
this active laptop; the Node 24 outlier is not evidence it wins consistently.
These aren't results from the upstream's official evaluation hardware.

Upstream optimized runs: 43.413, 57.228, 58.033, 48.263, 51.877 seconds.
Final-code Node 24 runs: 6.393, 7.424, 7.097, 4.856, 6.039 seconds.
An additional `./run.sh` run completed in 5.07 s with **184,048 KiB peak RSS**
(about 180 MiB, including workers); its output was also checked byte-for-byte.

The benchmark uses `NODE_BIN`, not `NODE`: npm overwrites the latter with the
Node executable running npm. Recording the actual child runtime's version
caught this pitfall during the final CLI checks.

## Optimization diary

These are exploratory measurements, not controlled cross-version comparisons:
the implementation, runtime, buffer sizes, and thermal state changed over time.

| Experiment | Observation |
| --- | --- |
| First word-scanning parser, Node 24 | 100M rows in 0.84–0.87 s after the first run |
| Upstream optimized entry, Node 24 | Same 100M rows in 3.91, 3.93, 5.11 s |
| Early complete parser, Node 24 | 1B rows: first run 10.70 s; subsequent 7.48, 7.36 s |
| First/last-word name comparisons, Node 26 | About 6.4 s for 1B |
| Remove station-prefix cache | Simpler code; about 6.2 s instead of 6.4 s |
| Smaller, cache-friendly buffers | About 5.8 s with 512 KiB rather than 8 MiB |
| Branch-light temperature grammar table | About 5.3 s |
| Derive row width without a dependent table load | About 5.16 s |
| Signed name-word loads | About 5.02 s; avoid unsigned-word double fields |
| Cache the second name word in each entry | Final five-run trimmed mean 4.969 s |
| Disable Maglev | No convincing improvement; no special flags retained |

A sequential 100M-row sweep favored 8 workers over 4 or 6, and 128 KiB chunks
over 512 KiB or 2 MiB. The full billion-row run confirmed the smaller-buffer
choice. Dynamic scheduling avoids leaving the main process waiting for a slow
efficiency core's fixed-size partition.

Not used in that first round: native addons, external runtime libraries, mmap bindings, WebAssembly,
precomputed station dictionaries, input pre-aggregation, data-block repetition,
system-wide cache drops, power-mode changes, or CPU affinity manipulation.

## Second optimization round

All proposed pure-JavaScript techniques were implemented and screened; Wasm
was explicitly deferred. Alternative engines and reproduction commands are in
[experiments/README.md](experiments/README.md). All results below use the same
input and machine, but later sustained power states differ from the first round.

### Profiling and measurement controls

- CPU profiling placed approximately 94% of sampled time in parsing/name
  matching and approximately 5% in file reads; garbage collection was negligible.
- A diagnostic read-only pass over the warm 13.8 GB file took 0.26 s. This is
  **not a challenge result**, but confirms the warm solver is CPU-bound.
- `perf` hardware counters work without changing kernel settings.
- Single-core comparisons were pinned to CPU 0, with all algorithms measured
  in alternating order. Multi-core finalists were compared on all billion rows,
  reversing order every round. CPU time, RSS, input blocks, temperature/frequency
  snapshots, source hashes, and expected-output checks are retained in `results/`.
- Clocks fall sharply after the initial burst. For example, an unchanged 100M
  control moved from 0.45 s to 0.75 s within a screening sweep. This invalidates
  naive comparisons between distant short-test results; sustained paired runs
  are the basis for choosing the final implementation.

### Findings before final selection

| Experiment | Finding |
| --- | --- |
| Flat typed-array metadata/aggregates | Modest repeatable improvement: 6.310 s versus 6.825 s baseline in a five-round full-file comparison |
| Ordinary 2–4 independent row cursors | No convincing benefit without changing compiler behavior |
| Separate station-scan and temperature-update phases | Helps once the hot functions are inlined; cold insertion is outlined |
| Larger inlining budget | Pinned-core 100M mean improved from 1.949 s baseline to 1.698 s with two phased cursors |
| Unconditional overlapping middle-word name comparison | Another approximately 4% on the phased parser: 1.640 s versus 1.712 s on one core |
| Separate metadata arrays / packed Float64 stats | No convincing gain over interleaved integer records |
| Full Uint16 index domain / masked IDs | No convincing full-file gain; larger virtual allocation not retained by default |
| Growing 1K–8K hash tables | Correct for arbitrary keys, including 10K stations, but no clear performance win |
| Compact temperature table / direct arithmetic | No useful improvement over the original 8 KiB grammar table |
| 4/6/7/8/9/10/12 workers | Eight remained the strongest screening choice; oversubscription didn't help |
| P-only / E-only workers and per-worker affinity | Tested; final default remains portable rather than requiring `taskset` |

### Final five-round warm-file selection

All five algorithms were run once per round on all billion rows, reversing the
order in alternating rounds. Drop each algorithm's fastest and slowest times.
The phased candidates used the same two inlining-budget flags (1,000 individual,
4,000 cumulative bytecode bytes); no power settings changed.

| Algorithm | Trimmed mean | Best |
| --- | ---: | ---: |
| Original first-round baseline | 6.116 s | 3.467 s |
| **Two phased cursors, overlapping middle comparison** | **5.467 s** | **3.066 s** |
| Three phased cursors, same comparison | 5.515 s | 2.966 s |
| Four phased cursors | 5.917 s | 3.258 s |
| Two phased cursors, pinned workers | 5.673 s | 5.184 s |

The default is the two-cursor version: **10.6% lower wall time** than the
original in this batch, without Linux affinity dependencies. The three-cursor
sub-three-second outlier did not win the repeated-run score. Don't compare
these sustained-state averages directly with the first-round 4.969 s average;
the original algorithm is slower too under the later power state.

Raw original runs: 3.467, 5.927, 5.893, 6.529, 6.612 s.
Raw winning runs: 3.066, 5.156, 5.440, 5.803, 5.822 s.
The winning implementation was promoted to `lib/aggregate.mjs`; the previous
one remains in `lib/baseline.mjs`. The launcher applies the measured V8 flags.

### Promoted default: final CLI validation

`npm run bench -- measurements.txt` now automatically selects the local
Node 26.12.0 binary and the winning flags, with no environment overrides:

| Run | Seconds |
| --- | ---: |
| 1 | 3.092 |
| 2 | 3.110 |
| 3 | 3.353 |
| 4 | 5.328 |
| 5 | 5.364 |
| **Trimmed mean** | **3.930** |

The late jump illustrates the burst/sustained-clock issue; the matched 11%
comparison above is a better measure of the algorithmic improvement than
comparing this average against the earlier 4.969 s average in isolation.
Raw report: `results/1792354080750-local.json`.

A final `./run.sh measurements.txt` validation took **3.03 s** with
**173,636 KiB peak RSS** (169.6 MiB). Output matched the expected file exactly.
An independent `wc -l` confirmed **1,000,000,000 rows**. The 16-test suite passes
on Node 24 and Node 26, including 60 experimental-feature combinations;
Biome's formatting and recommended lint checks pass.

### Cold-file I/O

The benchmark helper requested `POSIX_FADV_DONTNEED` for **only the input file**
before every run. It did not clear the system-wide cache or change the input.
Filesystem counters confirmed approximately 4.8 GiB of actual input per run;
the Btrfs mount uses `compress=zstd:1`, while logical data size is 12.85 GiB.

Late, sustained runs from the alternating comparison:

| Reader | Cold 1B time |
| --- | ---: |
| Original baseline | 12.653, 12.545 s |
| Flat, synchronous 128 KiB | 12.524, 12.584 s |
| Flat, 16 MiB work regions, private FDs, 128 KiB buffer | 12.040, 12.001 s |
| Flat, double-buffered async 512 KiB, private FDs | 15.386, 15.163 s |

Larger sequential work regions helped cold input slightly. Async prefetching
added overhead rather than improving throughput in this setup. Cold results
should not be mixed with the warm-cache headline timings.
