import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export function nodeRuntime() {
  const local = resolve('.runtimes/node-v26.12.0/bin/node');
  return process.env.NODE_BIN ?? (existsSync(local) ? local : process.execPath);
}

export function nodeFlags(env) {
  if (env.FLAGS !== undefined) return env.FLAGS.split(/\s+/).filter(Boolean);
  return [];
}

export function sourceHash(engine = 'wasm', script = 'calculate.mjs') {
  const root = dirname(resolve(script));
  const paths = [basename(script)];
  if (basename(script) === 'calculate.mjs') {
    paths.push(
      ...['lib/aggregate.mjs', 'lib/format.mjs', 'lib/parse-utils.mjs', 'lib/read.mjs'].filter(
        (path) => existsSync(resolve(root, path)),
      ),
    );
    if (engine === 'wasm')
      paths.push('wasm/engine.mjs', 'wasm/kernel.c', 'wasm/kernel.wasm', 'wasm/build.json');
  }
  const hash = createHash('sha256');
  for (const path of paths) hash.update(`${path}\0`).update(readFileSync(resolve(root, path)));
  return hash.digest('hex');
}
