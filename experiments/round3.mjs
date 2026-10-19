import { BYTE_MASKS, chooseTemperatureParser, MAX_STATIONS } from '../lib/parse-utils.mjs';
import { consume } from '../lib/read.mjs';

function multiplyHash(hash, word) {
  return Math.imul(hash ^ word, 0x9e3779b1);
}

function rotateHash(hash, word) {
  return ((hash << 5) | (hash >>> 27)) ^ word;
}

function shiftHash(hash, word) {
  return ((hash << 5) - hash) ^ word;
}

// Final pure-JS experiments, with the current winning engine left untouched.
// All choices are configuration-only; no station names/results are precomputed.
export async function aggregate(config) {
  const tableSize = 2 ** Number(process.env.TABLE_BITS ?? 15);
  if (![16384, 32768, 65536].includes(tableSize)) throw new Error('TABLE_BITS must be 14..16');
  const fused = (process.env.RECORD_LAYOUT ?? 'split') === 'fused';
  const recordBytes = Number(process.env.RECORD_BYTES ?? 48);
  if (![48, 64].includes(recordBytes)) throw new Error('RECORD_BYTES must be 48 or 64');
  const recordWords = fused ? recordBytes / 4 : 8;
  const storage = new ArrayBuffer(MAX_STATIONS * recordWords * 4);
  const records = new Int32Array(storage);
  const sums = fused ? new Float64Array(storage) : new Float64Array(MAX_STATIONS);
  const counts = fused ? new Uint32Array(storage) : new Uint32Array(MAX_STATIONS);
  const sumStride = fused ? recordBytes / 8 : 1;
  const sumOffset = fused ? 4 : 0;
  const countStride = fused ? recordWords : 1;
  const countOffset = fused ? 10 : 0;
  // Fused record: 32 bytes metadata, Float64 sum at +32, Uint32 count at +40.
  // Compare a smaller footprint with cache-line-sized record spacing.
  const table = new Uint16Array(tableSize);
  const arena = Buffer.allocUnsafe(MAX_STATIONS * 104 + 16);
  const keys = new DataView(arena.buffer, arena.byteOffset, arena.byteLength);
  const temperatureBase = chooseTemperatureParser();
  const hashMode = process.env.HASH_MODE ?? 'fnv';
  if (!['fnv', 'rotate', 'shift', 'dual', 'constant'].includes(hashMode))
    throw new Error('Unknown HASH_MODE');
  const mix = hashMode === 'rotate' ? rotateHash : hashMode === 'shift' ? shiftHash : multiplyHash;
  const dual = hashMode === 'dual';
  const unroll = (process.env.SCAN_BYTES ?? '4') === '8';
  let used = 0;
  let keyOffset = 0;

  function insert(buffer, view, start, end, hash, head, slot) {
    if (used === MAX_STATIONS) throw new Error('Too many stations');
    const id = used++;
    const r = id * recordWords;
    const length = end - start;
    table[slot] = id + 1;
    buffer.copy(arena, keyOffset, start, end);
    records[r] = hash;
    records[r + 1] = head;
    records[r + 2] = length > 4 ? view.getInt32(end - 4, true) : 0;
    records[r + 3] = length > 4 ? view.getInt32(start + Math.min(4, length - 4), true) : 0;
    records[r + 4] = length;
    records[r + 5] = keyOffset;
    records[r + 6] = 999;
    records[r + 7] = -999;
    keyOffset = (keyOffset + length + 3) & ~3;
    return id;
  }

  function equal(view, start, end, r, head) {
    const length = end - start;
    if (records[r + 4] !== length || records[r + 1] !== head) return false;
    if (length <= 4) return true;
    if (view.getInt32(end - 4, true) !== records[r + 2]) return false;
    if (view.getInt32(start + Math.min(4, length - 4), true) !== records[r + 3]) return false;
    const offset = records[r + 5];
    for (let i = 8; i < length - 4; i += 4) {
      if (view.getInt32(start + i, true) !== keys.getInt32(offset + i, true)) return false;
    }
    return true;
  }

  function updateValue(id, value) {
    const r = id * recordWords;
    if (value < records[r + 6]) records[r + 6] = value;
    if (value > records[r + 7]) records[r + 7] = value;
    sums[id * sumStride + sumOffset] += value;
    counts[id * countStride + countOffset]++;
  }

  function makeParser(buffer) {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const batchSize = Number(process.env.BATCH_SIZE ?? 32);
    if (![16, 32, 64, 128, 256].includes(batchSize)) throw new Error('Invalid BATCH_SIZE');
    const starts = new Uint32Array(batchSize);
    const ends = new Uint32Array(batchSize);
    const hashes = new Int32Array(batchSize);
    const heads = new Int32Array(batchSize);
    const values = new Int16Array(batchSize);
    const temperatures = new Int32Array(4);

    function find(start, end, hash, head) {
      let slot = (hash ^ (hash >>> 16)) & (tableSize - 1);
      for (;;) {
        const id = table[slot] - 1;
        if (id < 0) return insert(buffer, view, start, end, hash, head, slot);
        if (records[id * recordWords] === hash && equal(view, start, end, id * recordWords, head))
          return id;
        slot = (slot + 1) & (tableSize - 1);
      }
    }

    // Both pipelines use the same scanner. Phased mode resolves the station
    // immediately; tiled mode writes a small reusable token batch instead.
    function scan(p, lane, tiled) {
      const start = p;
      let head = view.getInt32(p, true);
      let word = head;
      let hash = 0;
      let other = 0;
      for (;;) {
        const x = word ^ 0x3b3b3b3b;
        const matches = (x - 0x01010101) & ~x & 0x80808080;
        if (matches) {
          const bytes = (31 - Math.clz32(matches & -matches)) >>> 3;
          hash = mix(hash, word & BYTE_MASKS[bytes]);
          p += bytes;
          break;
        }
        const next = mix(hash, word);
        hash = dual ? other : next;
        other = next;
        p += 4;
        word = view.getInt32(p, true);
        if (unroll) {
          const y = word ^ 0x3b3b3b3b;
          const secondMatches = (y - 0x01010101) & ~y & 0x80808080;
          if (secondMatches) {
            const bytes = (31 - Math.clz32(secondMatches & -secondMatches)) >>> 3;
            hash = mix(hash, word & BYTE_MASKS[bytes]);
            p += bytes;
            break;
          }
          const following = mix(hash, word);
          hash = dual ? other : following;
          other = following;
          p += 4;
          word = view.getInt32(p, true);
        }
      }
      if (dual) hash ^= Math.imul(other, 0x85ebca6b);
      if (hashMode === 'constant') hash = 0; // Correctness stress test, never a fast path.
      if (p - start < 4) head &= BYTE_MASKS[p - start];
      if (tiled) {
        starts[lane] = start;
        ends[lane] = p;
        hashes[lane] = hash;
        heads[lane] = head;
        return p + 1;
      }
      temperatures[lane] = p + 1;
      return find(start, p, hash, head);
    }

    function readTemperature(p, id, tiled) {
      const word = view.getUint32(p, true);
      const negative = (~word & 0x10) >>> 4;
      const digits = word >>> (negative * 8);
      const width = 4 + negative + ((digits >>> 12) & 1);
      let value = temperatureBase(digits) + (buffer[p + width - 2] & 15);
      if (negative) value = -value;
      p += width;
      if (buffer[p - 1] === 13) p++;
      if (tiled) values[id] = value;
      else updateValue(id, value);
      return p;
    }

    if ((process.env.PIPELINE ?? 'phased') === 'tiled') {
      const reduceWidth = Number(process.env.REDUCE_WIDTH ?? 4);
      if (![1, 4].includes(reduceWidth)) throw new Error('REDUCE_WIDTH must be 1 or 4');
      return (start, end) => {
        let p = start;
        while (p < end) {
          let rows = 0;
          while (rows < batchSize && p < end) {
            p = scan(p, rows, true);
            p = readTemperature(p, rows, true);
            rows++;
          }
          let row = 0;
          if (reduceWidth === 4) {
            for (; row + 3 < rows; row += 4) {
              const a = find(starts[row], ends[row], hashes[row], heads[row]);
              const b = find(starts[row + 1], ends[row + 1], hashes[row + 1], heads[row + 1]);
              const c = find(starts[row + 2], ends[row + 2], hashes[row + 2], heads[row + 2]);
              const d = find(starts[row + 3], ends[row + 3], hashes[row + 3], heads[row + 3]);
              updateValue(a, values[row]);
              updateValue(b, values[row + 1]);
              updateValue(c, values[row + 2]);
              updateValue(d, values[row + 3]);
            }
          }
          for (; row < rows; row++) {
            updateValue(find(starts[row], ends[row], hashes[row], heads[row]), values[row]);
          }
        }
      };
    }

    return (start, end) => {
      const middle = Math.min(end, buffer.indexOf(10, start + ((end - start) >>> 1)) + 1);
      let a = start;
      let b = middle;
      while (a < middle && b < end) {
        const idA = scan(a, 0, false);
        const idB = scan(b, 1, false);
        a = readTemperature(temperatures[0], idA, false);
        b = readTemperature(temperatures[1], idB, false);
      }
      while (a < middle) {
        const id = scan(a, 0, false);
        a = readTemperature(temperatures[0], id, false);
      }
      while (b < end) {
        const id = scan(b, 0, false);
        b = readTemperature(temperatures[0], id, false);
      }
    };
  }

  await consume(config, makeParser);
  return Array.from({ length: used }, (_, id) => {
    const r = id * recordWords;
    const offset = records[r + 5];
    return [
      arena.toString('utf8', offset, offset + records[r + 4]),
      records[r + 6],
      sums[id * sumStride + sumOffset],
      records[r + 7],
      counts[id * countStride + countOffset],
    ];
  });
}
