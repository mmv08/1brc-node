import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { nodeFlags, nodeRuntime, sourceHash } from './benchmark-config.mjs';

const file = process.argv[2] ?? 'measurements.txt';
const runs = Number(process.env.RUNS ?? 5);
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('RUNS must be a positive integer');
const runtime = nodeRuntime();
const script = process.env.SCRIPT ?? 'calculate.mjs';
const flags =
  script === 'calculate.mjs'
    ? nodeFlags(process.env)
    : (process.env.FLAGS ?? '').split(/\s+/).filter(Boolean);
const version = execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim();
const expected = readFileSync(`${file}.out`, 'utf8');
const implementationHash = sourceHash(process.env.ENGINE ?? 'phased', script);
const results = [];
for (let i = 0; i < runs; i++) {
  const start = performance.now();
  const args = [...flags, script, file];
  const affinity = process.env.CPU_SET;
  const child = spawn(
    affinity ? 'taskset' : runtime,
    affinity ? ['-c', affinity, runtime, ...args] : args,
    {
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Exit ${code}, signal ${signal}`)),
    );
  });
  const seconds = (performance.now() - start) / 1000;
  if (output !== expected) throw new Error(`Incorrect output in run ${i + 1}`);
  results.push(seconds);
  console.log(
    `${i + 1}: ${seconds.toFixed(3)}s (${(statSync(file).size / seconds / 1e9).toFixed(2)} GB/s), correct`,
  );
}
const sorted = results.toSorted((a, b) => a - b);
const trimmed = sorted.length >= 5 ? sorted.slice(1, -1) : sorted;
const average = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
console.log(
  `${results.length >= 5 ? 'Trimmed mean' : 'Mean'}: ${average.toFixed(3)}s; best: ${sorted[0].toFixed(3)}s`,
);
mkdirSync('results', { recursive: true });
const report = {
  date: new Date().toISOString(),
  runtime,
  version,
  script,
  flags,
  workers: process.env.WORKERS ?? 'auto',
  chunkBytes: process.env.CHUNK_BYTES ?? 'default',
  engine: process.env.ENGINE ?? 'phased',
  label: process.env.BENCH_LABEL ?? '',
  streams:
    process.env.STREAMS ?? (process.env.ENGINE && process.env.ENGINE !== 'phased' ? '1' : '2'),
  io: process.env.IO ?? 'sync',
  tableBits: process.env.TABLE_BITS ?? '15',
  temperature: process.env.TEMPERATURE ?? 'table',
  nameCompare: process.env.NAME_COMPARE ?? 'branchless',
  stats: process.env.STATS ?? 'arrays',
  uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? 'default',
  privateFd: process.env.PRIVATE_FD ?? '0',
  cpuSet: process.env.CPU_SET ?? '',
  pinWorkers: process.env.PIN_WORKERS ?? '',
  cpu: cpus()[0].model,
  cores: cpus().length,
  memory: totalmem(),
  file,
  bytes: statSync(file).size,
  outputSha256: createHash('sha256').update(expected).digest('hex'),
  implementationSha256: implementationHash,
  results,
  average,
};
writeFileSync(
  `results/${Date.now()}-${script.split('/').at(-2) ?? 'local'}.json`,
  `${JSON.stringify(report, null, 2)}\n`,
);
