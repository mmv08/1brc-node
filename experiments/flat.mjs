import {
  BYTE_MASKS,
  chooseTemperatureParser,
  interleave,
  MAX_STATIONS,
} from '../lib/parse-utils.mjs';
import { consume } from '../lib/read.mjs';

export async function aggregate(config) {
  const size = 2 ** Number(process.env.TABLE_BITS ?? 15);
  if (![16384, 32768, 65536].includes(size)) throw new Error('TABLE_BITS must be 14, 15, or 16');
  const table = new Uint16Array(size);
  // Optional experiment: cover the full Uint16 domain and mask IDs so V8 can
  // potentially eliminate bounds checks. The legal station limit stays 10,000.
  const capacity = config.masked ? 65536 : MAX_STATIONS;
  const idMask = config.masked ? 0xffff : -1;
  // Dense IDs keep the actual metadata compact even when the hash table is sparse.
  // Each 32-byte record: hash, head, tail, middle, length, key offset, min, max.
  const records = new Int32Array(capacity * 8);
  const sums = new Float64Array(capacity);
  const counts = new Uint32Array(capacity);
  const arena = Buffer.allocUnsafe(MAX_STATIONS * 104 + 16);
  const keys = new DataView(arena.buffer, arena.byteOffset, arena.byteLength);
  const temperatureBase = chooseTemperatureParser();
  let used = 0;
  let keyOffset = 0;

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
      let slot = (hash ^ (hash >>> 16)) & (size - 1);
      let id;
      let record;
      for (;;) {
        const entry = table[slot];
        id = (entry - 1) & idMask;
        record = id * 8;
        if (entry === 0) {
          if (used === MAX_STATIONS) throw new Error('Too many stations');
          id = used++;
          record = id * 8;
          table[slot] = id + 1;
          buffer.copy(arena, keyOffset, start, p);
          records[record] = hash;
          records[record + 1] = head;
          records[record + 2] = length > 4 ? view.getInt32(p - 4, true) : 0;
          records[record + 3] = length > 8 ? view.getInt32(start + 4, true) : 0;
          records[record + 4] = length;
          records[record + 5] = keyOffset;
          records[record + 6] = 999;
          records[record + 7] = -999;
          keyOffset = (keyOffset + length + 3) & ~3;
          break;
        }
        if (
          records[record] === hash &&
          records[record + 4] === length &&
          records[record + 1] === head
        ) {
          let same = length <= 4 || view.getInt32(p - 4, true) === records[record + 2];
          if (same && length > 8) same = view.getInt32(start + 4, true) === records[record + 3];
          if (same) {
            let i = 8;
            const key = records[record + 5];
            while (
              i < length - 4 &&
              view.getInt32(start + i, true) === keys.getInt32(key + i, true)
            )
              i += 4;
            if (i >= length - 4) break;
          }
        }
        slot = (slot + 1) & (size - 1);
      }
      id &= idMask;
      record = id * 8;
      p++;
      const temperature = view.getUint32(p, true);
      const negative = (~temperature & 0x10) >>> 4;
      const digits = temperature >>> (negative * 8);
      const width = 4 + negative + ((digits >>> 12) & 1);
      let value = temperatureBase(digits) + (buffer[p + width - 2] & 15);
      if (negative) value = -value;
      p += width;
      if (buffer[p - 1] === 13) p++;
      if (value < records[record + 6]) records[record + 6] = value;
      if (value > records[record + 7]) records[record + 7] = value;
      sums[id] += value;
      counts[id]++;
      return p;
    }
    return interleave(buffer, processRow, Number(process.env.STREAMS ?? 1));
  }
  await consume(config, makeParser);
  return Array.from({ length: used }, (_, id) => {
    const record = id * 8;
    const start = records[record + 5];
    return [
      arena.toString('utf8', start, start + records[record + 4]),
      records[record + 6],
      sums[id],
      records[record + 7],
      counts[id],
    ];
  });
}
