import { BYTE_MASKS, chooseTemperatureParser, MAX_STATIONS } from '../lib/parse-utils.mjs';
import { consume } from '../lib/read.mjs';

function semicolons(word) {
  const x = word ^ 0x3b3b3b3b;
  return (x - 0x01010101) & ~x & 0x80808080;
}

function firstByte(mask) {
  return (31 - Math.clz32(mask & -mask)) >>> 3;
}

// Separate small scanner functions avoid runtime strategy branches in the word
// loop. This controls for the inlining overhead in the generic round3 engine.
export async function aggregate(config) {
  const tableSize = 32768;
  const table = new Uint16Array(tableSize);
  const fused = process.env.RECORD_LAYOUT === 'fused';
  const recordBytes = Number(process.env.RECORD_BYTES ?? 48);
  if (![48, 64].includes(recordBytes)) throw new Error('RECORD_BYTES must be 48 or 64');
  const stride = fused ? recordBytes / 4 : 8;
  const storage = new ArrayBuffer(MAX_STATIONS * stride * 4);
  const records = new Int32Array(storage);
  const sums = fused ? new Float64Array(storage) : new Float64Array(MAX_STATIONS);
  const counts = fused ? new Uint32Array(storage) : new Uint32Array(MAX_STATIONS);
  const arena = Buffer.allocUnsafe(MAX_STATIONS * 104 + 16);
  const keys = new DataView(arena.buffer, arena.byteOffset, arena.byteLength);
  const temperatureBase = chooseTemperatureParser();
  let used = 0;
  let keyOffset = 0;

  function insert(buffer, view, start, end, hash, head, slot) {
    if (used === MAX_STATIONS) throw new Error('Too many stations');
    const id = used++;
    const r = id * stride;
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

  function makeParser(buffer) {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const temperatures = new Int32Array(2);

    function find(start, end, hash, head) {
      let slot = (hash ^ (hash >>> 16)) & (tableSize - 1);
      for (;;) {
        const id = table[slot] - 1;
        if (id < 0) return insert(buffer, view, start, end, hash, head, slot);
        if (records[id * stride] === hash && equal(view, start, end, id * stride, head)) return id;
        slot = (slot + 1) & (tableSize - 1);
      }
    }

    function finish(start, end, hash, head, lane) {
      if (end - start < 4) head &= BYTE_MASKS[end - start];
      temperatures[lane] = end + 1;
      return find(start, end, hash, head);
    }

    function scanMultiply(p, lane) {
      const start = p;
      const head = view.getInt32(p, true);
      let word = head;
      let hash = 0;
      for (;;) {
        const matches = semicolons(word);
        if (matches) {
          const bytes = firstByte(matches);
          hash = Math.imul(hash ^ (word & BYTE_MASKS[bytes]), 0x9e3779b1);
          return finish(start, p + bytes, hash, head, lane);
        }
        hash = Math.imul(hash ^ word, 0x9e3779b1);
        p += 4;
        word = view.getInt32(p, true);
      }
    }

    function scanRotate(p, lane) {
      const start = p;
      const head = view.getInt32(p, true);
      let word = head;
      let hash = 0;
      for (;;) {
        const matches = semicolons(word);
        if (matches) {
          const bytes = firstByte(matches);
          hash = ((hash << 5) | (hash >>> 27)) ^ (word & BYTE_MASKS[bytes]);
          return finish(start, p + bytes, hash, head, lane);
        }
        hash = ((hash << 5) | (hash >>> 27)) ^ word;
        p += 4;
        word = view.getInt32(p, true);
      }
    }

    function scanShift(p, lane) {
      const start = p;
      const head = view.getInt32(p, true);
      let word = head;
      let hash = 0;
      for (;;) {
        const matches = semicolons(word);
        if (matches) {
          const bytes = firstByte(matches);
          hash = ((hash << 5) - hash) ^ (word & BYTE_MASKS[bytes]);
          return finish(start, p + bytes, hash, head, lane);
        }
        hash = ((hash << 5) - hash) ^ word;
        p += 4;
        word = view.getInt32(p, true);
      }
    }

    function scanDual(p, lane) {
      const start = p;
      const head = view.getInt32(p, true);
      let word = head;
      let hash = 0;
      let other = 0;
      for (;;) {
        const matches = semicolons(word);
        if (matches) {
          const bytes = firstByte(matches);
          hash = Math.imul(hash ^ (word & BYTE_MASKS[bytes]), 0x9e3779b1);
          return finish(start, p + bytes, hash ^ Math.imul(other, 0x85ebca6b), head, lane);
        }
        const next = Math.imul(hash ^ word, 0x9e3779b1);
        hash = other;
        other = next;
        p += 4;
        word = view.getInt32(p, true);
      }
    }

    function scanMultiply8(p, lane) {
      const start = p;
      const head = view.getInt32(p, true);
      let word = head;
      let hash = 0;
      for (;;) {
        let matches = semicolons(word);
        if (matches) {
          const bytes = firstByte(matches);
          return finish(
            start,
            p + bytes,
            Math.imul(hash ^ (word & BYTE_MASKS[bytes]), 0x9e3779b1),
            head,
            lane,
          );
        }
        hash = Math.imul(hash ^ word, 0x9e3779b1);
        p += 4;
        word = view.getInt32(p, true);
        matches = semicolons(word);
        if (matches) {
          const bytes = firstByte(matches);
          return finish(
            start,
            p + bytes,
            Math.imul(hash ^ (word & BYTE_MASKS[bytes]), 0x9e3779b1),
            head,
            lane,
          );
        }
        hash = Math.imul(hash ^ word, 0x9e3779b1);
        p += 4;
        word = view.getInt32(p, true);
      }
    }

    function scanRotate8(p, lane) {
      const start = p;
      const head = view.getInt32(p, true);
      let word = head;
      let hash = 0;
      for (;;) {
        let matches = semicolons(word);
        if (matches) {
          const bytes = firstByte(matches);
          return finish(
            start,
            p + bytes,
            ((hash << 5) | (hash >>> 27)) ^ (word & BYTE_MASKS[bytes]),
            head,
            lane,
          );
        }
        hash = ((hash << 5) | (hash >>> 27)) ^ word;
        p += 4;
        word = view.getInt32(p, true);
        matches = semicolons(word);
        if (matches) {
          const bytes = firstByte(matches);
          return finish(
            start,
            p + bytes,
            ((hash << 5) | (hash >>> 27)) ^ (word & BYTE_MASKS[bytes]),
            head,
            lane,
          );
        }
        hash = ((hash << 5) | (hash >>> 27)) ^ word;
        p += 4;
        word = view.getInt32(p, true);
      }
    }

    const hashMode = process.env.HASH_MODE ?? 'fnv';
    const eight = process.env.SCAN_BYTES === '8';
    if (eight && !['fnv', 'rotate'].includes(hashMode))
      throw new Error('Eight-byte scan supports fnv or rotate');
    const scanners = {
      fnv: eight ? scanMultiply8 : scanMultiply,
      rotate: eight ? scanRotate8 : scanRotate,
      shift: scanShift,
      dual: scanDual,
    };
    const scan = scanners[hashMode];
    if (!scan) throw new Error('Unknown HASH_MODE');

    function update(p, id) {
      const word = view.getUint32(p, true);
      const negative = (~word & 0x10) >>> 4;
      const digits = word >>> (negative * 8);
      const width = 4 + negative + ((digits >>> 12) & 1);
      let value = temperatureBase(digits) + (buffer[p + width - 2] & 15);
      if (negative) value = -value;
      p += width;
      if (buffer[p - 1] === 13) p++;
      const r = id * stride;
      if (value < records[r + 6]) records[r + 6] = value;
      if (value > records[r + 7]) records[r + 7] = value;
      if (fused) {
        sums[(r >>> 1) + 4] += value;
        counts[r + 10]++;
      } else {
        sums[id] += value;
        counts[id]++;
      }
      return p;
    }

    return (start, end) => {
      const middle = Math.min(end, buffer.indexOf(10, start + ((end - start) >>> 1)) + 1);
      let a = start;
      let b = middle;
      while (a < middle && b < end) {
        const idA = scan(a, 0);
        const idB = scan(b, 1);
        a = update(temperatures[0], idA);
        b = update(temperatures[1], idB);
      }
      while (a < middle) {
        const id = scan(a, 0);
        a = update(temperatures[0], id);
      }
      while (b < end) {
        const id = scan(b, 0);
        b = update(temperatures[0], id);
      }
    };
  }

  await consume(config, makeParser);
  return Array.from({ length: used }, (_, id) => {
    const r = id * stride;
    const offset = records[r + 5];
    return [
      arena.toString('utf8', offset, offset + records[r + 4]),
      records[r + 6],
      sums[fused ? (r >>> 1) + 4 : id],
      records[r + 7],
      counts[fused ? r + 10 : id],
    ];
  });
}
