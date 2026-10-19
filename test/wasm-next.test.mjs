import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { calculate } from '../calculate.mjs';
import { format } from '../lib/format.mjs';
import { createKernel } from '../wasm/engine.mjs';
import { variants } from '../wasm/variants.mjs';

function fixture(letter = 'a', varied = true) {
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
  const map = new Map();
  let text = '';
  for (let i = 0; i < 30000; i++) {
    const key = i % 10000;
    const suffix = String(key).padStart(5, '0');
    const name = varied
      ? (short[key] ?? (key % 3 ? `${'é'.repeat(47)}-${suffix}` : `${letter.repeat(95)}${suffix}`))
      : `${letter.repeat(95)}${suffix}`;
    const value = ((i * 97) % 1999) - 999;
    text += `${name};${(value / 10).toFixed(1)}${i % 2 ? '\r\n' : '\n'}`;
    const row = map.get(name);
    if (row) {
      row[1] = Math.min(row[1], value);
      row[2] += value;
      row[3] = Math.max(row[3], value);
      row[4]++;
    } else map.set(name, [name, value, value, value, 1]);
  }
  const rows = [...map.values()];
  const output = format(rows);
  return { text: text.slice(0, -2), rows, output };
}

function fill(buffer, text) {
  const length = buffer.write(text);
  buffer.fill(0, length, length + 32);
  buffer[length] = 10;
  return length;
}

test('next kernels: exact aggregates, compact ABI, streaming, growth and chunk ownership', async () => {
  const data = fixture();
  const directory = mkdtempSync(join(tmpdir(), '1brc-wasm-next-'));
  const file = join(directory, 'input.txt');
  writeFileSync(file, data.text);
  const settings = ['WASM_VARIANT', 'WASM_STREAMS'];
  const saved = Object.fromEntries(settings.map((name) => [name, process.env[name]]));
  try {
    for (const definition of variants.filter((v) => v.source === 'wasm/next.c' && !v.collision)) {
      for (const streams of definition.features.STREAMING_SCAN ? [1] : [1, 2, 3, 4]) {
        process.env.WASM_VARIANT = definition.variant;
        process.env.WASM_STREAMS = String(streams);
        const rows = await calculate(file, { engine: 'wasm', workers: 3, chunkSize: 16384 });
        assert.equal(format(rows), data.output, `${definition.variant}, ${streams} cursors`);
        assert.deepEqual(rows, data.rows);
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

test('adaptive dictionaries grow to 10K keys and reset/grow again without stale buckets', async () => {
  const a = fixture('a', false);
  const b = fixture('b', false);
  for (const variant of ['next-adaptive', 'next-local-cold', 'next-stream-local']) {
    const kernel = await createKernel(4 * 1024 * 1024, {
      variant,
      streams: variant.includes('stream') ? 1 : 4,
    });
    const buffer = kernel.allocateBuffer(4 * 1024 * 1024 + 256);
    const parse = kernel.makeParser(buffer);
    for (const data of [a, b]) {
      assert.equal(kernel.api.table_capacity(), 2048);
      assert.equal(kernel.api.table_resizes(), 0);
      parse(0, fill(buffer, data.text));
      const actual = kernel.rows();
      assert.equal(format(actual), data.output);
      assert.deepEqual(actual, data.rows);
      assert.equal(kernel.api.table_capacity(), 32768);
      assert.equal(kernel.api.table_resizes(), 4);
      kernel.api.reset();
      assert.deepEqual(kernel.rows(), []);
    }
  }
});

test('compact and streaming sums preserve the signed 64-bit challenge bound', async () => {
  for (const variant of ['next-local-cold', 'next-stream-local']) {
    for (const value of [-999, 999]) {
      const kernel = await createKernel(128, {
        variant,
        streams: variant.includes('stream') ? 1 : 4,
      });
      assert.equal(kernel.api.station_stride(), 40);
      const buffer = kernel.allocateBuffer(384);
      const length = fill(buffer, `A;${(value / 10).toFixed(1)}\n`);
      const parse = kernel.makeParser(buffer);
      parse(0, length);
      const view = new DataView(kernel.memory);
      const base = kernel.api.stations_base();
      view.setBigInt64(base, BigInt(value * 999999999), true);
      view.setUint32(base + 8, 999999999, true);
      parse(0, length);
      assert.deepEqual(kernel.rows(), [['A', value, value * 1e9, value, 1e9]]);
    }
  }
});

test('compact/growing/streaming tables resolve forced full-hash collisions and middle-byte differences', async () => {
  let text = '';
  const map = new Map();
  for (const length of [17, 18, 23, 24, 25, 31, 32, 33, 47, 48, 49, 63, 64, 65, 99, 100]) {
    for (const position of ['first', 'last']) {
      for (let i = 0; i < 26; i++) {
        const letter = String.fromCharCode(65 + i);
        const padding = 'x'.repeat(length - 17);
        const name = `HEADSAME${position === 'first' ? letter + padding : padding + letter}TAILSAME`;
        text += `${name};${(i / 10).toFixed(1)}\n`;
        const row = map.get(name);
        if (row) {
          row[2] += i;
          row[4]++;
        } else map.set(name, [name, i, i, i, 1]);
      }
    }
  }
  const expected = [...map.values()];
  const output = format(expected);
  for (const variant of ['next-collision', 'next-stream-collision']) {
    const kernel = await createKernel(1024 * 1024, {
      variant,
      streams: variant.includes('stream') ? 1 : 4,
    });
    const buffer = kernel.allocateBuffer(1024 * 1024 + 256);
    kernel.makeParser(buffer)(0, fill(buffer, text));
    const actual = kernel.rows();
    assert.equal(format(actual), output);
    assert.deepEqual(actual, expected);
    assert.equal(kernel.api.table_capacity(), 2048);
    assert.equal(kernel.api.table_resizes(), 3);
  }
});
