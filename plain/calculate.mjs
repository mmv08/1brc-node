import { pathToFileURL } from 'node:url';
import { createCalculator } from '../lib/calculate.mjs';

export const calculate = createCalculator(
  128 * 1024,
  new URL('./lib/aggregate.mjs', import.meta.url),
  new URL('./worker.mjs', import.meta.url),
);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Start worker initialization while the main thread loads the formatter.
    const [rows, { format }] = await Promise.all([
      calculate(process.argv[2] ?? 'measurements.txt'),
      import('../lib/format.mjs'),
    ]);
    process.stdout.write(format(rows));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
