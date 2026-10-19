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

test('Wasm binaries have no imports and SIMD is present only in the SIMD build', async () => {
  const wabt = await wabtFactory();
  const manifest = JSON.parse(readFileSync(new URL('../wasm/build.json', import.meta.url), 'utf8'));
  assert.equal(
    manifest.sourceSha256,
    createHash('sha256')
      .update(readFileSync(new URL('../wasm/kernel.c', import.meta.url)))
      .digest('hex'),
    'rebuild after changing C source',
  );
  for (const [source, digest] of Object.entries(manifest.sources ?? {})) {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL(`../${source}`, import.meta.url)))
        .digest('hex'),
      digest,
      `rebuild after changing ${source}`,
    );
  }
  for (const { variant } of manifest.modules) {
    const bytes = readFileSync(new URL(`../wasm/kernel-${variant}.wasm`, import.meta.url));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      manifest.modules.find((module) => module.variant === variant).sha256,
    );
    assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)), []);
    // wabt's Buffer handling differs on Node 26; normalize only the inspector's
    // binary bytes. Runtime measurement buffers still alias Wasm memory directly.
    const module = wabt.readWasm(Uint8Array.from(bytes), { readDebugNames: true });
    try {
      const wat = module.toText({ foldExprs: false });
      if (variant.startsWith('scalar')) assert.doesNotMatch(wat, /\bv128\.|\bi8x16\./);
      else {
        assert.match(wat, /i8x16\.eq/);
        assert.match(wat, /i8x16\.bitmask/);
      }
    } finally {
      module.destroy();
    }
  }
});

test('input buffers alias Wasm memory, growth precedes all views, and reset clears state', async () => {
  const size = 1024 * 1024;
  const kernel = await createKernel(size, { variant: 'simd', slots: 2, streams: 2 });
  const a = kernel.allocateBuffer(size + 256);
  const b = kernel.allocateBuffer(size + 256);
  assert.equal(a.buffer, kernel.memory);
  assert.equal(b.buffer, kernel.memory);
  assert.equal(b.byteOffset - a.byteOffset, size + 256);
  assert.equal(kernel.api.simd_enabled(), 1);
  const parse = kernel.makeParser(a);
  const input = '東京;-99.9\r\nA;99.9\nA;0.1';
  const length = a.write(input);
  a.fill(0, length, length + 32);
  a[length] = 10;
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

test('signed 64-bit sums handle the complete challenge bound', async () => {
  for (const value of [-999, 999]) {
    const kernel = await createKernel(128, { variant: 'simd', streams: 1 });
    const buffer = kernel.allocateBuffer(384);
    const text = `A;${(value / 10).toFixed(1)}\n`;
    const length = buffer.write(text);
    buffer.fill(0, length, length + 32);
    const parse = kernel.makeParser(buffer);
    parse(0, length);
    const view = new DataView(kernel.memory);
    const base = kernel.api.stations_base();
    // Unit-test state construction, not a benchmark: simulate a valid prefix
    // of 999,999,999 identical records, then process the final actual row.
    view.setBigInt64(base, BigInt(value * 999999999), true);
    view.setUint32(base + 8, 999999999, true);
    parse(0, length);
    assert.deepEqual(kernel.rows(), [['A', value, value * 1e9, value, 1e9]]);
  }
});

test('SIMD/scalar, 1–4 cursors, sync/async/macro reads and memory growth agree exactly', async () => {
  const directory = mkdtempSync(join(tmpdir(), '1brc-wasm-'));
  const file = join(directory, 'input.txt');
  const rows = new Map();
  let input = '';
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
  for (let i = 0; i < 30000; i++) {
    const key = i % 10000;
    const name = short[key] ?? `${'a'.repeat(95)}${String(key).padStart(5, '0')}`;
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
  const names = ['WASM_VARIANT', 'WASM_STREAMS', 'IO', 'MACRO_BYTES'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const variant of [
      'simd',
      'scalar',
      'simd-pointers',
      'scalar-pointers',
      'simd-small',
      'simd-pointers-small',
    ]) {
      for (const streams of [1, 2, 3, 4]) {
        for (const io of ['sync', 'async', 'macro']) {
          process.env.WASM_VARIANT = variant;
          process.env.WASM_STREAMS = String(streams);
          process.env.IO = io;
          process.env.MACRO_BYTES = '4194304';
          const actual = await calculate(file, {
            engine: 'wasm',
            workers: 3,
            chunkSize: 1024 * 1024,
          });
          assert.equal(format(actual), expected, `${variant}, ${streams}, ${io}`);
          assert.deepEqual(actual, expectedRows);
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

test('forced full-hash collisions verify every middle byte at SIMD boundaries', async () => {
  for (const variant of ['collision', 'collision-pointers']) {
    for (const streams of [1, 2, 3, 4]) {
      const kernel = await createKernel(1024 * 1024, { variant, streams });
      const buffer = kernel.allocateBuffer(1024 * 1024 + 256);
      let input = '';
      const expected = [];
      for (const length of [17, 18, 23, 24, 25, 31, 32, 33, 47, 48, 49, 63, 64, 65, 99, 100]) {
        for (const position of ['first', 'last']) {
          for (let i = 0; i < 26; i++) {
            const letter = String.fromCharCode(65 + i);
            const padding = 'x'.repeat(length - 17);
            const middle = position === 'first' ? letter + padding : padding + letter;
            const name = `HEADSAME${middle}TAILSAME`;
            input += `${name};${(i / 10).toFixed(1)}\n`;
            // For length 17, first and last designate the same byte/name.
            const row = expected.find((row) => row[0] === name);
            if (row) {
              row[2] += i;
              row[4]++;
            } else expected.push([name, i, i, i, 1]);
          }
        }
      }
      const length = buffer.write(input);
      buffer.fill(0, length, length + 32);
      kernel.makeParser(buffer)(0, length);
      const actual = kernel.rows();
      assert.equal(format(actual), format(expected));
      assert.deepEqual(actual, expected);
    }
  }
});
