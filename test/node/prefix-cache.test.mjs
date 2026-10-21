import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { calculate } from '../../plain/calculate.mjs';

test('colliding predictions distinguish different first words with identical remaining bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), '1brc-prefix-head-'));
  const file = join(directory, 'input.txt');
  // Both names map to predictor slot 9591; only their first four bytes differ.
  const names = ['00y0SAMEtail', '010lSAMEtail'];
  const lines = [];
  for (let i = 0; i < 256; i++) {
    lines.push(`${names[0]};-99.9\n${names[0]};2.5\r\n`);
    lines.push(`${names[1]};99.9\r\n${names[1]};-1.2\n`);
  }
  writeFileSync(file, lines.join('').slice(0, -1));
  const expected = [
    [names[0], -999, (-999 + 25) * 256, 25, 512],
    [names[1], -12, (999 - 12) * 256, 999, 512],
  ];
  try {
    for (const workers of [1, 4]) {
      const rows = await calculate(file, { workers, chunkSize: 256 });
      assert.deepEqual(
        rows.sort((a, b) => (a[0] < b[0] ? -1 : 1)),
        expected,
      );
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('prefix predictions preserve exact tuples across lengths, NULs, tails and delimiters', async () => {
  const directory = mkdtempSync(join(tmpdir(), '1brc-prefix-'));
  const file = join(directory, 'input.txt');
  const names = [
    '\0',
    'A\0',
    'AB\0',
    'ABCD',
    'ABCD\0',
    'ABCD\0\0',
    'ABCDsameaaaabbbbTAIL',
    'ABCDsameccccbbbbTAIL',
    'ABCDsameaaaa\0bbbTAIL',
    'ABCDsameaaaabbb\0TAIL',
    'ABCDé東京',
    'ABCD🌡️',
    'é'.repeat(50),
    ...Array.from({ length: 97 }, (_, i) => `ABCD${'x'.repeat(i)}`),
  ];
  const expected = new Map();
  let input = '';
  let rowNumber = 0;
  function add(name, value) {
    input += `${name};${(value / 10).toFixed(1)}${rowNumber++ % 2 ? '\r\n' : '\n'}`;
    const row = expected.get(name);
    if (row) {
      row[1] = Math.min(row[1], value);
      row[2] += value;
      row[3] = Math.max(row[3], value);
      row[4]++;
    } else expected.set(name, [name, value, value, value, 1]);
  }
  for (let round = 0; round < 8; round++) {
    for (const name of round % 2 ? [...names].reverse() : names) {
      // Adjacent repeats exercise hits; changing lengths/tails exercises misses.
      add(name, ((rowNumber * 137) % 1999) - 999);
      add(name, ((rowNumber * 137) % 1999) - 999);
    }
  }
  // The wrong predicted end for ABCD lands on X's delimiter, not its own.
  // Full equality must reject the intervening semicolon/newline/temperature.
  for (let i = 0; i < 16; i++) {
    add('ABCDabcdef', 10);
    input += 'ABCD;0.0\nX;-2.0\n';
    for (const [name, value] of [
      ['ABCD', 0],
      ['X', -20],
    ]) {
      const row = expected.get(name);
      if (row) {
        row[1] = Math.min(row[1], value);
        row[2] += value;
        row[3] = Math.max(row[3], value);
        row[4]++;
      } else expected.set(name, [name, value, value, value, 1]);
    }
  }
  input = input.slice(0, -1); // Missing final LF.
  writeFileSync(file, input);
  const sorted = (rows) => rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const wanted = sorted([...expected.values()]);
  try {
    for (const chunkSize of [128, 129, 251, 4096]) {
      for (const workers of [1, 4]) {
        assert.deepEqual(
          sorted(await calculate(file, { workers, chunkSize })),
          wanted,
          `workers=${workers}, chunkSize=${chunkSize}`,
        );
      }
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});
