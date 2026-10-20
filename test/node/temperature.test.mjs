import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { calculate } from '../../plain/calculate.mjs';

function reference(text) {
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.lastIndexOf(';');
    const name = line.slice(0, separator);
    const spelling = line.slice(separator + 1);
    const negative = spelling.startsWith('-');
    const magnitude = Number(spelling.replace(/[-.]/g, ''));
    // Public aggregates store min/max in Int32Array, canonicalizing signed zero.
    const value = (negative ? -magnitude : magnitude) || 0;
    let row = result.get(name);
    if (!row) {
      row = [name, value, 0, value, 0];
      result.set(name, row);
    }
    // Reference uses comparisons rather than rounded averages.
    if (value < row[1]) row[1] = value;
    row[2] += value;
    if (value > row[3]) row[3] = value;
    row[4]++;
  }
  return sorted([...result.values()]);
}

function sorted(rows) {
  return rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

async function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), '1brc-temperature-'));
  const names = ['TEMPERATURE', 'STREAMS', 'IO'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.IO = 'sync';
    await run(join(directory, 'input.txt'));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true });
  }
}

test('phased: every one/two-digit spelling, both signs and leading zeros, exact aggregates', async () => {
  await fixture(async (file) => {
    let text = '';
    let index = 0;
    for (const sign of ['', '-']) {
      for (const width of [1, 2]) {
        for (let integer = 0; integer < 10 ** width; integer++) {
          for (let fraction = 0; fraction < 10; fraction++) {
            const spelling = `${sign}${String(integer).padStart(width, '0')}.${fraction}`;
            const ending = index % 2 ? '\r\n' : '\n';
            // A unique station makes every min/max/value independently visible;
            // shared stations also exercise sum/count accumulation.
            text += `東京-${index};${spelling}${ending}`;
            text += `shared-${index % 19};${spelling}${ending}`;
            index++;
          }
        }
      }
    }
    assert.equal(index, 2200);
    text = text.replace(/\r?\n$/, '');
    writeFileSync(file, text);
    const expected = reference(text);
    for (const temperature of ['table', 'compact', 'arithmetic']) {
      process.env.TEMPERATURE = temperature;
      for (const streams of [1, 2, 3, 4]) {
        process.env.STREAMS = String(streams);
        for (const workers of [1, 3]) {
          const chunkSize = [128, 129, 251, 4096][streams - 1];
          assert.deepEqual(
            sorted(await calculate(file, { engine: 'phased', workers, chunkSize })),
            expected,
            `${temperature}, streams=${streams}, workers=${workers}, chunk=${chunkSize}`,
          );
        }
      }
    }
  });
});

test('phased: every byte of temperature and LF/CRLF across minimum-size chunks and EOF', async () => {
  await fixture(async (file) => {
    for (const temperature of ['table', 'compact', 'arithmetic']) {
      process.env.TEMPERATURE = temperature;
      process.env.STREAMS = '2';
      for (const spelling of ['0.0', '-0.0', '00.0', '-00.0', '9.9', '-9.9', '99.9', '-99.9']) {
        for (const ending of ['\n', '\r\n', '']) {
          for (let split = 0; split <= spelling.length + ending.length; split++) {
            // The temperature starts split bytes before byte 128. Padding uses
            // legal <=100-byte names and also places a multibyte name nearby.
            const target = '🌡️東京';
            const paddingBytes = 128 - split - Buffer.byteLength(`${target};`);
            const padding = `Padding;1.0\n${'a'.repeat(paddingBytes - 17)};2.0\n`;
            assert.equal(Buffer.byteLength(padding) + Buffer.byteLength(`${target};`), 128 - split);
            const text = `${padding}${target};${spelling}${ending}`;
            writeFileSync(file, text);
            assert.deepEqual(
              sorted(await calculate(file, { engine: 'phased', workers: 1, chunkSize: 128 })),
              reference(text),
              `${temperature}, ${JSON.stringify(spelling + ending)}, split=${split}`,
            );
          }
        }
      }
    }
  });
});

test('phased: exact min/max/sums/counts beyond signed and unsigned 32-bit', async () => {
  await fixture(async (file) => {
    process.env.TEMPERATURE = 'table';
    process.env.STREAMS = '2';
    const count = 4_400_000;
    writeFileSync(file, 'hot;99.9\ncold;-99.9\n'.repeat(count));
    const expected = [
      ['cold', -999, -999 * count, -999, count],
      ['hot', 999, 999 * count, 999, count],
    ];
    for (const workers of [1, 4]) {
      assert.deepEqual(
        sorted(await calculate(file, { engine: 'phased', workers, chunkSize: 1024 * 1024 })),
        expected,
      );
    }
  });
});

test('phased: 10,000 Unicode stations compared as exact tuples', async () => {
  await fixture(async (file) => {
    process.env.TEMPERATURE = 'table';
    process.env.STREAMS = '2';
    let text = '';
    for (let index = 0; index < 10000; index++) {
      text += `東京-${index};-00.1\r\n東京-${index};99.9\n東京-${index};-99.9\n`;
    }
    writeFileSync(file, text.slice(0, -1));
    assert.deepEqual(
      sorted(await calculate(file, { engine: 'phased', workers: 4, chunkSize: 251 })),
      reference(text),
    );
  });
});
