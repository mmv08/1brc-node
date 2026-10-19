import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import wabtFactory from 'wabt';
import { calculate } from '../calculate.mjs';
import { format } from '../lib/format.mjs';
import { createKernel } from '../wasm/engine.mjs';

function fill(buffer, text) {
  const length = buffer.write(text);
  buffer.fill(0, length, length + 32);
  buffer[length] = 10;
  return length;
}

test('shipped kernel matches its source/build hashes, uses SIMD, and has no imports', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../wasm/build.json', import.meta.url), 'utf8'));
  assert.equal(
    manifest.sourceSha256,
    createHash('sha256')
      .update(readFileSync(new URL('../wasm/kernel.c', import.meta.url)))
      .digest('hex'),
    'rebuild C source',
  );
  const bytes = readFileSync(new URL('../wasm/kernel.wasm', import.meta.url));
  assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)), []);
  const wabt = await wabtFactory();
  const module = wabt.readWasm(Uint8Array.from(bytes), { readDebugNames: true });
  try {
    const wat = module.toText({ foldExprs: false });
    assert.match(wat, /i8x16\.eq/);
    assert.match(wat, /i8x16\.bitmask/);
  } finally {
    module.destroy();
  }
});

test('input aliases grown Wasm memory and reset clears the previous aggregates', async () => {
  const size = 1024 * 1024;
  const kernel = await createKernel(size);
  const buffer = kernel.allocateBuffer(size + 256);
  assert.equal(buffer.buffer, kernel.memory);
  assert.equal(kernel.memory, kernel.api.memory.buffer);
  const parse = kernel.makeParser(buffer);
  const length = fill(buffer, '東京;-99.9\r\nA;99.9\nA;0.1');
  parse(0, length);
  assert.equal(format(kernel.rows()), '{A=0.1/50.0/99.9, 東京=-99.9/-99.9/-99.9}\n');
  kernel.api.reset();
  assert.deepEqual(kernel.rows(), []);
  parse(0, length);
  assert.equal(
    kernel.rows().reduce((sum, row) => sum + row[4], 0),
    3,
  );
});

test('signed 64-bit sums handle the full challenge bound', async () => {
  for (const value of [-999, 999]) {
    const kernel = await createKernel(128);
    const buffer = kernel.allocateBuffer(384);
    const length = fill(buffer, `A;${(value / 10).toFixed(1)}\n`);
    const parse = kernel.makeParser(buffer);
    parse(0, length);
    const view = new DataView(kernel.memory);
    const base = kernel.api.stations_base();
    // Unit-test prefix state, never used by a benchmark or the actual solver.
    view.setBigInt64(base, BigInt(value * 999999999), true);
    view.setUint32(base + 8, 999999999, true);
    parse(0, length);
    assert.deepEqual(kernel.rows(), [['A', value, value * 1e9, value, 1e9]]);
  }
});

test('10K keys, 100-byte/UTF-8/NUL names and chunk boundaries preserve exact aggregates', async () => {
  const directory = mkdtempSync(join(tmpdir(), '1brc-wasm-'));
  const file = join(directory, 'input.txt');
  const map = new Map();
  const short = [
    'A',
    'AB',
    'ABC',
    'ABCD',
    'ABCDE',
    'ABCDEF',
    'ABCDEFG',
    'ABCDEFGH',
    '\u0000',
    'é',
    '東京',
  ];
  let input = '';
  for (let i = 0; i < 30000; i++) {
    const key = i % 10000;
    const name = short[key] ?? `${'a'.repeat(95)}${String(key).padStart(5, '0')}`;
    const value = ((i * 97) % 1999) - 999;
    input += `${name};${(value / 10).toFixed(1)}${i % 2 ? '\r\n' : '\n'}`;
    const row = map.get(name);
    if (row) {
      row[1] = Math.min(row[1], value);
      row[2] += value;
      row[3] = Math.max(row[3], value);
      row[4]++;
    } else map.set(name, [name, value, value, value, 1]);
  }
  writeFileSync(file, input.slice(0, -2));
  const expectedRows = [...map.values()];
  const expected = format(expectedRows);
  try {
    for (const chunkSize of [128, 129, 4096, 1048576]) {
      for (const workers of [1, 3]) {
        const actual = await calculate(file, { engine: 'wasm', workers, chunkSize });
        assert.equal(format(actual), expected);
        assert.deepEqual(actual, expectedRows);
      }
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

function hashName(name) {
  const bytes = Buffer.from(name);
  let hash = 0n;
  for (let p = 0; p < bytes.length; p += 8) {
    let word = 0n;
    for (let i = 0; i < Math.min(8, bytes.length - p); i++)
      word |= BigInt(bytes[p + i]) << BigInt(i * 8);
    hash = ((hash ^ word) * 0x9e3779b185ebca87n) & 0xffffffffffffffffn;
  }
  return Number((hash ^ (hash >> 32n)) & 0xffffffffn);
}

test('full-key verification checks every middle byte without a test-only kernel', async () => {
  const kernel = await createKernel(128);
  const buffer = kernel.allocateBuffer(384);
  const parse = kernel.makeParser(buffer);
  const view = new DataView(kernel.memory);
  const base = kernel.api.stations_base();
  const buckets = kernel.api.buckets_base();
  for (const length of [17, 18, 23, 24, 25, 31, 32, 33, 47, 48, 49, 63, 64, 65, 99, 100]) {
    for (let position = 8; position < length - 8; position++) {
      kernel.api.reset();
      const original = `HEADSAME${'x'.repeat(length - 16)}TAILSAME`;
      const changed = `${original.slice(0, position)}Y${original.slice(position + 1)}`;
      parse(0, fill(buffer, `${original};0.1\n`));
      const oldHash = view.getUint32(base + 16, true);
      assert.equal(oldHash, hashName(original));
      const slot = (hash) => (hash ^ (hash >>> 16)) & 32767;
      assert.equal(view.getUint32(buckets + slot(oldHash) * 4, true), base);
      const hash = hashName(changed);
      // Fault-inject a matching cached hash and bucket, leaving name bytes and
      // cached head/tail unchanged. This exercises collisions in the ONE real
      // kernel, without shipping an alternative constant-hash implementation.
      view.setUint32(buckets + slot(oldHash) * 4, 0, true);
      view.setUint32(buckets + slot(hash) * 4, base, true);
      view.setUint32(base + 16, hash, true);
      parse(0, fill(buffer, `${changed};0.2\n`));
      const expected = [
        [original, 1, 1, 1, 1],
        [changed, 2, 2, 2, 1],
      ];
      const actual = kernel.rows();
      assert.equal(format(actual), format(expected));
      assert.deepEqual(actual, expected);
    }
  }
});
