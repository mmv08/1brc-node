import { BYTE_MASKS, chooseTemperatureParser, interleave } from '../lib/parse-utils.mjs';
import { consume } from '../lib/read.mjs';

// The original object layout, restructured to permit independent row cursors
// and reader experiments. The original implementation remains lib/baseline.mjs.
export async function aggregate(config) {
  const size = 2 ** Number(process.env.TABLE_BITS ?? 15);
  if (![16384, 32768, 65536].includes(size)) throw new Error('TABLE_BITS must be 14, 15, or 16');
  const table = new Array(size).fill(null);
  const entries = [];
  const temperatureBase = chooseTemperatureParser();

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
      let entry;
      for (;;) {
        entry = table[slot];
        if (!entry) {
          const key = Buffer.from(buffer.subarray(start, p));
          entry = {
            hash,
            head,
            length,
            key,
            tail: length > 4 ? key.readInt32LE(length - 4) : 0,
            middle: length > 8 ? key.readInt32LE(4) : 0,
            keyView: new DataView(key.buffer, key.byteOffset, key.byteLength),
            min: 999,
            max: -999,
            sum: 0.1,
            count: 0,
          };
          entry.sum = 0;
          table[slot] = entry;
          entries.push(entry);
          break;
        }
        if (entry.hash === hash && entry.length === length && entry.head === head) {
          let same = length <= 4 || view.getInt32(p - 4, true) === entry.tail;
          if (same && length > 8) same = view.getInt32(start + 4, true) === entry.middle;
          if (same) {
            let i = 8;
            while (
              i < length - 4 &&
              view.getInt32(start + i, true) === entry.keyView.getInt32(i, true)
            )
              i += 4;
            if (i >= length - 4) break;
          }
        }
        slot = (slot + 1) & (size - 1);
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
      if (value < entry.min) entry.min = value;
      if (value > entry.max) entry.max = value;
      entry.sum += value;
      entry.count++;
      return p;
    }
    return interleave(buffer, processRow, Number(process.env.STREAMS ?? 1));
  }
  await consume(config, makeParser);
  return entries.map((e) => [e.key.toString(), e.min, e.sum, e.max, e.count]);
}
