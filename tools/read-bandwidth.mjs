// Diagnostic only: copy the whole input through the production Wasm reader,
// without parsing or aggregation. This measures headroom in the current read
// path, not a theoretical lower bound for every possible implementation.
import { closeSync, fstatSync, openSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { consume } from '../lib/read.mjs';

function readOnly(config) {
  let chunks = 0;
  consume(config, () => () => chunks++);
  return chunks;
}

if (!isMainThread) {
  parentPort.postMessage(readOnly(workerData));
} else {
  const started = performance.now();
  const file = process.argv[2] ?? 'measurements.txt';
  const chunkSize = Number(process.env.CHUNK_BYTES ?? 524288);
  const requested = Number(process.env.WORKERS ?? availableParallelism());
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 128 || chunkSize > 268435456)
    throw new Error('Invalid CHUNK_BYTES');
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > 256)
    throw new Error('Invalid WORKERS');
  const fd = openSync(file, 'r');
  const threads = [];
  try {
    const size = fstatSync(fd).size;
    const workers = Math.min(requested, Math.max(1, Math.ceil(size / chunkSize)));
    const config = { fd, size, chunkSize, queue: new SharedArrayBuffer(64) };
    const parts =
      workers === 1
        ? [readOnly(config)]
        : await Promise.all(
            Array.from(
              { length: workers },
              () =>
                new Promise((resolve, reject) => {
                  const worker = new Worker(new URL(import.meta.url), { workerData: config });
                  threads.push(worker);
                  let result;
                  worker.once('message', (value) => {
                    result = value;
                  });
                  worker.once('error', reject);
                  worker.once('exit', (code) => {
                    if (code !== 0 || result === undefined)
                      reject(new Error(`Worker exit ${code}`));
                    else resolve(result);
                  });
                }),
            ),
          );
    const chunks = parts.reduce((a, b) => a + b, 0);
    if (chunks !== Math.ceil(size / chunkSize)) throw new Error('Incomplete read');
    const seconds = (performance.now() - started) / 1000;
    console.log(
      JSON.stringify({
        file,
        bytes: size,
        workers,
        chunkSize,
        chunks,
        seconds,
        GBps: size / seconds / 1e9,
        includesParsing: false,
      }),
    );
  } catch (error) {
    await Promise.all(threads.map((worker) => worker.terminate()));
    throw error;
  } finally {
    closeSync(fd);
  }
}
