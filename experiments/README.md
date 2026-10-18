# Pure-JavaScript optimization experiments

These engines deliberately remain separate from the winning parser so that
failed experiments don't obscure the readable default. No WebAssembly, native
addons, precomputed station names, or input-specific results are used.

## Engines

| `ENGINE` | What changes |
| --- | --- |
| `baseline` | Original object-based parser, preserved in `lib/baseline.mjs` |
| `objects` | Original layout, factored into a per-row function; 1–4 independent cursors |
| `flat` | Uint16 hash-table IDs, 32-byte integer metadata records, dense sum/count arrays |
| `soa` | Separate metadata arrays, optional packed statistics, automatically growing hash table |
| `masked` | Full 16-bit metadata capacity and masked indexes, testing bounds-check elimination |
| `phased` | Winning default in `lib/aggregate.mjs`: scan names before updating temperatures; cold insertion outlined |

All hash collisions are resolved by complete byte comparisons, including names
whose first, second, and last words match. The growing table is tested against
10,000 keys starting from only 1,024 slots.

## Reproduce

```sh
NODE_BIN="$PWD/.runtimes/node-v26.12.0/bin/node" \
  ENGINE=flat STREAMS=2 node tools/bench.mjs measurements.txt

# Short screening matrices; run groups separately, never concurrently:
NODE_BIN="$PWD/.runtimes/node-v26.12.0/bin/node" node tools/experiment.mjs parser
NODE_BIN="$PWD/.runtimes/node-v26.12.0/bin/node" ENGINE=flat node tools/experiment.mjs io
NODE_BIN="$PWD/.runtimes/node-v26.12.0/bin/node" ENGINE=flat node tools/experiment.mjs threads
NODE_BIN="$PWD/.runtimes/node-v26.12.0/bin/node" ENGINE=soa node tools/experiment.mjs micro
NODE_BIN="$PWD/.runtimes/node-v26.12.0/bin/node" ENGINE=flat STREAMS=2 node tools/experiment.mjs flags

# Alternating full-file comparisons, reversing order every round:
NODE_BIN="$PWD/.runtimes/node-v26.12.0/bin/node" node tools/compare.mjs layouts
node tools/compare.mjs final
```

`tools/compare.mjs` records wall time, CPU time, peak RSS, filesystem input
blocks, source/output hashes, and before/after temperature and frequency
snapshots. `CASES` can supply a JSON array of `{name, env}` configurations.
The benchmark automatically supplies the winning inlining flags for `phased`;
use `FLAGS=''` to explicitly test the engine without those flags.

## I/O alternatives

- `IO=sync`: synchronous positioned reads into a reused buffer.
- `IO=macro`: claim 16 MiB contiguous work regions, parse in cache-sized chunks.
- `IO=async`: double-buffered asynchronous reads; schedule the next pread before
  parsing the current buffer. Try `UV_THREADPOOL_SIZE` separately.
- `PRIVATE_FD=1`: each worker opens its own file description, with independent
  kernel read-ahead state.
- `IO=read-only`: diagnostic lower bound, reads the file but skips parsing.
  **Not a valid challenge result.** On a warm file this took 0.26 s for 13.8 GB.

To test a cold file without clearing the system-wide page cache:

```sh
NODE_BIN="$PWD/.runtimes/node-v26.12.0/bin/node" COLD=1 RUNS=3 \
  node tools/compare.mjs io
```

The small Python standard-library helper only requests `POSIX_FADV_DONTNEED`
for the benchmark input. It never writes to the file. It performs no challenge
computation and is not a solver dependency. Since this is kernel advice, check
the recorded filesystem-input counters rather than assuming eviction worked.

## CPU and compiler alternatives

- `WORKERS=4/6/7/8/9/10/12`: fewer workers and modest oversubscription.
- `PIN_WORKERS=0,1,2,3,4,5,6,7`: pin individual worker threads with Linux
  `taskset`; no system-wide affinity or power settings change.
- `CPU_SET=0 WORKERS=1`: isolate parser comparisons on one performance core.
- `TEMPERATURE=table/compact/arithmetic`: 8 KiB table, 300-byte table, or direct
  branch-light arithmetic.
- `TABLE_BITS=14/15/16`: hash-table capacities; `soa` additionally supports
  10–13 with resizing.
- `STATS=packed`: `soa` packs min/max/sum/count into one Float64 record.
- `FLAGS`: V8 flags such as a larger inlining budget. Trace output confirmed
  that `--max-inlined-bytecode-size=1000
  --max-inlined-bytecode-size-cumulative=4000` enables more phased-parser inlining.

## Measurement cautions

The laptop starts with high burst frequencies, then reduces sustained clocks
substantially. A control in one screening sweep moved from 0.45 s to 0.75 s
without a code change. Don't rank distant short-test results as if power state
were constant. Final choices require alternating full-billion-row runs.

Initial sustained full-file comparison: baseline 6.825 s, flat one-cursor
6.310 s, ordinary two-cursor flat 6.514 s (five-run trimmed means).
On one pinned performance core, 100M rows: baseline 1.949 s, flat 1.884 s,
phased two-cursor parser with larger inlining budget 1.698 s (three-run means).
Different conditions explain why these aren't directly comparable to the
earlier approximately five-second headline result.
