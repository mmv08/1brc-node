import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { nodeFlags, nodeRuntime, sourceHash } from './benchmark-config.mjs';

// Cases may point at scripts in different git worktrees. This is a generic
// process benchmark, not a runtime registry of discarded parser variants.
const label = process.argv[2] ?? 'current';
const file = process.argv[3] ?? 'measurements.txt';
const runs = Number(process.env.RUNS ?? 5);
const warmups = Number(process.env.WARMUP ?? 0);
if (![runs, warmups].every(Number.isInteger) || runs < 1 || warmups < 0)
  throw new Error('Invalid RUNS/WARMUP');
const runtime = nodeRuntime();
const expected = readFileSync(`${file}.out`, 'utf8');
const cases = process.env.CASES
  ? JSON.parse(process.env.CASES)
  : [{ name: 'Wasm SIMD', env: { ENGINE: 'wasm' } }];
mkdirSync('results', { recursive: true });
const stamp = Date.now();
const report = {
  date: new Date().toISOString(),
  label,
  file,
  runtime,
  version: execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim(),
  outputSha256: createHash('sha256').update(expected).digest('hex'),
  warmups: [],
  cases: cases.map((c) => ({
    ...c,
    sourceSha256: sourceHash(c.env?.ENGINE, c.script),
    times: [],
    usage: [],
  })),
};
for (let i = 0; i < warmups; i++) {
  const env = { ...process.env };
  const start = performance.now();
  const output = execFileSync(runtime, [...nodeFlags(env), 'calculate.mjs', file], {
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (output !== expected) throw new Error('Incorrect warm-up output');
  report.warmups.push((performance.now() - start) / 1000);
  console.log(`Warm-up ${i + 1}: ${report.warmups.at(-1).toFixed(3)}s, correct`);
}
for (let round = 0; round < runs; round++) {
  for (const c of round % 2 ? report.cases.toReversed() : report.cases) {
    const env = { ...process.env, ...c.env };
    const usageFile = `results/${stamp}-usage.json`;
    const start = performance.now();
    const child = spawn(
      '/usr/bin/time',
      [
        '-o',
        usageFile,
        '-f',
        '{"user":%U,"system":%S,"maxRssKiB":%M,"filesystemInputs":%I}',
        runtime,
        ...nodeFlags(env),
        c.script ?? 'calculate.mjs',
        file,
      ],
      {
        env,
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      output += data;
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`Exit ${code}`))));
    });
    const seconds = (performance.now() - start) / 1000;
    if (output !== expected) throw new Error(`Incorrect output: ${c.name}`);
    c.times.push(seconds);
    c.usage.push(JSON.parse(readFileSync(usageFile, 'utf8')));
    console.log(`${round + 1}: ${c.name}: ${seconds.toFixed(3)}s, correct`);
    writeFileSync(`results/${stamp}-compare-${label}.json`, `${JSON.stringify(report, null, 2)}\n`);
  }
}
for (const c of report.cases) {
  const sorted = c.times.toSorted((a, b) => a - b);
  const kept = runs >= 5 ? sorted.slice(1, -1) : sorted;
  c.average = kept.reduce((a, b) => a + b, 0) / kept.length;
  console.log(`${c.name}: ${c.average.toFixed(3)}s ${runs >= 5 ? 'trimmed mean' : 'mean'}`);
}
writeFileSync(`results/${stamp}-compare-${label}.json`, `${JSON.stringify(report, null, 2)}\n`);
