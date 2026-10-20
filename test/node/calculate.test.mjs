import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { format } from '../../lib/format.mjs';
import { calculate } from '../../plain/calculate.mjs';

function reference(text) {
  const rows = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const split = line.lastIndexOf(';');
    const name = line.slice(0, split);
    const value = Math.round(Number(line.slice(split + 1)) * 10);
    const row = rows.get(name);
    if (row) {
      row[1] = Math.min(row[1], value);
      row[2] += value;
      row[3] = Math.max(row[3], value);
      row[4]++;
    } else rows.set(name, [name, value, value, value, 1]);
  }
  return format([...rows.values()]);
}

const samples = new URL('../../upstream/src/test/resources/samples/', import.meta.url);
for (const name of readdirSync(samples).filter((name) => name.endsWith('.txt'))) {
  test(`upstream: ${name}`, async () => {
    const file = new URL(name, samples);
    const expected = readFileSync(new URL(name.replace('.txt', '.out'), samples), 'utf8');
    for (const workers of [1, 4]) {
      assert.equal(format(await calculate(file, { workers, chunkSize: 1024 })), expected);
    }
  });
}

async function check(text, chunkSizes = [128, 129, 251, 4096]) {
  const directory = mkdtempSync(join(tmpdir(), '1brc-test-'));
  try {
    const file = join(directory, 'input.txt');
    writeFileSync(file, text);
    const expected = reference(text);
    for (const chunkSize of chunkSizes) {
      for (const workers of [1, 4]) {
        assert.equal(
          format(await calculate(file, { workers, chunkSize })),
          expected,
          `workers=${workers}, chunkSize=${chunkSize}`,
        );
      }
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test('empty input, single row, missing final LF, CRLF, rounding ties', async () => {
  for (const text of [
    '',
    'X;0.0',
    'X;-99.9\n',
    'X;-0.0\r\nX;0.1\r\n',
    'A;-0.1\nA;0.0\nB;0.0\nB;0.1\nC;-1.1\nC;-1.2\n',
  ]) {
    await check(text);
  }
});

test('every temperature, UTF-8, 100-byte keys, shared prefixes, chunk boundaries', async () => {
  const names = [
    'A',
    'AB',
    'ABC',
    'ABCD',
    'ABCDE',
    'ABCDEF',
    'ABCDEFG',
    'ABCDEFGH',
    'a'.repeat(100),
    `${'a'.repeat(99)}b`,
    'é'.repeat(50),
    '🌡️東京',
    '\u0000',
    '\u{10000}',
    '\ue000',
    ' :;<=>'.replace(';', ''),
    '🏎️'.repeat(10),
  ];
  let text = '';
  for (let value = -999; value <= 999; value++) {
    text += `${names[(value + 999) % names.length]};${(value / 10).toFixed(1)}\n`;
  }
  await check(text);
  await check(text.slice(0, -1));
});

test('every name byte length, NUL and UTF-8 across prefix-cache lookups and chunk edges', async () => {
  const names = [];
  for (let length = 1; length <= 100; length++) {
    names.push(
      'a'.repeat(length),
      `${'a'.repeat(length - 1)}\0`,
      `${'\0'.repeat(length - 1)}:`,
      `${'é'.repeat(Math.floor(length / 2))}${length % 2 ? '\0' : ''}`,
    );
  }
  let text = '';
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < names.length; i++) {
      assert.ok(Buffer.byteLength(names[i]) >= 1 && Buffer.byteLength(names[i]) <= 100);
      const value = ((i * 97 + round * 13) % 1999) - 999;
      text += `${names[i]};${(value / 10).toFixed(1)}${i % 2 ? '\r\n' : '\n'}`;
    }
  }
  await check(text, [128, 129, 131, 251]);
  await check(text.slice(0, -2), [128, 129]);
});

test("each legal temperature also works as a station's only measurement", async () => {
  let text = '';
  for (let value = -999; value <= 999; value++) {
    text += `temperature-${value};${(value / 10).toFixed(1)}\n`;
  }
  await check(text);
});

test('full hash collisions with identical cached first, second and last words', async () => {
  // Engineer a collision in two middle words. Their effects cancel in the
  // rolling hash, but only a full byte comparison can distinguish the names.
  const multiplier = 0x9e3779b1;
  const original = Buffer.from('HEADSAMEaaaabbbbTAIL');
  const fixedHash = Math.imul(
    Math.imul(original.readInt32LE(0), multiplier) ^ original.readInt32LE(4),
    multiplier,
  );
  const firstHash = Math.imul(fixedHash ^ original.readInt32LE(8), multiplier);
  let state = 123;
  let collision;
  for (let attempt = 0; attempt < 100000; attempt++) {
    const candidate = Buffer.from(original);
    for (let byte = 8; byte < 12; byte++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      candidate[byte] = 65 + ((state >>> 0) % 58);
    }
    const secondHash = Math.imul(fixedHash ^ candidate.readInt32LE(8), multiplier);
    candidate.writeInt32LE(original.readInt32LE(12) ^ firstHash ^ secondHash, 12);
    if (candidate.subarray(12, 16).every((byte) => byte >= 65 && byte <= 122)) {
      collision = candidate.toString();
      break;
    }
  }
  assert.ok(collision, 'must find a printable ASCII collision');
  assert.notEqual(collision, original.toString());
  await check(`${original};-99.9\n${collision};99.9\n`.repeat(100));
});

test('randomized differential: 10,000 unique keys and hash collisions', async () => {
  let state = 42;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const names = Array.from(
    { length: 10000 },
    (_, i) => `${'common-prefix-'.repeat(i % 6)}${i}-${String.fromCodePoint(0x400 + (i % 1000))}`,
  );
  let text = names.map((name) => `${name};99.9\n`).join('');
  for (let i = 0; i < 100000; i++) {
    text += `${names[random() % names.length]};${(((random() % 1999) - 999) / 10).toFixed(1)}\n`;
  }
  await check(text, [32768, 1048576]);
});

test('sums remain exact beyond signed and unsigned 32-bit limits', async () => {
  const text = 'hot;99.9\ncold;-99.9\n'.repeat(4_400_000);
  await check(text, [8 * 1024 * 1024]);
});

test('formatter uses exact tenths, Java rounding, and UTF-16 lexical sorting', () => {
  assert.equal(
    format([
      ['C', -12, -23, -11, 2],
      ['B', 0, 1, 1, 2],
      ['A', -1, -1, 0, 2],
    ]),
    '{A=-0.1/0.0/0.0, B=0.0/0.1/0.1, C=-1.2/-1.1/-1.1}\n',
  );
  assert.equal(
    format([
      ['\ue000', 0, 0, 0, 1],
      ['\u{10000}', 0, 0, 0, 1],
    ]),
    '{\u{10000}=0.0/0.0/0.0, \ue000=0.0/0.0/0.0}\n',
  );
});
