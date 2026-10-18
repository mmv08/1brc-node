import {
  BYTE_MASKS,
  chooseTemperatureParser,
  interleave,
  MAX_STATIONS,
} from '../lib/parse-utils.mjs';
import { consume } from '../lib/read.mjs';

// Structure-of-arrays alternative to flat.mjs's interleaved metadata records.
// A smaller initial table is legal for arbitrary inputs: it grows and rehashes
// as stations are discovered, without changing their dense IDs.
export async function aggregate(config) {
  const bits = Number(process.env.TABLE_BITS ?? 13);
  if (!Number.isInteger(bits) || bits < 10 || bits > 16)
    throw new Error('TABLE_BITS must be 10..16');
  let table = new Uint16Array(2 ** bits);
  let mask = table.length - 1;
  const hashes = new Int32Array(MAX_STATIONS);
  const heads = new Int32Array(MAX_STATIONS);
  const tails = new Int32Array(MAX_STATIONS);
  const middles = new Int32Array(MAX_STATIONS);
  const lengths = new Uint8Array(MAX_STATIONS);
  const offsets = new Int32Array(MAX_STATIONS);
  const minimums = new Int16Array(MAX_STATIONS);
  const maximums = new Int16Array(MAX_STATIONS);
  const sums = new Float64Array(MAX_STATIONS);
  const counts = new Uint32Array(MAX_STATIONS);
  const packed = new Float64Array(MAX_STATIONS * 4);
  const arena = Buffer.allocUnsafe(MAX_STATIONS * 104 + 16);
  const keys = new DataView(arena.buffer, arena.byteOffset, arena.byteLength);
  const temperatureBase = chooseTemperatureParser();
  const packedStats = process.env.STATS === 'packed';
  let used = 0;
  let keyOffset = 0;

  function grow() {
    table = new Uint16Array(table.length * 2);
    mask = table.length - 1;
    for (let id = 0; id < used; id++) {
      const hash = hashes[id];
      let slot = (hash ^ (hash >>> 16)) & mask;
      while (table[slot]) slot = (slot + 1) & mask;
      table[slot] = id + 1;
    }
  }

  const update = packedStats
    ? (id, value) => {
        const p = id * 4;
        if (value < packed[p]) packed[p] = value;
        if (value > packed[p + 1]) packed[p + 1] = value;
        packed[p + 2] += value;
        packed[p + 3]++;
      }
    : (id, value) => {
        if (value < minimums[id]) minimums[id] = value;
        if (value > maximums[id]) maximums[id] = value;
        sums[id] += value;
        counts[id]++;
      };

  function makeParser(buffer) {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    function processRow(p) {
      const start = p;
      let head = view.getInt32(p, true);
      let word = head;
      let hash = 0;
      for (;;) {
        const x = word ^ 0x3b3b3b3b;
        const matches = (x - 0x01010101) & ~x & 0x80808080;
        if (matches) {
          const bytes = (31 - Math.clz32(matches & -matches)) >>> 3;
          hash = Math.imul(hash ^ (word & BYTE_MASKS[bytes]), 0x9e3779b1);
          p += bytes;
          break;
        }
        hash = Math.imul(hash ^ word, 0x9e3779b1);
        p += 4;
        word = view.getInt32(p, true);
      }
      const length = p - start;
      if (length < 4) head &= BYTE_MASKS[length];
      let slot = (hash ^ (hash >>> 16)) & mask;
      let id;
      for (;;) {
        id = table[slot] - 1;
        if (id < 0) {
          if (used === MAX_STATIONS) throw new Error('Too many stations');
          if (used >= table.length * 0.7) {
            grow();
            slot = (hash ^ (hash >>> 16)) & mask;
            continue;
          }
          id = used++;
          table[slot] = id + 1;
          buffer.copy(arena, keyOffset, start, p);
          hashes[id] = hash;
          heads[id] = head;
          tails[id] = length > 4 ? view.getInt32(p - 4, true) : 0;
          middles[id] = length > 8 ? view.getInt32(start + 4, true) : 0;
          lengths[id] = length;
          offsets[id] = keyOffset;
          minimums[id] = packed[id * 4] = 999;
          maximums[id] = packed[id * 4 + 1] = -999;
          keyOffset = (keyOffset + length + 3) & ~3;
          break;
        }
        if (hashes[id] === hash && lengths[id] === length && heads[id] === head) {
          let same = length <= 4 || view.getInt32(p - 4, true) === tails[id];
          if (same && length > 8) same = view.getInt32(start + 4, true) === middles[id];
          if (same) {
            let i = 8;
            const key = offsets[id];
            while (
              i < length - 4 &&
              view.getInt32(start + i, true) === keys.getInt32(key + i, true)
            )
              i += 4;
            if (i >= length - 4) break;
          }
        }
        slot = (slot + 1) & mask;
      }
      p++;
      const temperature = view.getUint32(p, true);
      const negative = (~temperature & 0x10) >>> 4;
      const digits = temperature >>> (negative * 8);
      const width = 4 + negative + ((digits >>> 12) & 1);
      let value = temperatureBase(digits) + (buffer[p + width - 2] & 15);
      if (negative) value = -value;
      p += width;
      if (buffer[p - 1] === 13) p++;
      update(id, value);
      return p;
    }
    return interleave(buffer, processRow, Number(process.env.STREAMS ?? 1));
  }
  await consume(config, makeParser);
  return Array.from({ length: used }, (_, id) => {
    const name = arena.toString('utf8', offsets[id], offsets[id] + lengths[id]);
    return packedStats
      ? [name, packed[id * 4], packed[id * 4 + 2], packed[id * 4 + 1], packed[id * 4 + 3]]
      : [name, minimums[id], sums[id], maximums[id], counts[id]];
  });
}
