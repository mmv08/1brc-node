import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { calculate as wasm } from '../calculate.mjs';
import { format } from '../lib/format.mjs';
import { calculate as plain } from '../plain/calculate.mjs';
import { sourceHash } from './benchmark-config.mjs';

const file = process.argv[2] ?? 'measurements.txt';
const expectedRows = Number(process.argv[3]);
if (!Number.isSafeInteger(expectedRows) || expectedRows < 0 || expectedRows > 1_000_000_000) {
  throw new Error('Usage: node tools/verify-engines.mjs [input] <expected rows, 0..1e9>');
}
const sort = (rows) => rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
const nodeRows = sort(await plain(file));
const wasmRows = sort(await wasm(file));
assert.deepEqual(nodeRows, wasmRows, 'Station names and exact min/sum/max/count tuples differ');
assert.equal(
  nodeRows.reduce((total, row) => total + row[4], 0),
  expectedRows,
);
assert.equal(format(nodeRows), readFileSync(`${file}.out`, 'utf8'));
const report = {
  date: new Date().toISOString(),
  nodeVersion: process.version,
  file,
  measurements: expectedRows,
  stations: nodeRows.length,
  exactTuplesMatch: true,
  expectedStdoutMatches: true,
  sources: { node: sourceHash('node'), wasm: sourceHash('wasm') },
};
mkdirSync('results', { recursive: true });
const path = `results/${Date.now()}-${process.pid}-verify-engines.json`;
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `Verified ${expectedRows} measurements and ${nodeRows.length} stations: exact tuples and complete output match.`,
);
console.log(`Report: ${path}`);
