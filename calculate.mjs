import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readlinkSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { aggregate } from './lib/aggregate.mjs';
import { format } from './lib/format.mjs';

async function runEngine(config) {
  if (process.env.PIN_WORKERS) {
    const cpus = process.env.PIN_WORKERS.split(',');
    const tid = readlinkSync('/proc/thread-self').split('/').at(-1);
    execFileSync('taskset', ['-pc', cpus[(config.workerIndex ?? 0) % cpus.length], tid], {
      stdio: 'ignore',
    });
  }
  if (config.engine === 'phased') return aggregate(config);
  if (config.engine === 'wasm') return (await import('./wasm/engine.mjs')).aggregate(config);
  if (config.engine === 'baseline') return (await import('./lib/baseline.mjs')).aggregate(config);
  if (
    !['objects', 'flat', 'soa', 'masked', 'round3', 'hybrid', 'lean', 'direct'].includes(
      config.engine,
    )
  )
    throw new Error('Unknown ENGINE');
  const engine = await import(`./experiments/${config.engine}.mjs`);
  return engine.aggregate(config);
}

export async function calculate(file, options = {}) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const chunkSize = options.chunkSize ?? Number(process.env.CHUNK_BYTES ?? 128 * 1024);
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
      file: file instanceof URL ? fileURLToPath(file) : file,
      engine: options.engine ?? process.env.ENGINE ?? 'phased',
    };
    if (workers === 1) return await runEngine(config);
    const threads = [];
    try {
      const parts = await Promise.all(
        Array.from(
          { length: workers },
          (_, workerIndex) =>
            new Promise((resolve, reject) => {
              const worker = new Worker(new URL(import.meta.url), {
                workerData: { ...config, workerIndex },
              });
              threads.push(worker);
              let result;
              worker.once('message', (data) => {
                result = data;
              });
              worker.once('error', reject);
              worker.once('exit', (code) => {
                if (code !== 0 || !result) reject(new Error(`Worker exited with code ${code}`));
                else resolve(result);
              });
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
    } finally {
      await Promise.all(threads.map((worker) => worker.terminate()));
    }
  } finally {
    closeSync(fd);
  }
}

if (!isMainThread) {
  parentPort.postMessage(await runEngine(workerData));
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(format(await calculate(process.argv[2] ?? 'measurements.txt')));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
