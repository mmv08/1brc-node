import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { basename } from 'node:path';
import { entryScript, nodeFlags, nodeRuntime, sourceHash } from './benchmark-config.mjs';

const file = process.argv[2] ?? 'measurements.txt';
const runs = Number(process.env.RUNS ?? 5);
if (!Number.isInteger(runs) || runs < 1) throw new Error('RUNS must be a positive integer');
const runtime = nodeRuntime();
const engine = process.env.ENGINE ?? 'wasm';
const script = process.env.SCRIPT ?? entryScript(engine);
const flags =
  basename(script) === 'calculate.mjs'
    ? nodeFlags({ ...process.env, ENGINE: engine })
    : (process.env.FLAGS ?? '').split(/\s+/).filter(Boolean);
const expected = readFileSync(`${file}.out`, 'utf8');
const results = [];
for (let i = 0; i < runs; i++) {
  const start = performance.now();
  const child = spawn(runtime, [...flags, script, file], { stdio: ['ignore', 'pipe', 'inherit'] });
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
  if (output !== expected) throw new Error('Incorrect output');
  results.push(seconds);
  console.log(
    `${i + 1}: ${seconds.toFixed(3)}s (${(statSync(file).size / seconds / 1e9).toFixed(2)} GB/s), correct`,
  );
}
const sorted = results.toSorted((a, b) => a - b);
const kept = runs >= 5 ? sorted.slice(1, -1) : sorted;
const average = kept.reduce((a, b) => a + b, 0) / kept.length;
console.log(
  `${runs >= 5 ? 'Trimmed mean' : 'Mean'}: ${average.toFixed(3)}s; best: ${sorted[0].toFixed(3)}s`,
);
mkdirSync('results', { recursive: true });
writeFileSync(
  `results/${Date.now()}-bench.json`,
  `${JSON.stringify(
    {
      date: new Date().toISOString(),
      runtime,
      version: execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim(),
      script,
      engine,
      flags,
      workers: Number(process.env.WORKERS ?? availableParallelism()),
      chunkBytes: Number(process.env.CHUNK_BYTES ?? (engine === 'node' ? 131072 : 524288)),
      cpu: cpus()[0].model,
      file,
      bytes: statSync(file).size,
      outputSha256: createHash('sha256').update(expected).digest('hex'),
      sourceSha256: sourceHash(engine, script),
      results,
      average,
    },
    null,
    2,
  )}\n`,
);
