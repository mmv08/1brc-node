import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

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
  // "phased" supports comparisons against historical plain-JavaScript worktrees.
  return ['node', 'phased'].includes(env.ENGINE)
    ? [
        '--max-inlined-bytecode-size=1000',
        '--max-inlined-bytecode-size-cumulative=4000',
        '--v8-pool-size=8',
      ]
    : [];
}

// Preserve inherited runtime/parser controls as well as per-case overrides.
// Omitted keys use the defaults of the measured source, including older checkouts.
export function benchmarkEnv(env) {
  const keys = [
    'ENGINE',
    'WORKERS',
    'CHUNK_BYTES',
    'FLAGS',
    'STREAMS',
    'TABLE_BITS',
    'TEMPERATURE',
    'NAME_COMPARE',
    'IO',
    'PRIVATE_FD',
    'MACRO_BYTES',
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
  const root = dirname(resolve(script));
  const paths = [basename(script)];
  if (basename(script) === 'calculate.mjs') {
    paths.push(
      ...[
        'lib/aggregate.mjs',
        'lib/format.mjs',
        'lib/parse-utils.mjs',
        'lib/read.mjs',
        'worker.mjs',
      ].filter((path) => existsSync(resolve(root, path))),
    );
    if (engine === 'wasm') {
      paths.push(
        ...['wasm/engine.mjs', 'wasm/worker.mjs'].filter((path) => existsSync(resolve(root, path))),
        'wasm/kernel.c',
        'wasm/kernel.wasm',
        'wasm/build.json',
      );
    } else if (!existsSync(resolve(root, 'lib/format.mjs'))) {
      // The integrated plain solver shares the root formatter, not Wasm code.
      paths.push('../lib/format.mjs');
    }
  }
  const hash = createHash('sha256');
  for (const path of paths) hash.update(`${path}\0`).update(readFileSync(resolve(root, path)));
  return hash.digest('hex');
}
