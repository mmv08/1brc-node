import { spawnSync } from 'node:child_process';

const group = process.argv[2] ?? 'layout';
const file = process.argv[3] ?? 'measurements-100m.txt';
const current = { name: 'current winner', env: { ENGINE: 'phased', STREAMS: '2' } };
const experimental = { ENGINE: 'round3' };
let cases;
if (group === 'layout') {
  cases = [
    current,
    { name: 'experimental split control', env: experimental },
    ...[48, 64].map((bytes) => ({
      name: `fused ${bytes}-byte records`,
      env: { ...experimental, RECORD_LAYOUT: 'fused', RECORD_BYTES: String(bytes) },
    })),
    ...[16, 32, 64, 128, 256].map((size) => ({
      name: `tiled ${size} rows`,
      env: { ...experimental, PIPELINE: 'tiled', BATCH_SIZE: String(size) },
    })),
  ];
} else if (group === 'hash') {
  cases = [current];
  for (const hash of ['fnv', 'rotate', 'shift', 'dual']) {
    for (const scanBytes of [4, 8]) {
      cases.push({
        name: `${hash}, ${scanBytes}-byte scanner`,
        env: { ...experimental, HASH_MODE: hash, SCAN_BYTES: String(scanBytes) },
      });
    }
  }
} else if (group === 'lean') {
  const base = { ENGINE: 'lean' };
  cases = [
    current,
    { name: 'lean control', env: base },
    { name: 'lean fused48', env: { ...base, RECORD_LAYOUT: 'fused', RECORD_BYTES: '48' } },
    { name: 'lean fused64', env: { ...base, RECORD_LAYOUT: 'fused', RECORD_BYTES: '64' } },
    { name: 'lean fnv8', env: { ...base, SCAN_BYTES: '8' } },
    { name: 'lean rotate4', env: { ...base, HASH_MODE: 'rotate' } },
    { name: 'lean rotate8', env: { ...base, HASH_MODE: 'rotate', SCAN_BYTES: '8' } },
    { name: 'lean shift', env: { ...base, HASH_MODE: 'shift' } },
    { name: 'lean dual', env: { ...base, HASH_MODE: 'dual' } },
  ];
} else if (group === 'direct') {
  const base = { ENGINE: 'direct' };
  cases = [
    current,
    { name: 'direct control', env: base },
    { name: 'direct fused48', env: { ...base, RECORD_LAYOUT: 'fused', RECORD_BYTES: '48' } },
    { name: 'direct fused64', env: { ...base, RECORD_LAYOUT: 'fused', RECORD_BYTES: '64' } },
    { name: 'direct rotate', env: { ...base, HASH_MODE: 'rotate' } },
    { name: 'direct rotate-mix', env: { ...base, HASH_MODE: 'rotate-mix' } },
    {
      name: 'direct fused64 rotate-mix',
      env: { ...base, RECORD_LAYOUT: 'fused', RECORD_BYTES: '64', HASH_MODE: 'rotate-mix' },
    },
  ];
} else if (group === 'hybrid') {
  const pin = '0,1,2,3,4,5,6,7';
  cases = [
    current,
    { name: 'pinned uniform 2', env: { ENGINE: 'phased', PIN_WORKERS: pin } },
    {
      name: 'P2 E3 cursors',
      env: { ENGINE: 'hybrid', PIN_WORKERS: pin, CORE_STREAMS: '2,2,2,2,3,3,3,3' },
    },
    {
      name: 'P3 E2 cursors',
      env: { ENGINE: 'hybrid', PIN_WORKERS: pin, CORE_STREAMS: '3,3,3,3,2,2,2,2' },
    },
  ];
} else throw new Error('Choose layout, hash, lean, direct, or hybrid');

const child = spawnSync(process.execPath, ['tools/compare.mjs', `last-${group}`, file], {
  env: { ...process.env, RUNS: process.env.RUNS ?? '3', CASES: JSON.stringify(cases) },
  stdio: 'inherit',
});
if (child.error) throw child.error;
if (child.status !== 0) process.exit(child.status ?? 1);
