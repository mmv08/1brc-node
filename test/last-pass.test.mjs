import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { calculate } from '../calculate.mjs';
import { format } from '../lib/format.mjs';

test('last-pass layouts, batching, scan unrolling and hashing remain equivalent', async () => {
  const directory = mkdtempSync(join(tmpdir(), '1brc-last-pass-'));
  const file = join(directory, 'input.txt');
  const rows = new Map();
  const shortNames = [
    'A',
    'AB',
    'ABC',
    'ABCD',
    'ABCDE',
    'ABCDEF',
    'ABCDEFG',
    'ABCDEFGH',
    'é',
    '東京',
    '\u0000',
    ':',
  ];
  let input = '';
  for (let i = 0; i < 30000; i++) {
    const key = i % 10000;
    const name =
      shortNames[key] ??
      (key % 13 === 0
        ? `${'a'.repeat(95)}${String(key).padStart(5, '0')}`
        : `${'é-prefix-'.repeat(key % 8)}-${key}-🌡`);
    const value = ((i * 97) % 1999) - 999;
    input += `${name};${(value / 10).toFixed(1)}${i % 2 ? '\r\n' : '\n'}`;
    const row = rows.get(name);
    if (row) {
      row[1] = Math.min(row[1], value);
      row[2] += value;
      row[3] = Math.max(row[3], value);
      row[4]++;
    } else rows.set(name, [name, value, value, value, 1]);
  }
  writeFileSync(file, input.slice(0, -2));
  const expectedRows = [...rows.values()];
  const expected = format(expectedRows);
  async function check(engine, label, workers = 3) {
    const actual = await calculate(file, { engine, workers, chunkSize: 16384 });
    assert.equal(format(actual), expected, label);
    // Rounded means alone could hide matching sum/count errors or duplicated
    // rows. Compare all exact aggregate fields as well as the challenge output.
    assert.deepEqual(actual, expectedRows, label);
  }
  const names = [
    'RECORD_LAYOUT',
    'RECORD_BYTES',
    'HASH_MODE',
    'PIPELINE',
    'SCAN_BYTES',
    'BATCH_SIZE',
    'REDUCE_WIDTH',
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  let variant = 0;
  try {
    for (const layout of ['split', 'fused48', 'fused64']) {
      for (const hash of ['fnv', 'rotate', 'shift', 'dual']) {
        for (const pipeline of ['phased', 'tiled']) {
          for (const scanBytes of ['4', '8']) {
            process.env.RECORD_LAYOUT = layout === 'split' ? 'split' : 'fused';
            process.env.RECORD_BYTES = layout === 'fused64' ? '64' : '48';
            process.env.HASH_MODE = hash;
            process.env.PIPELINE = pipeline;
            process.env.SCAN_BYTES = scanBytes;
            process.env.BATCH_SIZE = String([16, 32, 64, 128][variant % 4]);
            process.env.REDUCE_WIDTH = variant++ % 2 ? '1' : '4';
            await check('round3', `${layout}, ${hash}, ${pipeline}, ${scanBytes}-byte scanner`);
          }
        }
      }
    }
    process.env.PIPELINE = 'phased';
    for (const layout of ['split', 'fused48', 'fused64']) {
      for (const hash of ['fnv', 'rotate', 'shift', 'dual']) {
        for (const scanBytes of hash === 'fnv' || hash === 'rotate' ? ['4', '8'] : ['4']) {
          process.env.RECORD_LAYOUT = layout === 'split' ? 'split' : 'fused';
          process.env.RECORD_BYTES = layout === 'fused64' ? '64' : '48';
          process.env.HASH_MODE = hash;
          process.env.SCAN_BYTES = scanBytes;
          await check('lean', `specialized ${layout}, ${hash}, ${scanBytes}-byte scanner`);
        }
      }
    }
    for (const layout of ['split', 'fused48', 'fused64']) {
      for (const hash of ['fnv', 'rotate', 'rotate-mix']) {
        process.env.RECORD_LAYOUT = layout === 'split' ? 'split' : 'fused';
        process.env.RECORD_BYTES = layout === 'fused64' ? '64' : '48';
        process.env.HASH_MODE = hash;
        await check('direct', `direct ${layout}, ${hash}`);
      }
    }
    await check('hybrid', 'different cursor counts across workers', 6);
    // Force actual full-hash collisions, not merely hash-table slot collisions.
    // The cached first, second and last words also match; middle bytes must win.
    writeFileSync(
      file,
      Array.from(
        { length: 64 },
        (_, i) => `HEADSAME${String(i).padStart(8, '0')}TAIL;${(i / 10).toFixed(1)}\n`,
      ).join(''),
    );
    process.env.HASH_MODE = 'constant';
    const collisionRows = Array.from({ length: 64 }, (_, i) => [
      `HEADSAME${String(i).padStart(8, '0')}TAIL`,
      i,
      i,
      i,
      1,
    ]);
    const collisionExpected = format(collisionRows);
    for (const pipeline of ['phased', 'tiled']) {
      process.env.PIPELINE = pipeline;
      const actual = await calculate(file, { engine: 'round3', workers: 3, chunkSize: 128 });
      assert.equal(format(actual), collisionExpected);
      assert.deepEqual(actual, collisionRows);
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true });
  }
});
