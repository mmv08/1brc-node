import { readSync } from 'node:fs';

export function consume(
  { fd, size, chunkSize, queue },
  makeParser,
  allocateBuffer = Buffer.allocUnsafe,
) {
  const next = new Int32Array(queue);
  const buffer = allocateBuffer(chunkSize + 256);
  const parse = makeParser(buffer);
  let cursor = 0;
  let limit = 0;
  for (;;) {
    if (cursor >= limit) {
      cursor = Atomics.add(next, 0, 16) * chunkSize;
      limit = Math.min(cursor + 16 * chunkSize, size);
    }
    if (cursor >= size) break;
    const offset = cursor;
    cursor += chunkSize;
    // Include the preceding byte to distinguish a row-aligned chunk from a
    // partial first row. The overlap completes the last row owned by this chunk.
    const position = offset === 0 ? 0 : offset - 1;
    const wanted = Math.min(chunkSize + 128, size - position);
    let bytes = 0;
    while (bytes < wanted) {
      const n = readSync(fd, buffer, bytes, wanted - bytes, position + bytes);
      if (!n) throw new Error('Input file changed while reading');
      bytes += n;
    }
    buffer.fill(0, bytes, bytes + 32); // Safe SIMD lookahead at EOF.
    buffer[bytes] = 10; // Also accept an absent final newline.
    const start = offset === 0 ? 0 : buffer.indexOf(10) + 1;
    const end = Math.min(offset + chunkSize - position, bytes);
    parse(start, end);
  }
}
