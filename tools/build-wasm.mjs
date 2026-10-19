import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { variants } from '../wasm/variants.mjs';

const clang = process.env.CLANG ?? 'clang';
const linker =
  process.env.WASM_LD ??
  (existsSync('/usr/lib64/rocm/llvm/bin/lld') ? '/usr/lib64/rocm/llvm/bin/lld' : 'wasm-ld');
const flavor = linker.endsWith('/lld') || linker === 'lld' ? ['-flavor', 'wasm'] : [];
mkdirSync('results/build', { recursive: true });
mkdirSync('wasm', { recursive: true });
const report = {
  sourceSha256: createHash('sha256').update(readFileSync('wasm/kernel.c')).digest('hex'),
  sources: Object.fromEntries(
    [...new Set(variants.map((v) => v.source))].map((source) => [
      source,
      createHash('sha256').update(readFileSync(source)).digest('hex'),
    ]),
  ),
  compiler: execFileSync(clang, ['--version'], { encoding: 'utf8' }).trim(),
  linker: execFileSync(linker, [...flavor, '--version'], { encoding: 'utf8' }).trim(),
  modules: [],
};

for (const definition of variants) {
  const { variant, simd, source, features, optimization } = definition;
  const object = `results/build/kernel-${variant}.o`;
  const binary = `wasm/kernel-${variant}.wasm`;
  const compile = [
    '--target=wasm32',
    '-std=c11',
    optimization,
    '-ffreestanding',
    '-fno-builtin',
    '-nostdlib',
    '-Wall',
    '-Wextra',
    '-Werror',
    simd ? '-msimd128' : '-mno-simd128',
    `-DUSE_SIMD=${simd ? 1 : 0}`,
    `-DPOINTER_BUCKETS=${definition.pointers ? 1 : 0}`,
    ...(definition.small ? ['-DHASH_MULTIPLIER=0x1e35a7bdULL'] : []),
    ...(definition.collision ? ['-DHASH_TEST_MASK=0'] : []),
    ...Object.entries(features).map(([key, value]) => `-D${key}=${value}`),
    '-c',
    source,
    '-o',
    object,
  ];
  execFileSync(clang, compile, { stdio: 'inherit' });
  const link = [
    ...flavor,
    '--no-entry',
    '--export-memory',
    '--strip-all',
    '--initial-memory=2097152',
    '--max-memory=1073741824',
    '-z',
    'stack-size=65536',
    object,
    '-o',
    binary,
  ];
  execFileSync(linker, link, { stdio: 'inherit' });
  const bytes = readFileSync(binary);
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length !== 0)
    throw new Error('Kernel must not import libc or WASI');
  report.modules.push({
    ...definition,
    variant,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    compile,
    link,
  });
  console.log(`${variant}: ${bytes.length} bytes, no imports`);
}
writeFileSync('wasm/build.json', `${JSON.stringify(report, null, 2)}\n`);
