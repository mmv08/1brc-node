import { BYTE_MASKS, chooseTemperatureParser, MAX_STATIONS } from './parse-utils.mjs';
import { consume } from './read.mjs';

// Scan independent station names before updating either aggregate. This breaks
// the next-row dependency chain and lets the CPU overlap more work. Two cursors
// won the full-file comparison; 1/3/4 remain selectable for reproducible tests.
// Keep cold insertion out of the hot functions to make V8 inlining affordable.
export async function aggregate(config) {
  const tableSize = 2 ** Number(process.env.TABLE_BITS ?? 15);
  if (![16384, 32768, 65536].includes(tableSize))
    throw new Error('TABLE_BITS must be 14, 15, or 16');
  const table = new Uint16Array(tableSize);
  // Worker-local, direct-mapped predictions; the hash table remains authoritative.
  const prefixCache = new Uint16Array(65536);
  // Dense station IDs. Each 32-byte record holds hash, head, tail, middle,
  // byte length, arena offset, minimum, maximum, in that order.
  const records = new Int32Array(MAX_STATIONS * 8);
  const sums = new Float64Array(MAX_STATIONS);
  const counts = new Uint32Array(MAX_STATIONS);
  const arena = Buffer.allocUnsafe(MAX_STATIONS * 104 + 16);
  const keys = new DataView(arena.buffer, arena.byteOffset, arena.byteLength);
  const temperatureBase = chooseTemperatureParser();
  const branchlessNames = (process.env.NAME_COMPARE ?? 'branchless') === 'branchless';
  let used = 0;
  let keyOffset = 0;

  function insert(buffer, view, start, end, hash, head, slot) {
    if (used === MAX_STATIONS) throw new Error('Too many stations');
    const id = used++;
    const r = id * 8;
    const length = end - start;
    table[slot] = id + 1;
    buffer.copy(arena, keyOffset, start, end);
    records[r] = hash;
    records[r + 1] = head;
    records[r + 2] = length > 4 ? view.getInt32(end - 4, true) : 0;
    // For short names the middle word overlaps the tail. This permits testing
    // an unconditional middle-word comparison instead of a length > 8 branch.
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
    if (branchlessNames) {
      if (view.getInt32(start + Math.min(4, length - 4), true) !== records[r + 3]) return false;
    } else if (length > 8 && view.getInt32(start + 4, true) !== records[r + 3]) return false;
    const offset = records[r + 5];
    for (let i = 8; i < length - 4; i += 4) {
      if (view.getInt32(start + i, true) !== keys.getInt32(offset + i, true)) return false;
    }
    return true;
  }

  function makeParser(buffer) {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const temperatures = new Int32Array(4);
    const streams = Number(process.env.STREAMS ?? 2);
    if (![1, 2, 3, 4].includes(streams)) throw new Error('STREAMS must be 1..4');

    function find(start, end, hash, head) {
      let slot = (hash ^ (hash >>> 16)) & (tableSize - 1);
      for (;;) {
        const id = table[slot] - 1;
        if (id < 0) return insert(buffer, view, start, end, hash, head, slot);
        if (records[id * 8] === hash && equal(view, start, end, id * 8, head)) return id;
        slot = (slot + 1) & (tableSize - 1);
      }
    }

    function scan(p, lane) {
      const start = p;
      let head = view.getInt32(p, true);
      const prefixSlot = Math.imul(head ^ (head >>> 16), 0x9e3779b1) >>> 16;
      const predicted = prefixCache[prefixSlot] - 1;
      if (predicted >= 0) {
        const r = predicted * 8;
        const end = start + records[r + 4];
        // The largest prediction is 100 bytes; the reader reserves 256 bytes of
        // lookahead. Full equality plus the delimiter rejects a wrong length,
        // another row, stale padding, or a short name whose first word includes
        // its delimiter. Only names of at least four bytes enter this cache.
        if (buffer[end] === 59 && equal(view, start, end, r, head)) {
          temperatures[lane] = end + 1;
          return predicted;
        }
      }
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
      if (p - start < 4) head &= BYTE_MASKS[p - start];
      temperatures[lane] = p + 1;
      const id = find(start, p, hash, head);
      // Never cache a short name: its initial word includes temperature bytes.
      if (p - start >= 4) prefixCache[prefixSlot] = id + 1;
      return id;
    }

    function update(p, id) {
      const word = view.getUint32(p, true);
      const negative = (~word & 0x10) >>> 4;
      const digits = word >>> (negative * 8);
      const width = 4 + negative + ((digits >>> 12) & 1);
      let value = temperatureBase(digits) + (buffer[p + width - 2] & 15);
      if (negative) value = -value;
      p += width;
      if (buffer[p - 1] === 13) p++;
      const r = id * 8;
      if (value < records[r + 6]) records[r + 6] = value;
      if (value > records[r + 7]) records[r + 7] = value;
      sums[id] += value;
      counts[id]++;
      return p;
    }

    function remainder(p, end) {
      while (p < end) {
        const id = scan(p, 0);
        p = update(temperatures[0], id);
      }
    }

    return (start, end) => {
      if (streams === 1) return remainder(start, end);
      const boundary = (part) =>
        Math.min(end, buffer.indexOf(10, start + Math.floor(((end - start) * part) / streams)) + 1);
      const endA = boundary(1);
      const endB = streams > 2 ? boundary(2) : end;
      const endC = streams > 3 ? boundary(3) : end;
      let a = start;
      let b = endA;
      let c = endB;
      let d = endC;
      if (streams === 2) {
        while (a < endA && b < end) {
          const idA = scan(a, 0);
          const idB = scan(b, 1);
          a = update(temperatures[0], idA);
          b = update(temperatures[1], idB);
        }
      } else if (streams === 3) {
        while (a < endA && b < endB && c < end) {
          const idA = scan(a, 0);
          const idB = scan(b, 1);
          const idC = scan(c, 2);
          a = update(temperatures[0], idA);
          b = update(temperatures[1], idB);
          c = update(temperatures[2], idC);
        }
      } else {
        while (a < endA && b < endB && c < endC && d < end) {
          const idA = scan(a, 0);
          const idB = scan(b, 1);
          const idC = scan(c, 2);
          const idD = scan(d, 3);
          a = update(temperatures[0], idA);
          b = update(temperatures[1], idB);
          c = update(temperatures[2], idC);
          d = update(temperatures[3], idD);
        }
      }
      remainder(a, endA);
      remainder(b, endB);
      if (streams > 2) remainder(c, endC);
      if (streams > 3) remainder(d, end);
    };
  }

  await consume(config, makeParser);
  return Array.from({ length: used }, (_, id) => {
    const r = id * 8;
    const offset = records[r + 5];
    return [
      arena.toString('utf8', offset, offset + records[r + 4]),
      records[r + 6],
      sums[id],
      records[r + 7],
      counts[id],
    ];
  });
}
