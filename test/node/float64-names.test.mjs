import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { calculate } from '../../plain/calculate.mjs';

test('exact names with zero words, DEL and UTF-8 boundaries in eight-byte comparisons', async () => {
  const names = new Set();
  for (const length of [7, 8, 9, 15, 16, 17, 23, 24, 25, 99, 100]) {
    names.add('\0'.repeat(length));
    names.add(`${'\0'.repeat(length - 1)}\x7f`);
  }
  const scalars = ['\x7f', '\u0080', '\u07ff', '\u0800', '\uffff', '\u{10000}', '\u{10ffff}'];
  for (const scalar of scalars) {
    for (let padding = 0; padding < 16; padding++) {
      names.add(`${'\0'.repeat(padding)}${scalar}${'\0'.repeat(24 - padding)}`);
      names.add(`HEADWORD${'\0'.repeat(padding)}${scalar}${'\0'.repeat(16 - padding)}TAILWORD`);
    }
  }
  names.add(`HEADWORDabcdefghTAILWORD`);
  names.add(`HEADWORDabcdXfghTAILWORD`);
  const expected = new Map();
  let text = '';
  let index = 0;
  function add(name, value, ending) {
    text += `${name};${(value / 10).toFixed(1)}${ending}`;
    const row = expected.get(name);
    if (row) {
      row[1] = Math.min(row[1], value);
      row[2] += value;
      row[3] = Math.max(row[3], value);
      row[4]++;
    } else expected.set(name, [name, value, value, value, 1]);
  }
  for (let round = 0; round < 3; round++) {
    for (const name of round % 2 ? [...names].reverse() : names) {
      const bytes = Buffer.from(name);
      assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(bytes), name);
      assert.ok(bytes.length >= 1 && bytes.length <= 100);
      add(name, ((index++ * 137) % 1999) - 999, index % 2 ? '\r\n' : '\n');
    }
  }
  // A long prediction for the same prefix must reject the short final name,
  // even when speculative comparisons extend into the reader's EOF padding.
  add('\0'.repeat(100), 123, '\n');
  add('\0'.repeat(5), -21, '');
  const sorted = (rows) => rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const wanted = sorted([...expected.values()]);
  const directory = mkdtempSync(join(tmpdir(), '1brc-wide-names-'));
  try {
    const file = join(directory, 'input.txt');
    writeFileSync(file, text);
    for (const workers of [1, 4]) {
      for (const chunkSize of [128, 129]) {
        assert.deepEqual(sorted(await calculate(file, { workers, chunkSize })), wanted);
      }
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});
