import { closeSync, fstatSync, openSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

// Both engines share scheduling, input validation and exact result merging.
// Workers load their small engine-specific entry points directly.
export function createCalculator(defaultChunkSize, engine, workerEntry) {
  return async function calculate(file, options = {}) {
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      const chunkSize = options.chunkSize ?? Number(process.env.CHUNK_BYTES ?? defaultChunkSize);
      const requested = options.workers ?? Number(process.env.WORKERS ?? availableParallelism());
      if (!Number.isSafeInteger(chunkSize) || chunkSize < 128 || chunkSize > 256 * 1024 * 1024) {
        throw new Error('CHUNK_BYTES must be an integer between 128 and 268435456');
      }
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > 256) {
        throw new Error('WORKERS must be an integer between 1 and 256');
      }
      const workers = Math.min(requested, Math.max(1, Math.ceil(size / chunkSize)));
      const config = { fd, size, chunkSize, queue: new SharedArrayBuffer(64) };
      if (workers === 1) return await (await import(engine)).aggregate(config);
      const threads = [];
      try {
        const parts = await Promise.all(
          Array.from(
            { length: workers },
            () =>
              new Promise((resolve, reject) => {
                const worker = new Worker(workerEntry, { workerData: config });
                threads.push(worker);
                worker.once('message', resolve);
                worker.once('error', reject);
                worker.once('exit', (code) => reject(new Error(`Worker exited with code ${code}`)));
              }),
          ),
        );
        const merged = new Map();
        for (const part of parts) {
          for (const [name, min, sum, max, count] of part) {
            const entry = merged.get(name);
            if (entry) {
              entry[1] = Math.min(entry[1], min);
              entry[2] += sum;
              entry[3] = Math.max(entry[3], max);
              entry[4] += count;
            } else merged.set(name, [name, min, sum, max, count]);
          }
        }
        return [...merged.values()];
      } catch (error) {
        await Promise.all(threads.map((worker) => worker.terminate()));
        throw error;
      }
    } finally {
      closeSync(fd);
    }
  };
}
