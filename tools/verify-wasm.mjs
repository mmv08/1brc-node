import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculate } from '../calculate.mjs';
import { format } from '../lib/format.mjs';

const file = process.argv[2] ?? 'measurements.txt';
const expectedCount = Number(process.argv[3] ?? 1_000_000_000);
const start = performance.now();
const rows = await calculate(file);
const count = rows.reduce((sum, row) => sum + row[4], 0);
assert.equal(count, expectedCount, 'exact total measurement count');
assert.equal(format(rows), readFileSync(`${file}.out`, 'utf8'), 'complete formatted result');
console.log(
  `Verified ${count.toLocaleString()} measurements, ${rows.length} stations, ${((performance.now() - start) / 1000).toFixed(3)}s`,
);
