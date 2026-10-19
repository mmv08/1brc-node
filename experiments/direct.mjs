import { BYTE_MASKS, chooseTemperatureParser, MAX_STATIONS } from '../lib/parse-utils.mjs';
import { consume } from '../lib/read.mjs';

// Minimal-diff control: preserve the production scanner's shape while changing
// record placement and hash arithmetic. No per-word callback dispatch.
export async function aggregate(config) {
  const tableSize = 32768;
  const table = new Uint16Array(tableSize);
  const fused = process.env.RECORD_LAYOUT === 'fused';
  const bytes = Number(process.env.RECORD_BYTES ?? 48);
  if (![48, 64].includes(bytes)) throw new Error('RECORD_BYTES must be 48 or 64');
  const stride = fused ? bytes / 4 : 8;
  const storage = new ArrayBuffer(MAX_STATIONS * stride * 4);
  const records = new Int32Array(storage);
  const sums = fused ? new Float64Array(storage) : new Float64Array(MAX_STATIONS);
  const counts = fused ? new Uint32Array(storage) : new Uint32Array(MAX_STATIONS);
  const arena = Buffer.allocUnsafe(MAX_STATIONS * 104 + 16);
  const keys = new DataView(arena.buffer, arena.byteOffset, arena.byteLength);
  const temperatureBase = chooseTemperatureParser();
  const hashMode = process.env.HASH_MODE ?? 'fnv';
  if (!['fnv', 'rotate', 'rotate-mix'].includes(hashMode)) throw new Error('Unknown HASH_MODE');
  const rotate = hashMode !== 'fnv';
  const avalanche = hashMode === 'rotate-mix';
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

    function scan(p, lane) {
      const start = p;
      let head = view.getInt32(p, true);
      let word = head;
      let hash = 0;
      for (;;) {
        const x = word ^ 0x3b3b3b3b;
        const matches = (x - 0x01010101) & ~x & 0x80808080;
        if (matches) {
          const bytes = (31 - Math.clz32(matches & -matches)) >>> 3;
          const tail = word & BYTE_MASKS[bytes];
          hash = rotate ? ((hash << 5) | (hash >>> 27)) ^ tail : Math.imul(hash ^ tail, 0x9e3779b1);
          p += bytes;
          break;
        }
        hash = rotate ? ((hash << 5) | (hash >>> 27)) ^ word : Math.imul(hash ^ word, 0x9e3779b1);
        p += 4;
        word = view.getInt32(p, true);
      }
      if (avalanche) hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
      if (p - start < 4) head &= BYTE_MASKS[p - start];
      temperatures[lane] = p + 1;
      return find(start, p, hash, head);
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
