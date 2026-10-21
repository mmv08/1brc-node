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
  const shipped = new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(shipped), []);
  // Derived branch hints keep cold paths and their spills out of the hot loop.
  const [hints] = WebAssembly.Module.customSections(shipped, 'metadata.code.branch_hint');
  assert.ok(hints.byteLength > 0);
  const parser = manifest.branchHints.find((entry) => entry.function === 'parse_chunk');
  assert.ok(parser.likely > 0 && parser.unlikely > 0);
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
        const actual = await calculate(file, { workers, chunkSize });
        assert.equal(format(actual), expected);
        assert.deepEqual(actual, expectedRows);
      }
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('10K short UTF-8/NUL keys preserve all aggregates across lanes and chunks', async () => {
  const directory = mkdtempSync(join(tmpdir(), '1brc-short-keys-'));
  const file = join(directory, 'input.txt');
  const names = Array.from(
    { length: 10000 },
    (_, i) => `é${i.toString(36).padStart(4, '0')}${'x'.repeat(i % 10)}\u0000`,
  );
  const expected = new Map();
  let input = '';
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const value = ((i * 97 + round * 11) % 1999) - 999;
      input += `${name};${(value / 10).toFixed(1)}${round % 2 ? '\r\n' : '\n'}`;
      const row = expected.get(name);
      if (row) {
        row[1] = Math.min(row[1], value);
        row[2] += value;
        row[3] = Math.max(row[3], value);
        row[4]++;
      } else expected.set(name, [name, value, value, value, 1]);
    }
  }
  writeFileSync(file, input.slice(0, -1));
  try {
    const rows = [...expected.values()];
    const output = format(rows);
    for (const chunkSize of [128, 4096]) {
      for (const workers of [1, 3]) {
        const actual = await calculate(file, { workers, chunkSize });
        assert.equal(format(actual), output);
        assert.deepEqual(actual, rows);
      }
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('shared-prefix replacements and repeated short keys publish exact chunk totals', async () => {
  const kernel = await createKernel(65536);
  const buffer = kernel.allocateBuffer(65536 + 256);
  const parse = kernel.makeParser(buffer);
  const names = [
    'same-A',
    'same-B',
    'same-A\u0000',
    `same-${'x'.repeat(95)}`,
    'A',
    'A\u0000',
    '\u0000',
    '\u0000'.repeat(100),
  ];
  const expected = new Map();
  for (let phase = 0; phase < 4; phase++) {
    if (phase === 2) {
      kernel.api.reset();
      expected.clear();
    }
    let text = '';
    for (let i = 0; i < 600; i++) {
      const name = names[(i * 5 + phase) % names.length];
      const value = ((i * 97 + phase * 733) % 1999) - 999;
      text += `${name};${(value / 10).toFixed(1)}${i % 3 ? '\n' : '\r\n'}`;
      const row = expected.get(name);
      if (row) {
        row[0] = Math.min(row[0], value);
        row[1] += value;
        row[2] = Math.max(row[2], value);
        row[3]++;
      } else expected.set(name, [value, value, value, 1]);
    }
    parse(0, fill(buffer, text.replace(/\r?\n$/, '')));
    assert.deepEqual(new Map(kernel.rows().map(([name, ...stats]) => [name, stats])), expected);
  }
});

test('all temperature spellings preserve values and row boundaries', async () => {
  const directory = mkdtempSync(join(tmpdir(), '1brc-temperature-formats-'));
  const file = join(directory, 'input.txt');
  const expected = new Map();
  let input = '';
  for (const negative of [false, true]) {
    for (const width of [1, 2]) {
      for (let whole = 0; whole < 10 ** width; whole++) {
        for (let fraction = 0; fraction < 10; fraction++) {
          const name = `T${expected.size.toString(36)}`;
          const magnitude = whole * 10 + fraction;
          const value = negative && magnitude ? -magnitude : magnitude;
          const text = `${negative ? '-' : ''}${String(whole).padStart(width, '0')}.${fraction}`;
          expected.set(name, [value, value * 6, value, 6]);
          for (const eol of ['\n', '\r\n']) {
            input += `${name};${text}${eol}`.repeat(3);
          }
        }
      }
    }
  }
  // Repeated short keys drive every parsing lane; omit the final CRLF too.
  writeFileSync(file, input.slice(0, -2));
  try {
    for (const chunkSize of [128, 4096]) {
      for (const workers of [1, 3]) {
        const rows = await calculate(file, { workers, chunkSize });
        assert.deepEqual(new Map(rows.map(([name, ...stats]) => [name, stats])), expected);
      }
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('every name length and repeated keys preserve aggregates across parser transitions', async () => {
  const directory = mkdtempSync(join(tmpdir(), '1brc-name-lengths-'));
  const file = join(directory, 'input.txt');
  const names = Array.from({ length: 100 }, (_, i) => 'x'.repeat(i + 1));
  const repeated = ['A', '東京', 'y'.repeat(15), 'z'.repeat(16), 'é'.repeat(50)];
  const expected = new Map();
  let input = '';
  for (let i = 0; i < 6000; i++) {
    const name = i % 7 < 4 ? repeated[Math.floor(i / 37) % repeated.length] : names[i % 100];
    const value = ((i * 137) % 1999) - 999;
    input += `${name};${(value / 10).toFixed(1)}${i % 3 ? '\n' : '\r\n'}`;
    const row = expected.get(name);
    if (row) {
      row[1] = Math.min(row[1], value);
      row[2] += value;
      row[3] = Math.max(row[3], value);
      row[4]++;
    } else expected.set(name, [name, value, value, value, 1]);
  }
  writeFileSync(file, input.slice(0, -1));
  try {
    const rows = [...expected.values()];
    const output = format(rows);
    for (const chunkSize of [128, 4096, 1048576]) {
      for (const workers of [1, 3]) {
        const actual = await calculate(file, { workers, chunkSize });
        assert.equal(format(actual), output);
        assert.deepEqual(actual, rows);
      }
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

const initialMixers = [0x9e3779b185ebca87n, 0xc2b2ae3d27d4eb4fn];

function hashName(name, [mixLow, mixHigh] = initialMixers) {
  const bytes = Buffer.from(`${name};`);
  let hash = 0n;
  for (let p = 0; p < bytes.length; p += 16) {
    let low = 0n;
    let high = 0n;
    for (let i = 0; i < Math.min(8, bytes.length - p); i++)
      low |= BigInt(bytes[p + i]) << BigInt(i * 8);
    for (let i = 0; i < Math.min(8, bytes.length - p - 8); i++)
      high |= BigInt(bytes[p + 8 + i]) << BigInt(i * 8);
    hash = ((hash ^ low ^ mixLow) * (high ^ mixHigh)) & 0xffffffffffffffffn;
  }
  return {
    fingerprint: Number((hash ^ (hash >> 32n)) & 0xffffffffn),
    slot: Number(hash >> 49n),
  };
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
      const originalHash = hashName(original);
      assert.equal(oldHash, originalHash.fingerprint);
      assert.equal(view.getUint32(buckets + originalHash.slot * 4, true), base);
      const hash = hashName(changed);
      // Fault-inject a matching cached hash and bucket, leaving name bytes and
      // cached head/tail unchanged. This exercises collisions in the ONE real
      // kernel, without shipping an alternative constant-hash implementation.
      view.setUint32(buckets + originalHash.slot * 4, kernel.api.empty_station_base(), true);
      view.setUint32(buckets + hash.slot * 4, base, true);
      view.setUint32(base + 16, hash.fingerprint, true);
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

test('short-name collisions preserve length and every byte across independent lanes', async () => {
  const kernel = await createKernel(1024);
  const buffer = kernel.allocateBuffer(1280);
  const parse = kernel.makeParser(buffer);
  const view = new DataView(kernel.memory);
  const base = kernel.api.stations_base();
  const buckets = kernel.api.buckets_base();
  for (const [original, changed] of [
    ['A', 'A\u0000'],
    ['A\u0000', 'A\u0000\u0000'],
    ['AB', 'AB\u0000'],
    ['x'.repeat(14), `${'x'.repeat(14)}\u0000`],
    ['x'.repeat(15), 'x'.repeat(16)],
    ['HEADSAMExTAILSAME', 'HEADSAME'],
    ['\u0000'.repeat(100), '\u0000'],
  ]) {
    kernel.api.reset();
    parse(0, fill(buffer, `${original};0.1\n`));
    const before = hashName(original);
    const after = hashName(changed);
    assert.equal(view.getUint32(buckets + before.slot * 4, true), base);
    view.setUint32(buckets + before.slot * 4, kernel.api.empty_station_base(), true);
    view.setUint32(buckets + after.slot * 4, base, true);
    view.setUint32(base + 16, after.fingerprint, true);
    // Twelve equal rows exercise the short-name path with two, three or four lanes.
    parse(0, fill(buffer, `${changed};0.2\n`.repeat(12)));
    assert.deepEqual(kernel.rows(), [
      [original, 1, 1, 1, 1],
      [changed, 2, 24, 2, 12],
    ]);
  }
});

test('first-bucket collisions retune the mixers so every station hits directly', async () => {
  const kernel = await createKernel(65536);
  const buffer = kernel.allocateBuffer(65536 + 256);
  const parse = kernel.makeParser(buffer);
  const view = new DataView(kernel.memory);
  const base = kernel.api.stations_base();
  const buckets = kernel.api.buckets_base();
  // Two short names that share a first bucket under the initial mixers.
  const seen = new Map();
  let pair;
  for (let i = 0; !pair; i++) {
    const name = `n${i}`;
    const { slot } = hashName(name);
    if (seen.has(slot)) pair = [seen.get(slot), name];
    else seen.set(slot, name);
  }
  const names = [...pair, 'A', '東京', 'x'.repeat(20), 'y'.repeat(40)];
  const expected = new Map();
  let text = '';
  for (let i = 0; i < 1200; i++) {
    const name = names[(i * 7) % names.length];
    const value = ((i * 389) % 1999) - 999;
    text += `${name};${(value / 10).toFixed(1)}${i % 4 ? '\n' : '\r\n'}`;
    const row = expected.get(name);
    if (row) {
      row[0] = Math.min(row[0], value);
      row[1] += value;
      row[2] = Math.max(row[2], value);
      row[3]++;
    } else expected.set(name, [value, value, value, 1]);
  }
  parse(0, fill(buffer, text));
  const rows = kernel.rows();
  assert.deepEqual(new Map(rows.map(([name, ...stats]) => [name, stats])), expected);
  const mixers = kernel.api.mixers_base();
  const mix = [view.getBigUint64(mixers, true), view.getBigUint64(mixers + 8, true)];
  assert.notDeepEqual(mix, initialMixers);
  rows.forEach(([name], id) => {
    const { slot, fingerprint } = hashName(name, mix);
    assert.equal(view.getUint32(buckets + slot * 4, true), base + id * 40, name);
    assert.equal(view.getUint32(base + id * 40 + 16, true), fingerprint, name);
  });
});

test('colliding short keys preserve exact totals across simultaneous lane inserts and hits', async () => {
  const kernel = await createKernel(65536);
  const buffer = kernel.allocateBuffer(65536 + 256);
  const parse = kernel.makeParser(buffer);
  const seen = new Map();
  let pair;
  for (let i = 0; !pair; i++) {
    const name = `n${i.toString(36).padStart(4, '0')}`;
    const { slot } = hashName(name);
    if (seen.has(slot)) pair = [seen.get(slot), name];
    else seen.set(slot, name);
  }
  parse(0, fill(buffer, `${pair[0]};0.0\n`));
  // Equal byte lengths put each block in its own parsing lane. The first lane
  // inserts a colliding key and retunes; the others reuse the old and new IDs.
  const repeats = 64;
  const input =
    `${pair[1]};11.1\n`.repeat(repeats) +
    `${pair[0]};-2.2\n`.repeat(repeats) +
    `${pair[1]};33.3\n`.repeat(repeats);
  parse(0, fill(buffer, input));
  assert.deepEqual(
    new Map(kernel.rows().map(([name, ...stats]) => [name, stats])),
    new Map([
      [pair[0], [-22, -22 * repeats, 0, repeats + 1]],
      [pair[1], [111, (111 + 333) * repeats, 333, repeats * 2]],
    ]),
  );
  const view = new DataView(kernel.memory);
  const mixers = kernel.api.mixers_base();
  assert.notDeepEqual(
    [view.getBigUint64(mixers, true), view.getBigUint64(mixers + 8, true)],
    initialMixers,
  );
});

test('negated maximum lane decodes signed extrema and positive zero', async () => {
  const kernel = await createKernel(65536);
  const buffer = kernel.allocateBuffer(65536 + 256);
  const cases = [
    ['NegativeOnly', [-999, -500, -1]],
    ['PositiveOnly', [999, 500, 1]],
    ['CrossesZero', [-999, 0, 999]],
    ['PositiveZero', [0, 0, 0]],
    ['LongName'.repeat(10), [999, -999, 0]],
  ];
  const text = Array.from({ length: 100 }, (_, round) =>
    cases.map(([name, values]) => `${name};${(values[round % 3] / 10).toFixed(1)}\n`).join(''),
  ).join('');
  kernel.makeParser(buffer)(0, fill(buffer, text));
  const view = new DataView(kernel.memory);
  const base = kernel.api.stations_base();
  const rows = kernel.rows();
  for (let id = 0; id < rows.length; id++) {
    const row = rows[id];
    const [, values] = cases.find(([name]) => name === row[0]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    assert.equal(view.getInt16(base + id * 40 + 12, true), min);
    assert.equal(view.getInt16(base + id * 40 + 14, true), 0 - max);
    assert.equal(row[1], min);
    assert.equal(row[3], max);
    assert.equal(Object.is(row[3], -0), false);
  }
});
