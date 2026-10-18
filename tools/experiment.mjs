import { spawnSync } from 'node:child_process';

const group = process.argv[2] ?? 'parser';
const file = process.argv[3] ?? 'measurements-100m.txt';
const cases = [];
const add = (label, env) => cases.push({ label, env });
add('baseline control', { ENGINE: 'baseline' });

if (group === 'parser') {
  for (const engine of ['objects', 'flat', 'soa', 'phased']) {
    for (const streams of [1, 2, 3, 4]) {
      add(`${engine}, ${streams} cursors`, { ENGINE: engine, STREAMS: String(streams) });
    }
  }
} else if (group === 'io') {
  for (const io of ['sync', 'macro', 'async']) {
    for (const chunkSize of [131072, 524288, 2097152]) {
      add(`${io}, ${chunkSize / 1024} KiB`, { IO: io, CHUNK_BYTES: String(chunkSize) });
    }
  }
  add('private file descriptors', { PRIVATE_FD: '1' });
  add('private fds, macro reads', { PRIVATE_FD: '1', IO: 'macro' });
} else if (group === 'threads') {
  for (const workers of [4, 6, 7, 8, 9, 10, 12]) {
    add(`${workers} workers`, { WORKERS: String(workers) });
  }
  for (const cpus of ['0,1,2,3', '4,5,6,7', '0,1,2,3,4,5,6', '0,1,2,3,4,5,6,7']) {
    add(`pinned ${cpus}`, { WORKERS: String(cpus.split(',').length), PIN_WORKERS: cpus });
  }
} else if (group === 'micro') {
  for (const temperature of ['table', 'compact', 'arithmetic']) {
    for (const bits of [14, 15, 16]) {
      add(`${temperature}, ${2 ** bits} slots`, {
        TEMPERATURE: temperature,
        TABLE_BITS: String(bits),
      });
    }
  }
  if (process.env.ENGINE === 'soa') {
    for (const bits of [10, 11, 12, 13]) {
      add(`growing table, ${2 ** bits} initial slots`, { TABLE_BITS: String(bits) });
    }
    add('packed statistics', { STATS: 'packed' });
  }
} else if (group === 'flags') {
  for (const flags of [
    '',
    '--no-maglev',
    '--max-inlined-bytecode-size=2000 --max-inlined-bytecode-size-cumulative=20000',
    '--no-turbo-loop-peeling',
    '--no-turbo-escape',
  ]) {
    add(flags || 'default V8 flags', { FLAGS: flags });
  }
} else throw new Error('Choose parser, io, threads, micro, or flags');

add('baseline control, end', { ENGINE: 'baseline' });
for (const { label, env } of cases) {
  console.log(`\n## ${label}`);
  const child = spawnSync(process.execPath, ['tools/bench.mjs', file], {
    env: { ...process.env, RUNS: process.env.RUNS ?? '3', BENCH_LABEL: label, ...env },
    stdio: 'inherit',
  });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
}
