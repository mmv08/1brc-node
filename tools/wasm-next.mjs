import { spawnSync } from 'node:child_process';
import { variants } from '../wasm/variants.mjs';

const group = process.argv[2] ?? 'locality';
const file = process.argv[3] ?? 'measurements-100m.txt';
const groups = {
  locality: [
    'next-control',
    'next-adaptive1k',
    'next-adaptive',
    'next-adaptive4k',
    'next-compact',
    'next-local',
  ],
  compiler: ['next-control', 'next-cold', 'next-o2', 'next-os', 'next-local-cold', 'next-local-o2'],
  finalists: ['next-cold', 'next-compact', 'next-compact-cold', 'next-cold-o2', 'next-cold-os'],
  streaming: [
    'next-control',
    'next-stream16',
    'next-stream32',
    'next-stream64',
    'next-stream-local',
  ],
};
if (!groups[group]) throw new Error('Choose locality, compiler, streaming, or finalists');
const cases = [
  {
    name: 'current Wasm',
    env: { ENGINE: 'wasm', WASM_VARIANT: 'simd-pointers', WASM_STREAMS: '4' },
  },
];
for (const variant of groups[group]) {
  const definition = variants.find((v) => v.variant === variant);
  cases.push({
    name: variant,
    env: {
      ENGINE: 'wasm',
      WASM_VARIANT: variant,
      WASM_STREAMS: definition.features.STREAMING_SCAN ? '1' : '4',
    },
  });
}
const child = spawnSync(process.execPath, ['tools/compare.mjs', `wasm-next-${group}`, file], {
  env: { ...process.env, RUNS: process.env.RUNS ?? '3', CASES: JSON.stringify(cases) },
  stdio: 'inherit',
});
if (child.error) throw child.error;
if (child.status !== 0) process.exit(child.status ?? 1);
