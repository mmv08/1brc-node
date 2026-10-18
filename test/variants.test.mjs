import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { calculate } from '../calculate.mjs';
import { format } from '../lib/format.mjs';

test('experimental layouts, cursors, readers, temperature parsers and table growth', async () => {
  const directory = mkdtempSync(join(tmpdir(), '1brc-variants-'));
  const file = join(directory, 'input.txt');
  const expected = new Map();
  let input = '';
  for (let i = 0; i < 30000; i++) {
    const key = i % 10000;
    const name = `${'é'.repeat(key % 30)}-${key}`;
    const value = ((i * 97) % 1999) - 999;
    input += `${name};${(value / 10).toFixed(1)}${i % 2 ? '\r\n' : '\n'}`;
    const row = expected.get(name);
    if (row) {
      row[1] = Math.min(row[1], value);
      row[2] += value;
      row[3] = Math.max(row[3], value);
      row[4]++;
    } else expected.set(name, [name, value, value, value, 1]);
  }
  writeFileSync(file, input.slice(0, -2)); // Last row uses CRLF; remove both bytes.
  const output = format([...expected.values()]);
  const names = [
    'IO',
    'STREAMS',
    'TEMPERATURE',
    'TABLE_BITS',
    'STATS',
    'PRIVATE_FD',
    'MACRO_BYTES',
    'NAME_COMPARE',
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  let variant = 0;
  try {
    for (const engine of ['objects', 'flat', 'soa', 'phased', 'masked']) {
      for (const io of ['sync', 'macro', 'async']) {
        for (const streams of [1, 2, 3, 4]) {
          process.env.IO = io;
          process.env.STREAMS = String(streams);
          process.env.TEMPERATURE = ['table', 'compact', 'arithmetic'][variant++ % 3];
          process.env.TABLE_BITS = engine === 'soa' ? '10' : '14';
          process.env.STATS = streams % 2 ? 'arrays' : 'packed';
          process.env.NAME_COMPARE = streams % 2 ? 'branchy' : 'branchless';
          process.env.PRIVATE_FD = streams % 2 ? '0' : '1';
          process.env.MACRO_BYTES = '65536';
          assert.equal(
            format(await calculate(file, { engine, workers: 3, chunkSize: 16384 })),
            output,
            `${engine}, ${io}, ${streams} cursors`,
          );
        }
      }
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true });
  }
});
