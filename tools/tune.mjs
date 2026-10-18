import { spawnSync } from 'node:child_process';

// Deliberately sequential: concurrent benchmarks would compete for the CPU.
const file = process.argv[2] ?? 'measurements-100m.txt';
for (const workers of [4, 6, 8]) {
  for (const chunkSize of [128 * 1024, 512 * 1024, 2 * 1024 * 1024]) {
    console.log(`\n${workers} workers, ${chunkSize / 1024} KiB chunks`);
    const child = spawnSync(process.execPath, ['tools/bench.mjs', file], {
      env: { ...process.env, WORKERS: String(workers), CHUNK_BYTES: String(chunkSize) },
      stdio: 'inherit',
    });
    if (child.error) throw child.error;
    if (child.status !== 0) process.exit(child.status ?? 1);
  }
}
