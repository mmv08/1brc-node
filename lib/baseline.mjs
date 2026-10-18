// Preserved first-round implementation for paired performance comparisons.
import { readSync } from 'node:fs';

const MASKS = [0, 0xff, 0xffff, 0xffffff];
const TABLE_SIZE = 32768;

// The low nibbles of the first two characters identify either "d." or "dd".
// Each entry is the whole-degree contribution, already expressed in tenths.
// This 8 KiB grammar table avoids an unpredictable one-/two-digit branch; it
// contains no station names or information about the input file.
const TEMPERATURE_PREFIXES = new Uint16Array(4096);
for (let first = 0; first <= 9; first++) {
  TEMPERATURE_PREFIXES[0xe00 | first] = first * 10;
  for (let second = 0; second <= 9; second++) {
    TEMPERATURE_PREFIXES[(second << 8) | first] = first * 100 + second * 10;
  }
}

// A hash is only a hint: always compare the entire name. The caller has already
// verified the length by finding the semicolon in the input.
// DataView gives V8 unaligned 32-bit loads without BigInt or native addons.
function matchesName(view, start, head, entry) {
  if (entry.head !== head) return false;
  if (entry.length <= 4) return true;
  // First and last words cover short names entirely. For longer ones, verify
  // the middle too: a fingerprint collision must never merge two stations.
  const tailOffset = entry.length - 4;
  if (view.getInt32(start + tailOffset, true) !== entry.tail) return false;
  if (entry.length > 8 && view.getInt32(start + 4, true) !== entry.middle) return false;
  for (let i = 8; i < tailOffset; i += 4) {
    if (view.getInt32(start + i, true) !== entry.keyView.getInt32(i, true)) return false;
  }
  return true;
}

function makeEntry(buffer, start, length, hash, head) {
  // Padding makes the final partial word safe to load. It isn't part of the key.
  const key = Buffer.alloc((length + 3) & ~3);
  buffer.copy(key, 0, start, start + length);
  return {
    hash,
    head,
    tail: length > 4 ? key.readInt32LE(length - 4) : 0,
    middle: length > 8 ? key.readInt32LE(4) : 0,
    length,
    key,
    keyView: new DataView(key.buffer, key.byteOffset, key.byteLength),
    min: 999,
    max: -999,
    // Start with a non-integer so V8 allocates a double field from the outset.
    // Reset before use: a station's sum can exceed Int32 in real inputs.
    sum: 0.1,
    count: 0,
  };
}

export function aggregate({ fd, size, chunkSize, queue }) {
  const next = new Int32Array(queue);
  const buffer = Buffer.allocUnsafe(chunkSize + 256);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const table = new Array(TABLE_SIZE).fill(null);
  const entries = [];

  function parse(start, end) {
    let p = start;
    while (p < end) {
      const nameStart = p;
      let head = view.getInt32(p, true);
      let word = head;
      let hash = 0;
      for (;;) {
        // SWAR: XOR makes semicolons zero; this mask finds zero bytes in four
        // lanes at once. Isolate the lowest set bit to find the FIRST match
        // (subtraction can also set a bit in the following byte).
        const x = word ^ 0x3b3b3b3b;
        const matches = (x - 0x01010101) & ~x & 0x80808080;
        if (matches !== 0) {
          const bytes = (31 - Math.clz32(matches & -matches)) >>> 3;
          hash = Math.imul(hash ^ (word & MASKS[bytes]), 0x9e3779b1);
          p += bytes;
          break;
        }
        hash = Math.imul(hash ^ word, 0x9e3779b1);
        p += 4;
        word = view.getInt32(p, true);
      }
      const length = p - nameStart;
      if (length < 4) head &= MASKS[length];
      let slot = (hash ^ (hash >>> 16)) & (TABLE_SIZE - 1);
      let entry;
      for (;;) {
        entry = table[slot];
        if (entry === null) {
          entry = makeEntry(buffer, nameStart, length, hash, head);
          entry.sum = 0;
          table[slot] = entry;
          entries.push(entry);
          break;
        }
        if (
          entry.hash === hash &&
          entry.length === length &&
          matchesName(view, nameStart, head, entry)
        )
          break;
        slot = (slot + 1) & (TABLE_SIZE - 1);
      }
      p++;
      const temperature = view.getUint32(p, true);
      // ASCII '-' and '.' have bit 4 clear; every decimal digit has it set.
      const negative = (~temperature & 0x10) >>> 4;
      const digits = temperature >>> (negative * 8);
      const twoDigits = (digits >>> 12) & 1;
      const width = 4 + negative + twoDigits;
      let value = TEMPERATURE_PREFIXES[digits & 0x0f0f] + (buffer[p + width - 2] & 15);
      if (negative) value = -value;
      p += width;
      if (buffer[p - 1] === 13) p++;

      if (value < entry.min) entry.min = value;
      if (value > entry.max) entry.max = value;
      entry.sum += value;
      entry.count++;
    }
  }

  for (;;) {
    const block = Atomics.add(next, 0, 1);
    const offset = block * chunkSize;
    if (offset >= size) break;
    // One preceding byte disambiguates a chunk that starts exactly at a row.
    // The overlap completes the last owned row (at most 107 bytes including LF).
    const position = offset === 0 ? 0 : offset - 1;
    const wanted = Math.min(chunkSize + 128, size - position);
    let bytes = 0;
    while (bytes < wanted) {
      const n = readSync(fd, buffer, bytes, wanted - bytes, position + bytes);
      if (n === 0) throw new Error('Input file changed while reading');
      bytes += n;
    }
    buffer.fill(0, bytes, bytes + 8);
    buffer[bytes] = 10; // Also accept a final row without LF.
    const start = offset === 0 ? 0 : buffer.indexOf(10, 0) + 1;
    const end = Math.min(offset + chunkSize - position, bytes);
    parse(start, end);
  }
  return entries.map((entry) => [
    entry.key.toString('utf8', 0, entry.length),
    entry.min,
    entry.sum,
    entry.max,
    entry.count,
  ]);
}
