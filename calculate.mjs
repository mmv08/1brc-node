import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

export async function calculate(file, options = {}) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const chunkSize = options.chunkSize ?? Number(process.env.CHUNK_BYTES ?? 512 * 1024);
    const requested = options.workers ?? Number(process.env.WORKERS ?? availableParallelism());
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 128 || chunkSize > 256 * 1024 * 1024) {
      throw new Error('CHUNK_BYTES must be an integer between 128 and 268435456');
    }
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > 256) {
      throw new Error('WORKERS must be an integer between 1 and 256');
    }
    const workers = Math.min(requested, Math.max(1, Math.ceil(size / chunkSize)));
    const queue = new SharedArrayBuffer(64);
    const config = {
      fd,
      size,
      chunkSize,
      queue,
    };
    if (workers === 1) return await (await import('./wasm/engine.mjs')).aggregate(config);
    // Structured cloning shares compiled code; each worker owns its instance.
    config.module = await WebAssembly.compile(
      readFileSync(new URL('./wasm/kernel.wasm', import.meta.url)),
    );
    const threads = [];
    try {
      // Workers load only the kernel engine; each result arrives before its
      // thread finishes exiting.
      const parts = await Promise.all(
        Array.from(
          { length: workers },
          () =>
            new Promise((resolve, reject) => {
              const worker = new Worker(new URL('./wasm/worker.mjs', import.meta.url), {
                workerData: config,
              });
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Workers start before the formatter loads.
    const [rows, { format }] = await Promise.all([
      calculate(process.argv[2] ?? 'measurements.txt'),
      import('./lib/format.mjs'),
    ]);
    process.stdout.write(format(rows));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
