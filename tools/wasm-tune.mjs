import { spawnSync } from 'node:child_process';

const file = process.argv[2] ?? 'measurements-100m.txt';
const cases = [{ name: 'JavaScript current', env: { ENGINE: 'phased' } }];
for (const variant of ['scalar', 'simd']) {
  for (const streams of [1, 2, 3, 4]) {
    cases.push({
      name: `Wasm ${variant}, ${streams} cursors`,
      env: { ENGINE: 'wasm', WASM_VARIANT: variant, WASM_STREAMS: String(streams) },
    });
  }
}
const child = spawnSync(process.execPath, ['tools/compare.mjs', 'wasm-screen', file], {
  env: { ...process.env, RUNS: process.env.RUNS ?? '3', CASES: JSON.stringify(cases) },
  stdio: 'inherit',
});
if (child.error) throw child.error;
if (child.status !== 0) process.exit(child.status ?? 1);
