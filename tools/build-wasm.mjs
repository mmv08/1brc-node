import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { addBranchHints } from './branch-hints.mjs';

const clang = process.env.CLANG ?? 'clang';
const linker =
  process.env.WASM_LD ??
  (existsSync('/usr/lib64/rocm/llvm/bin/lld') ? '/usr/lib64/rocm/llvm/bin/lld' : 'wasm-ld');
const flavor = linker.endsWith('/lld') || linker === 'lld' ? ['-flavor', 'wasm'] : [];
mkdirSync('results/build', { recursive: true });
const compile = [
  '--target=wasm32',
  '-std=c11',
  '-O3',
  '-ffreestanding',
  '-fno-builtin',
  '-nostdlib',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-msimd128',
  '-c',
  'wasm/kernel.c',
  '-o',
  'results/build/kernel.o',
];
const link = [
  ...flavor,
  '--no-entry',
  '--export-memory',
  '--initial-memory=4194304',
  '--max-memory=1073741824',
  '-z',
  'stack-size=65536',
  'results/build/kernel.o',
  '-o',
  'results/build/kernel-linked.wasm',
];
execFileSync(clang, compile, { stdio: 'inherit' });
execFileSync(linker, link, { stdio: 'inherit' });
// The linked module keeps function names only to locate cold callees; the
// shipped module drops every custom section except the derived branch hints.
const source = readFileSync('wasm/kernel.c', 'utf8');
const cold = [
  ...source.matchAll(/__attribute__\(\(noinline, cold\)\)\s+static\s+[\w\s]+?\**(\w+)\(/g),
].map((match) => match[1]);
const hinted = addBranchHints(readFileSync('results/build/kernel-linked.wasm'), cold);
writeFileSync('wasm/kernel.wasm', hinted.bytes);
chmodSync('wasm/kernel.wasm', 0o644);
const bytes = readFileSync('wasm/kernel.wasm');
if (WebAssembly.Module.imports(new WebAssembly.Module(bytes)).length) {
  throw new Error('Kernel must not import libc or WASI');
}
const report = {
  compiler: execFileSync(clang, ['--version'], { encoding: 'utf8' }).trim(),
  linker: execFileSync(linker, [...flavor, '--version'], { encoding: 'utf8' }).trim(),
  sourceSha256: createHash('sha256').update(readFileSync('wasm/kernel.c')).digest('hex'),
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
  compile,
  link,
  cold,
  branchHints: hinted.summary,
};
writeFileSync('wasm/build.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(`kernel: ${bytes.length} bytes, SIMD, no imports`);
