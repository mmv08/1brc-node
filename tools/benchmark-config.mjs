import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function nodeRuntime() {
  const local = resolve('.runtimes/node-v26.12.0/bin/node');
  return process.env.NODE_BIN ?? (existsSync(local) ? local : process.execPath);
}

export function entryScript(engine = 'wasm') {
  if (engine === 'wasm') return 'calculate.mjs';
  if (engine === 'node') return 'plain/calculate.mjs';
  throw new Error('ENGINE must be node or wasm');
}

export function nodeFlags(env) {
  if (env.FLAGS !== undefined) return env.FLAGS.split(/\s+/).filter(Boolean);
  return env.ENGINE === 'node'
    ? [
        '--max-inlined-bytecode-size=1000',
        '--max-inlined-bytecode-size-cumulative=4000',
        '--v8-pool-size=8',
      ]
    : [];
}

// Preserve inherited runtime controls as well as per-case overrides.
export function benchmarkEnv(env) {
  const keys = [
    'ENGINE',
    'WORKERS',
    'CHUNK_BYTES',
    'FLAGS',
    'NODE_OPTIONS',
    'NODE_COMPILE_CACHE',
    'NODE_DISABLE_COMPILE_CACHE',
    'UV_THREADPOOL_SIZE',
  ];
  return Object.fromEntries(
    keys.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]),
  );
}

export function sourceHash(engine = 'wasm', script = entryScript(engine)) {
  entryScript(engine); // Validate the engine even for an explicit script path.
  const root = resolve(dirname(script), engine === 'node' ? '..' : '.');
  const paths = ['lib/calculate.mjs', 'lib/format.mjs', 'lib/read.mjs'];
  paths.push(
    ...(engine === 'node'
      ? ['plain/aggregate.mjs', 'plain/worker.mjs']
      : [
          'wasm/engine.mjs',
          'wasm/worker.mjs',
          'wasm/kernel.c',
          'wasm/kernel.wasm',
          'wasm/build.json',
        ]),
  );
  const hash = createHash('sha256');
  hash.update('entry\0').update(readFileSync(script));
  for (const path of paths) hash.update(`${path}\0`).update(readFileSync(resolve(root, path)));
  return hash.digest('hex');
}
