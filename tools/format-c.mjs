import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const tool =
  process.env.CLANG_FORMAT ??
  (existsSync('/usr/lib64/rocm/llvm/bin/clang-format')
    ? '/usr/lib64/rocm/llvm/bin/clang-format'
    : 'clang-format');
const args = process.argv.includes('--check') ? ['--dry-run', '--Werror'] : ['-i'];
execFileSync(tool, [...args, 'wasm/kernel.c'], { stdio: 'inherit' });
