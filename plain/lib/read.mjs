import { closeSync, openSync, read, readSync } from 'node:fs';

const OVERLAP = 128;

// The default reader preserves the original exact row-ownership convention.
// Async mode overlaps the next pread with parsing the current buffer. Macro
// mode schedules large contiguous ranges but parses through a cache-sized buffer.
export async function consume(config, makeParser) {
  const { size, chunkSize, queue } = config;
  const mode = process.env.IO ?? 'sync';
  if (!['sync', 'async', 'macro'].includes(mode)) throw new Error('Unknown IO');
  const next = new Int32Array(queue);
  const macroSize =
    mode === 'macro' ? Number(process.env.MACRO_BYTES ?? 16 * 1024 * 1024) : chunkSize;
  if (!Number.isSafeInteger(macroSize) || macroSize < chunkSize || macroSize % chunkSize !== 0) {
    throw new Error('MACRO_BYTES must be a positive multiple of CHUNK_BYTES');
  }
  const ownFd = process.env.PRIVATE_FD === '1';
  const fd = ownFd ? openSync(config.file, 'r') : config.fd;
  const buffers = Array.from({ length: mode === 'async' ? 2 : 1 }, () =>
    Buffer.allocUnsafe(chunkSize + 256),
  );
  const parsers = buffers.map((buffer) => makeParser(buffer));
  let cursor = 0;
  let limit = 0;
  function claim() {
    if (cursor >= limit) {
      cursor = Atomics.add(next, 0, 1) * macroSize;
      limit = Math.min(cursor + macroSize, size);
    }
    if (cursor >= size) return null;
    const offset = cursor;
    cursor += chunkSize;
    const position = offset === 0 ? 0 : offset - 1;
    return { offset, position, wanted: Math.min(chunkSize + OVERLAP, size - position) };
  }
  function parse(buffer, parser, job) {
    buffer.fill(0, job.wanted, job.wanted + 8);
    buffer[job.wanted] = 10;
    const start = job.offset === 0 ? 0 : buffer.indexOf(10) + 1;
    const end = Math.min(job.offset + chunkSize - job.position, job.wanted);
    parser(start, end);
  }
  function readAsync(buffer, job) {
    return new Promise((resolve, reject) => {
      function more(bytes) {
        read(fd, buffer, bytes, job.wanted - bytes, job.position + bytes, (error, n) => {
          if (error) return reject(error);
          if (n === 0) return reject(new Error('Input file changed while reading'));
          if (bytes + n === job.wanted) resolve();
          else more(bytes + n);
        });
      }
      more(0);
    });
  }
  try {
    if (mode === 'async') {
      let slot = 0;
      let job = claim();
      if (!job) return;
      await readAsync(buffers[slot], job);
      while (job) {
        const other = slot ^ 1;
        const following = claim();
        const pending = following ? readAsync(buffers[other], following) : null;
        parse(buffers[slot], parsers[slot], job);
        await pending;
        job = following;
        slot = other;
      }
    } else {
      for (let job = claim(); job; job = claim()) {
        const buffer = buffers[0];
        let bytes = 0;
        while (bytes < job.wanted) {
          const n = readSync(fd, buffer, bytes, job.wanted - bytes, job.position + bytes);
          if (!n) throw new Error('Input file changed while reading');
          bytes += n;
        }
        parse(buffer, parsers[0], job);
      }
    }
  } finally {
    if (ownFd) closeSync(fd);
  }
}
