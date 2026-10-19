import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const inliningFlags = [
  '--max-inlined-bytecode-size=1000',
  '--max-inlined-bytecode-size-cumulative=4000',
];

export function nodeRuntime() {
  const local = resolve('.runtimes/node-v26.12.0/bin/node');
  return process.env.NODE_BIN ?? (existsSync(local) ? local : process.execPath);
}

export function nodeFlags(env) {
  if (env.FLAGS !== undefined) return env.FLAGS.split(/\s+/).filter(Boolean);
  return env.ENGINE === 'wasm' ? [] : inliningFlags;
}

export function sourceHash(engine = 'phased', script = 'calculate.mjs') {
  const paths = [script];
  if (script === 'calculate.mjs') {
    paths.push('lib/aggregate.mjs', 'lib/format.mjs', 'lib/parse-utils.mjs', 'lib/read.mjs');
    if (engine === 'wasm')
      paths.push('wasm/engine.mjs', 'wasm/kernel.c', 'wasm/kernel.wasm', 'wasm/build.json');
  }
  const hash = createHash('sha256');
  for (const path of paths) hash.update(`${path}\0`).update(readFileSync(path));
  return hash.digest('hex');
}
