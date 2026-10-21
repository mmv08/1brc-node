import { consume } from '../lib/read.mjs';

const BYTE_MASKS = [0, 0xff, 0xffff, 0xffffff];
const MAX_STATIONS = 10000;
const TABLE_SIZE = 32768;
const temperaturePrefixes = new Uint16Array(4096);
for (let first = 0; first <= 9; first++) {
  temperaturePrefixes[0xe00 | first] = first * 10;
  for (let second = 0; second <= 9; second++) {
    temperaturePrefixes[(second << 8) | first] = first * 100 + second * 10;
  }
}

// Scan independent station names before updating either aggregate. This breaks
// the next-row dependency chain and lets the CPU overlap more work. Two cursors
// won the full-file comparison.
// Keep cold insertion out of the hot functions to make V8 inlining affordable.
export function aggregate(config) {
  const table = new Uint16Array(TABLE_SIZE);
  // Worker-local, direct-mapped predictions; the hash table remains authoritative.
  // Carry the name length with its ID to avoid a dependent record load on hits.
  const prefixCache = new Uint32Array(32768);
  // Dense station IDs. Each 32-byte record holds hash, head, tail, middle,
  // byte length, arena offset, minimum, maximum, in that order.
  const records = new Int32Array(MAX_STATIONS * 8);
  const sums = new Float64Array(MAX_STATIONS);
  const counts = new Uint32Array(MAX_STATIONS);
  const arena = Buffer.allocUnsafe(MAX_STATIONS * 104 + 16);
  const keys = new DataView(arena.buffer, arena.byteOffset, arena.byteLength);
  let used = 0;
  let keyOffset = 0;

  function insert(buffer, view, start, end, hash, head, slot) {
    if (used === MAX_STATIONS) throw new Error('Too many stations');
    const id = used++;
    const r = id * 8;
    const length = end - start;
    table[slot] = id + 1;
    // Keep sums half-integral so V8 uses direct Float64 addition instead of
    // speculative integer conversions and range checks. The challenge bound
    // is below 2^40 tenths, so this bias and every update remain exact.
    sums[id] = 0.5;
    buffer.copy(arena, keyOffset, start, end);
    records[r] = hash;
    records[r + 1] = head;
    // The tail word ends with the delimiter, so matching it also confirms a
    // predicted length. Shorter names are covered by their masked head.
    records[r + 2] = length >= 4 ? view.getInt32(end - 3, true) : 0;
    // Below eight bytes the middle word overlaps the tail, avoiding a length branch.
    records[r + 3] = length >= 4 ? view.getInt32(start + Math.min(4, length - 3), true) : 0;
    records[r + 4] = length;
    records[r + 5] = keyOffset;
    records[r + 6] = 999;
    records[r + 7] = -999;
    keyOffset = (keyOffset + length + 3) & ~3;
    return id;
  }

  // Cache predictions supply the stored length; hash lookups validate it first.
  // Head, middle and the delimiter-terminated tail cover names below 12 bytes.
  function equal(view, start, length, r, head) {
    if (records[r + 1] !== head) return false;
    if (length < 4) return true;
    if (view.getInt32(start + length - 3, true) !== records[r + 2]) return false;
    if (view.getInt32(start + Math.min(4, length - 3), true) !== records[r + 3]) return false;
    for (let i = 8; i < length - 3; i += 4) {
      if (view.getInt32(start + i, true) !== keys.getInt32(records[r + 5] + i, true)) return false;
    }
    return true;
  }

  function makeParser(buffer) {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    function find(start, end, hash, head) {
      let slot = (hash ^ (hash >>> 16)) & (TABLE_SIZE - 1);
      for (;;) {
        const id = table[slot] - 1;
        if (id < 0) return insert(buffer, view, start, end, hash, head, slot);
        const r = id << 3;
        const length = end - start;
        if (records[r] === hash && records[r + 4] === length && equal(view, start, length, r, head))
          return id;
        slot = (slot + 1) & (TABLE_SIZE - 1);
      }
    }

    // Return the ID in the low 14 bits and the temperature's offset from the row
    // start above them. Passing the position through a typed array instead put
    // a store and reload on each lane's dependency chain.
    function scan(p) {
      const start = p;
      let head = view.getInt32(p, true);
      // A fifth byte is stable even for four-byte names: it is their delimiter.
      // It distinguishes common four-byte prefixes without scanning the name.
      const prefixSlot = Math.imul(head ^ buffer[p + 4], 0x9e3779b1) >>> 17;
      const prediction = prefixCache[prefixSlot];
      const predicted = (prediction & 0xffff) - 1;
      if (predicted >= 0) {
        const r = predicted << 3;
        const length = prediction >>> 16;
        // The largest prediction is 100 bytes; the reader reserves 256 bytes of
        // lookahead. Full equality including the delimiter rejects a wrong
        // length, another row, stale padding, or a short name whose first word
        // includes its delimiter. Only names of at least four bytes are cached.
        if (equal(view, start, length, r, head)) {
          return ((length + 1) << 14) | predicted;
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
      const id = find(start, p, hash, head);
      // Never cache a short name: its initial word includes temperature bytes.
      if (p - start >= 4) prefixCache[prefixSlot] = ((p - start) << 16) | (id + 1);
      return ((p + 1 - start) << 14) | id;
    }

    function update(p, id) {
      const word = view.getUint32(p, true);
      const negative = (~word & 0x10) >>> 4;
      const digits = word >>> (negative << 3);
      const width = 4 + negative + ((digits >>> 12) & 1);
      // Signs are unpredictable: negate with arithmetic instead of a branch.
      const magnitude = temperaturePrefixes[digits & 0x0f0f] + (buffer[p + width - 2] & 15);
      const value = ((magnitude ^ -negative) + negative) | 0;
      p += width;
      if (buffer[p - 1] === 13) p++;
      const r = id << 3;
      if (value < records[r + 6]) records[r + 6] = value;
      if (value > records[r + 7]) records[r + 7] = value;
      sums[id] += value;
      counts[id]++;
      return p;
    }

    function remainder(p, end) {
      while (p < end) {
        const row = scan(p);
        p = update(p + (row >>> 14), row & 0x3fff);
      }
    }

    return (start, end) => {
      // Buffer-local bounds fit in int32; file offsets remain full JS numbers.
      const limit = end | 0;
      const endA = Math.min(end, buffer.indexOf(10, start + ((end - start) >> 1)) + 1) | 0;
      let a = start | 0;
      let b = endA;
      while (a < endA && b < limit) {
        const rowA = scan(a);
        const rowB = scan(b);
        a = update(a + (rowA >>> 14), rowA & 0x3fff) | 0;
        b = update(b + (rowB >>> 14), rowB & 0x3fff) | 0;
      }
      remainder(a, endA);
      remainder(b, limit);
    };
  }

  consume(config, makeParser);
  return Array.from({ length: used }, (_, id) => {
    const r = id * 8;
    const offset = records[r + 5];
    return [
      arena.toString('utf8', offset, offset + records[r + 4]),
      records[r + 6],
      sums[id] - 0.5,
      records[r + 7],
      counts[id],
    ];
  });
}
