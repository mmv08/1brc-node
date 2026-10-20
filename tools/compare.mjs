import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { benchmarkEnv, entryScript, nodeFlags, nodeRuntime, sourceHash } from './benchmark-config.mjs';

// Generic external-process comparisons also accept scripts from git worktrees.
const label = process.argv[2] ?? 'node-vs-wasm';
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('Invalid comparison label');
const file = process.argv[3] ?? 'measurements.txt';
const runs = Number(process.env.RUNS ?? 5);
const warmups = Number(process.env.WARMUP ?? 1);
if (![runs, warmups].every(Number.isSafeInteger) || runs < 1 || warmups < 0)
  throw new Error('Invalid RUNS/WARMUP');
const runtime = nodeRuntime();
const expected = readFileSync(`${file}.out`, 'utf8');
const cases = process.env.CASES
  ? JSON.parse(process.env.CASES)
  : [
      { name: 'Plain Node.js', env: { ENGINE: 'node' } },
      { name: 'Wasm SIMD', env: { ENGINE: 'wasm' } },
    ];
if (!Array.isArray(cases) || !cases.length) throw new Error('CASES must be a nonempty array');
mkdirSync('results', { recursive: true });
const stamp = `${Date.now()}-${process.pid}`;
const report = {
  date: new Date().toISOString(),
  label,
  file,
  bytes: statSync(file).size,
  cpu: cpus()[0].model,
  runtime,
  version: execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim(),
  outputSha256: createHash('sha256').update(expected).digest('hex'),
  warmups: [],
  complete: false,
  cases: cases.map((entry) => {
    if (typeof entry.name !== 'string' || !entry.name) throw new Error('Each case needs a name');
    const engine = entry.env?.ENGINE ?? process.env.ENGINE ?? 'wasm';
    const script = entry.script ?? entryScript(engine);
    const env = { ...process.env, ...entry.env, ENGINE: engine };
    return {
      ...entry,
      script,
      env: { ...benchmarkEnv(env), ...entry.env, ENGINE: engine },
      flags: nodeFlags(env),
      requestedWorkers: Number(env.WORKERS ?? availableParallelism()),
      chunkBytes: Number(env.CHUNK_BYTES ?? (engine === 'wasm' ? 524288 : 131072)),
      sourceSha256: sourceHash(engine, script),
      times: [],
      usage: [],
    };
  }),
};
const save = () =>
  writeFileSync(`results/${stamp}-compare-${label}.json`, `${JSON.stringify(report, null, 2)}\n`);
const verifySource = (entry) => {
  if (sourceHash(entry.env.ENGINE, entry.script) !== entry.sourceSha256)
    throw new Error(`Source changed during comparison: ${entry.name}`);
};
save();
for (let round = 0; round < warmups; round++) {
  for (const entry of round % 2 ? report.cases.toReversed() : report.cases) {
    verifySource(entry);
    const env = { ...process.env, ...entry.env };
    const start = performance.now();
    const output = execFileSync(runtime, [...entry.flags, entry.script, file], {
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const seconds = (performance.now() - start) / 1000;
    verifySource(entry);
    if (output !== expected) throw new Error(`Incorrect warm-up output: ${entry.name}`);
    report.warmups.push({ name: entry.name, round: round + 1, seconds });
    save();
    console.log(`Warm-up ${round + 1}: ${entry.name}: ${seconds.toFixed(3)}s, correct`);
  }
}
for (let round = 0; round < runs; round++) {
  for (const entry of round % 2 ? report.cases.toReversed() : report.cases) {
    verifySource(entry);
    const env = { ...process.env, ...entry.env };
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
        ...entry.flags,
        entry.script,
        file,
      ],
      { env, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      output += data;
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) =>
        code === 0 ? resolve() : reject(new Error(`Exit ${code}, signal ${signal}`)),
      );
    });
    const seconds = (performance.now() - start) / 1000;
    verifySource(entry);
    if (output !== expected) throw new Error(`Incorrect output: ${entry.name}`);
    entry.times.push(seconds);
    entry.usage.push(JSON.parse(readFileSync(usageFile, 'utf8')));
    console.log(`${round + 1}: ${entry.name}: ${seconds.toFixed(3)}s, correct`);
    save();
  }
}
for (const entry of report.cases) {
  const sorted = entry.times.toSorted((a, b) => a - b);
  const kept = runs >= 5 ? sorted.slice(1, -1) : sorted;
  entry.average = kept.reduce((a, b) => a + b, 0) / kept.length;
  entry.best = sorted[0];
  console.log(`${entry.name}: ${entry.average.toFixed(3)}s ${runs >= 5 ? 'trimmed mean' : 'mean'}`);
}
report.complete = true;
save();
console.log(`Report: results/${stamp}-compare-${label}.json`);
