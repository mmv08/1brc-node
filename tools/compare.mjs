import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { nodeFlags, nodeRuntime, sourceHash } from './benchmark-config.mjs';

const group = process.argv[2] ?? 'layouts';
const file = process.argv[3] ?? 'measurements.txt';
const runs = Number(process.env.RUNS ?? 5);
const warmupRuns = Number(process.env.WARMUP ?? 0);
if (!Number.isInteger(warmupRuns) || warmupRuns < 0) throw new Error('Invalid WARMUP');
const runtime = nodeRuntime();
const version = execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim();
const expected = readFileSync(`${file}.out`, 'utf8');
const baseline = { name: 'baseline', env: { ENGINE: 'baseline', FLAGS: '' } };
const flat = { ENGINE: 'flat', STREAMS: '1' };
const candidates = {
  final: [
    baseline,
    {
      name: 'phased 2 branchless',
      env: { ENGINE: 'phased', STREAMS: '2', NAME_COMPARE: 'branchless' },
    },
  ],
  layouts: [
    baseline,
    { name: 'objects, 1 cursor', env: { ENGINE: 'objects', STREAMS: '1' } },
    { name: 'flat, 1 cursor', env: flat },
    { name: 'flat, 2 cursors', env: { ...flat, STREAMS: '2' } },
  ],
  ilp: [
    baseline,
    ...[1, 2, 3, 4].map((streams) => ({
      name: `flat, ${streams} cursors, larger inlining budget`,
      env: {
        ...flat,
        STREAMS: String(streams),
        FLAGS: '--max-inlined-bytecode-size=2000 --max-inlined-bytecode-size-cumulative=20000',
      },
    })),
  ],
  io: [
    baseline,
    { name: 'flat, sync', env: flat },
    { name: 'flat, macro', env: { ...flat, IO: 'macro', PRIVATE_FD: '1' } },
    {
      name: 'flat, async 512 KiB',
      env: { ...flat, IO: 'async', CHUNK_BYTES: '524288', PRIVATE_FD: '1' },
    },
  ],
  threads: [
    baseline,
    ...[7, 8, 9].map((workers) => ({
      name: `flat, ${workers} workers`,
      env: { ...flat, WORKERS: String(workers) },
    })),
    { name: 'flat, pinned', env: { ...flat, PIN_WORKERS: '0,1,2,3,4,5,6,7' } },
  ],
};
const cases = process.env.CASES ? JSON.parse(process.env.CASES) : candidates[group];
if (!cases || !Number.isInteger(runs) || runs < 1) throw new Error('Invalid cases or RUNS');
mkdirSync('results', { recursive: true });
const stamp = Date.now();
const report = {
  date: new Date().toISOString(),
  runtime,
  version,
  file,
  group,
  cache: process.env.COLD === '1' ? 'per-file POSIX_FADV_DONTNEED before each run' : 'warm',
  perf: process.env.PERF === '1',
  warmups: [],
  outputSha256: createHash('sha256').update(expected).digest('hex'),
  cases: cases.map((c) => ({
    ...c,
    sourceSha256: sourceHash(c.env.ENGINE),
    times: [],
    usage: [],
    counters: [],
    conditions: [],
  })),
};

// Warm hardware/cache state, not a reusable parser or dictionary: every warm-up
// and measured run starts a fresh process and must produce the correct result.
for (let i = 0; i < warmupRuns; i++) {
  const env = { ...process.env, ENGINE: 'phased', STREAMS: '2' };
  const args = [...nodeFlags(env), 'calculate.mjs', file];
  const start = performance.now();
  const output = execFileSync(
    env.CPU_SET ? 'taskset' : runtime,
    env.CPU_SET ? ['-c', env.CPU_SET, runtime, ...args] : args,
    { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (output !== expected) throw new Error('Incorrect warm-up output');
  const seconds = (performance.now() - start) / 1000;
  report.warmups.push(seconds);
  console.log(`Warm-up ${i + 1}: ${seconds.toFixed(3)}s, correct`);
}

function conditions() {
  const read = (path) => {
    try {
      return readFileSync(path, 'utf8').trim();
    } catch {
      return null;
    }
  };
  const temperatures = {};
  for (const hwmon of readdirSync('/sys/class/hwmon')) {
    const path = `/sys/class/hwmon/${hwmon}`;
    for (const input of readdirSync(path).filter((name) => /^temp\d+_input$/.test(name))) {
      temperatures[`${read(`${path}/name`)}:${input}`] = Number(read(`${path}/${input}`)) / 1000;
    }
  }
  return {
    temperatures,
    frequenciesKHz: Array.from({ length: 8 }, (_, cpu) =>
      Number(read(`/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_cur_freq`)),
    ),
  };
}

function save() {
  writeFileSync(`results/${stamp}-compare-${group}.json`, `${JSON.stringify(report, null, 2)}\n`);
}
for (let round = 0; round < runs; round++) {
  // AB... / ...BA order balances first-run effects and gradual thermal changes.
  const order = round % 2 ? report.cases.toReversed() : report.cases;
  for (const c of order) {
    const env = { ...process.env, ...c.env };
    if (process.env.COLD === '1') execFileSync('python3', ['tools/evict-input.py', file]);
    const flags = nodeFlags(env);
    const args = [...flags, 'calculate.mjs', file];
    const command = env.CPU_SET
      ? ['taskset', '-c', env.CPU_SET, runtime, ...args]
      : [runtime, ...args];
    const usageFile = `results/${stamp}-usage.json`;
    const perfFile = `results/${stamp}-${round}-${report.cases.indexOf(c)}-perf.csv`;
    const measured =
      env.PERF === '1'
        ? [
            'perf',
            'stat',
            '--no-big-num',
            '-x',
            ';',
            '-o',
            perfFile,
            '-e',
            'cycles:u,instructions:u,branches:u,branch-misses:u',
            '--',
            ...command,
          ]
        : command;
    const before = conditions();
    const start = performance.now();
    const child = spawn(
      '/usr/bin/time',
      [
        '-o',
        usageFile,
        '-f',
        '{"user":%U,"system":%S,"maxRssKiB":%M,"filesystemInputs":%I,"minorFaults":%R,"contextSwitches":%c}',
        ...measured,
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
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`Exit ${code}`))));
    });
    const seconds = (performance.now() - start) / 1000;
    if (output !== expected) throw new Error(`Incorrect output: ${c.name}`);
    c.times.push(seconds);
    c.usage.push(JSON.parse(readFileSync(usageFile, 'utf8')));
    c.conditions.push({ before, after: conditions() });
    const counters = {};
    if (env.PERF === '1') {
      for (const line of readFileSync(perfFile, 'utf8').split('\n')) {
        const fields = line.split(';');
        const count = Number(fields[0]);
        if (!Number.isFinite(count) || fields.length < 3) continue;
        const event = fields[2];
        const name = event.includes('branch-misses')
          ? 'branchMisses'
          : event.includes('instructions')
            ? 'instructions'
            : event.includes('branches')
              ? 'branches'
              : event.includes('cycles')
                ? 'cycles'
                : null;
        if (name) counters[name] = (counters[name] ?? 0) + count;
      }
    }
    c.counters.push(counters);
    console.log(
      `${round + 1}: ${c.name}: ${seconds.toFixed(3)}s; CPU ${(c.usage.at(-1).user + c.usage.at(-1).system).toFixed(2)}s${counters.instructions ? `; ${(counters.instructions / 1e9).toFixed(2)}B instructions` : ''}, correct`,
    );
    save();
  }
}
for (const c of report.cases) {
  const sorted = c.times.toSorted((a, b) => a - b);
  const kept = runs >= 5 ? sorted.slice(1, -1) : sorted;
  c.average = kept.reduce((sum, value) => sum + value, 0) / kept.length;
  console.log(`${c.name}: ${c.average.toFixed(3)}s ${runs >= 5 ? 'trimmed mean' : 'mean'}`);
}
save();
