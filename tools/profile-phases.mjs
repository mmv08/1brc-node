// Build an isolated, instrumented copy. The parser hot loops and Wasm binary
// stay byte-for-byte unchanged; probes surround chunk reads/parses and phases.
// Usage: node tools/profile-phases.mjs results/phase-copy
// Then set PROFILE_PHASE_DIR to an existing output directory and benchmark the
// copied calculate.mjs / plain/calculate.mjs with tools/compare.mjs.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sourceHash } from './benchmark-config.mjs';

const destination = resolve(process.argv[2] ?? 'results/phase-copy');
mkdirSync(dirname(destination), { recursive: true });
mkdirSync(destination); // Refuse to overwrite an existing experiment.
const originalHashes = { node: sourceHash('node'), wasm: sourceHash('wasm') };
const files = [
  'calculate.mjs',
  'lib/read.mjs',
  'lib/format.mjs',
  'plain/calculate.mjs',
  'plain/worker.mjs',
  'plain/lib/aggregate.mjs',
  'plain/lib/read.mjs',
  'plain/lib/parse-utils.mjs',
  'wasm/engine.mjs',
  'wasm/worker.mjs',
  'wasm/kernel.c',
  'wasm/kernel.wasm',
  'wasm/build.json',
];
for (const file of files) {
  const target = resolve(destination, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(file));
}
const runtime = readFileSync(new URL('profile-phase-runtime.mjs', import.meta.url));
writeFileSync(resolve(destination, 'profile-phase-runtime.mjs'), runtime);

function edit(file, importPath, changes) {
  const target = resolve(destination, file);
  let text = readFileSync(target, 'utf8');
  for (const [before, after] of changes) {
    if (text.split(before).length !== 2) throw new Error(`Ambiguous/missing marker in ${file}`);
    text = text.replace(before, after);
  }
  writeFileSync(
    target,
    `import { phaseMark, phaseStart, phaseEnd, phaseWorker } from '${importPath}';\n${text}`,
  );
}

for (const [file, path] of [
  ['calculate.mjs', './profile-phase-runtime.mjs'],
  ['plain/calculate.mjs', '../profile-phase-runtime.mjs'],
]) {
  edit(file, path, [
    ['  const fd = openSync', "  phaseMark('calculateStart');\n  const fd = openSync"],
    [
      '              threads.push(worker);',
      '              phaseWorker(worker);\n              threads.push(worker);',
    ],
    [
      '      const merged = new Map();',
      "      phaseMark('mergeStart');\n      const merged = new Map();",
    ],
    [
      '      return [...merged.values()];',
      "      phaseMark('mergeEnd');\n      return [...merged.values()];",
    ],
    [
      '    process.stdout.write(format(rows));',
      "    phaseMark('formatStart');\n    const output = format(rows);\n    phaseMark('outputStart');\n    process.stdout.write(output);\n    phaseMark('outputEnd');",
    ],
  ]);
}
for (const file of ['plain/worker.mjs', 'wasm/worker.mjs']) {
  edit(file, '../profile-phase-runtime.mjs', [
    [
      'parentPort.postMessage(await aggregate(workerData));',
      "phaseMark('aggregateStart');\nconst rows = await aggregate(workerData);\nphaseMark('aggregateEnd');\nparentPort.postMessage(rows);\nphaseMark('postMessageEnd');",
    ],
  ]);
}
edit('plain/lib/read.mjs', '../../profile-phase-runtime.mjs', [
  [
    '    parser(start, end);',
    "    const parseStarted = phaseStart(parser);\n    parser(start, end);\n    phaseEnd('parse', parseStarted, end - start, parser);",
  ],
  [
    '          const n = readSync',
    '          const readStarted = phaseStart();\n          const n = readSync',
  ],
  [
    '          if (!n) throw',
    "          phaseEnd('read', readStarted, n);\n          if (!n) throw",
  ],
]);
edit('lib/read.mjs', '../profile-phase-runtime.mjs', [
  ['      const n = readSync', '      const readStarted = phaseStart();\n      const n = readSync'],
  ['      if (!n) throw', "      phaseEnd('read', readStarted, n);\n      if (!n) throw"],
  [
    '    parse(start, end);',
    "    const parseStarted = phaseStart();\n    parse(start, end);\n    phaseEnd('parse', parseStarted, end - start);",
  ],
]);
edit('plain/lib/aggregate.mjs', '../../profile-phase-runtime.mjs', [
  [
    '  await consume(config, makeParser);\n  return Array.from',
    "  const consumeStarted = phaseStart();\n  await consume(config, makeParser);\n  phaseEnd('consume', consumeStarted);\n  const exportStarted = phaseStart();\n  const rows = Array.from",
  ],
  ['  });\n}', "  });\n  phaseEnd('export', exportStarted);\n  return rows;\n}"],
]);
edit('wasm/engine.mjs', '../profile-phase-runtime.mjs', [
  [
    '  const kernel = await createKernel(config.chunkSize);\n  consume(config, kernel.makeParser, kernel.allocateBuffer);\n  return kernel.rows();',
    "  const kernelStarted = phaseStart();\n  const kernel = await createKernel(config.chunkSize);\n  phaseEnd('kernel', kernelStarted);\n  const consumeStarted = phaseStart();\n  consume(config, kernel.makeParser, kernel.allocateBuffer);\n  phaseEnd('consume', consumeStarted);\n  const exportStarted = phaseStart();\n  const rows = kernel.rows();\n  phaseEnd('export', exportStarted);\n  return rows;",
  ],
]);
const manifest = {
  originalHashes,
  instrumentedHashes: {
    node: sourceHash('node', resolve(destination, 'plain/calculate.mjs')),
    wasm: sourceHash('wasm', resolve(destination, 'calculate.mjs')),
  },
  probeSha256: createHash('sha256').update(runtime).digest('hex'),
  generatorSha256: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  limitations: [
    'Diagnostic durations include probe overhead; compare with uninstrumented controls.',
    'Concurrent worker wall spans must not be added as whole-process elapsed time.',
    'Thread CPU excludes background compiler threads; kernel wall time includes compilation waits.',
    'Phase CPU is sampled with threadCpuUsage, not hardware performance counters.',
    'Consume includes read, parse, scheduling and instrumentation; phases are nested.',
    'Only the default synchronous reader is instrumented completely.',
    'Per-thread JSON is written at exit, after the recorded exit mark.',
  ],
};
writeFileSync(
  resolve(destination, 'phase-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(destination);
