import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { format } from '../lib/format.mjs';

const rows = Number(process.argv[2] ?? 100_000_000);
const file = process.argv[3] ?? 'measurements.txt';
if (!Number.isSafeInteger(rows) || rows < 0 || rows > 1_000_000_000)
  throw new Error('Expected 0..1e9 rows');
if (existsSync(file)) throw new Error(`Refusing to overwrite ${file}`);
if (existsSync(`${file}.out`)) throw new Error(`Refusing to overwrite ${file}.out`);
// Use the upstream generator's names and station-specific Gaussian distribution.
// Seeded PRNG, but every row is generated separately: no repeated data blocks.
const source = readFileSync(
  new URL('../upstream/src/main/java/dev/morling/onebrc/CreateMeasurements.java', import.meta.url),
  'utf8',
);
const stations = [...source.matchAll(/new WeatherStation\("([^"]+)", (-?[\d.]+)\)/g)].map(
  ([, name, mean]) => ({
    name,
    bytes: Buffer.from(`${name};`),
    mean: +mean * 10,
    min: 999,
    max: -999,
    sum: 0,
    count: 0,
  }),
);
if (!stations.length) throw new Error('Upstream station list not found');
let state = 0x12345678;
function random() {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 0x100000000;
}
const temperatures = Array.from({ length: 1999 }, (_, i) =>
  Buffer.from(`${((i - 999) / 10).toFixed(1)}\n`),
);
const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
const fd = openSync(file, 'wx');
let pos = 0;
const start = performance.now();
let spare = 0;
try {
  for (let row = 0; row < rows; row++) {
    const station = stations[(random() * stations.length) | 0];
    let z;
    if (row & 1) z = spare;
    else {
      const radius = Math.sqrt(-2 * Math.log(1 - random()));
      const angle = random() * 2 * Math.PI;
      z = radius * Math.cos(angle);
      spare = radius * Math.sin(angle);
    }
    const value = Math.max(-999, Math.min(999, Math.round(station.mean + z * 100)));
    if (value < station.min) station.min = value;
    if (value > station.max) station.max = value;
    station.sum += value;
    station.count++;
    const temperature = temperatures[value + 999];
    if (pos + station.bytes.length + temperature.length > buffer.length) {
      let written = 0;
      while (written < pos) written += writeSync(fd, buffer, written, pos - written);
      pos = 0;
    }
    pos += station.bytes.copy(buffer, pos);
    pos += temperature.copy(buffer, pos);
    if ((row + 1) % 100_000_000 === 0)
      console.error(
        `${((row + 1) / 1e6).toFixed(0)}M rows, ${((performance.now() - start) / 1000).toFixed(1)}s`,
      );
  }
  let written = 0;
  while (written < pos) written += writeSync(fd, buffer, written, pos - written);
} finally {
  closeSync(fd);
}
const expected = stations.filter((s) => s.count).map((s) => [s.name, s.min, s.sum, s.max, s.count]);
const output = openSync(`${file}.out`, 'wx');
try {
  writeSync(output, format(expected));
} finally {
  closeSync(output);
}
console.error(
  `Generated ${rows.toLocaleString()} independent rows in ${((performance.now() - start) / 1000).toFixed(2)}s; expected result: ${file}.out`,
);
