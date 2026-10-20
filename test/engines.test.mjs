import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { calculate as wasm } from '../calculate.mjs';
import { format } from '../lib/format.mjs';
import { calculate as plain } from '../plain/calculate.mjs';
import { entryScript, nodeFlags, sourceHash } from '../tools/benchmark-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cleanEnv = () => {
  const env = { ...process.env, NODE_BIN: process.execPath, WORKERS: '4', CHUNK_BYTES: '128' };
  for (const key of ['ENGINE', 'SCRIPT', 'FLAGS', 'CASES', 'RUNS', 'WARMUP']) delete env[key];
  return env;
};
const sorted = (rows) => rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

async function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), '1brc-both-'));
  try {
    const file = join(directory, 'input with spaces.txt');
    const text = 'ABCD;-0.0\r\nABCDlong;-99.9\n東京;99.9\nA;0.1\n'.repeat(100);
    writeFileSync(file, text);
    const expected =
      '{A=0.1/0.1/0.1, ABCD=0.0/0.0/0.0, ABCDlong=-99.9/-99.9/-99.9, 東京=99.9/99.9/99.9}\n';
    writeFileSync(`${file}.out`, expected);
    await run({ directory, file, expected });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test('node and wasm return identical exact tuples with one and multiple workers', async () => {
  await fixture(async ({ file, expected }) => {
    const exact = sorted([
      ['ABCD', 0, 0, 0, 100],
      ['ABCDlong', -999, -99900, -999, 100],
      ['東京', 999, 99900, 999, 100],
      ['A', 1, 100, 1, 100],
    ]);
    for (const workers of [1, 4]) {
      for (const calculate of [plain, wasm]) {
        const rows = await calculate(file, { workers, chunkSize: 128 });
        assert.deepEqual(sorted(rows), exact);
        assert.equal(format(rows), expected);
      }
    }
  });
});

test('launcher selects both engines, defaults to wasm, and rejects unknown engines', async () => {
  await fixture(async ({ file, expected }) => {
    for (const engine of [undefined, 'node', 'wasm']) {
      const env = cleanEnv();
      if (engine) env.ENGINE = engine;
      const child = spawnSync('sh', [join(root, 'run.sh'), file], { env, encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, expected);
    }
    const child = spawnSync('sh', [join(root, 'run.sh'), file], {
      env: { ...cleanEnv(), ENGINE: 'invalid' },
      encoding: 'utf8',
    });
    assert.equal(child.status, 2);
    assert.equal(child.stdout, '');
    assert.match(child.stderr, /ENGINE must be node or wasm/);
  });
});

test('plain launcher runs without any wasm files or npm dependencies', async () => {
  await fixture(async ({ directory, file, expected }) => {
    const copy = join(directory, 'portable');
    mkdirSync(join(copy, 'lib'), { recursive: true });
    cpSync(join(root, 'plain'), join(copy, 'plain'), { recursive: true });
    cpSync(join(root, 'lib/format.mjs'), join(copy, 'lib/format.mjs'));
    cpSync(join(root, 'run.sh'), join(copy, 'run.sh'));
    const child = spawnSync('sh', [join(copy, 'run.sh'), file], {
      env: { ...cleanEnv(), ENGINE: 'node' },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, expected);
  });
});

test('benchmark config selects the right flags and hashes the shared formatter', async () => {
  assert.equal(entryScript(), 'calculate.mjs');
  assert.equal(entryScript('node'), 'plain/calculate.mjs');
  assert.throws(() => entryScript('invalid'), /ENGINE/);
  assert.deepEqual(nodeFlags({ ENGINE: 'wasm' }), []);
  assert.equal(nodeFlags({ ENGINE: 'node' }).length, 2);
  assert.deepEqual(nodeFlags({ ENGINE: 'node', FLAGS: '' }), []);
  await fixture(async ({ directory }) => {
    const fake = join(directory, 'plain');
    mkdirSync(join(fake, 'lib'), { recursive: true });
    mkdirSync(join(directory, 'lib'));
    writeFileSync(join(fake, 'calculate.mjs'), '// entry\n');
    writeFileSync(join(fake, 'lib/aggregate.mjs'), '// parser\n');
    const formatter = join(directory, 'lib/format.mjs');
    writeFileSync(formatter, '// original\n');
    const first = sourceHash('node', join(fake, 'calculate.mjs'));
    writeFileSync(formatter, '// changed\n');
    assert.notEqual(sourceHash('node', join(fake, 'calculate.mjs')), first);
  });
});

test('comparison warms up both versions and records engine-specific defaults', async () => {
  await fixture(async ({ file }) => {
    const env = { ...cleanEnv(), RUNS: '1', WARMUP: '1' };
    delete env.CHUNK_BYTES;
    const child = spawnSync(process.execPath, ['tools/compare.mjs', 'integration', file], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    const path = child.stdout.match(/Report: (results\/[^\n]+\.json)/)?.[1];
    assert.ok(path, child.stdout);
    const reportFile = join(root, path);
    try {
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      assert.equal(report.complete, true);
      assert.equal(report.warmups.length, 2);
      assert.deepEqual(
        report.cases.map((entry) => entry.env.ENGINE),
        ['node', 'wasm'],
      );
      assert.deepEqual(
        report.cases.map((entry) => entry.chunkBytes),
        [131072, 524288],
      );
      for (const entry of report.cases) {
        assert.equal(entry.times.length, 1);
        assert.equal(entry.usage.length, 1);
        assert.equal(entry.sourceSha256, sourceHash(entry.env.ENGINE, entry.script));
      }
    } finally {
      rmSync(reportFile);
    }
  });
});
