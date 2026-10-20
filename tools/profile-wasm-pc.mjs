import { readFileSync } from 'node:fs';

const [logFile, assemblyFile] = process.argv.slice(2);
if (!assemblyFile) throw new Error('Usage: node tools/profile-wasm-pc.mjs V8_LOG WASM_DISASSEMBLY');
const text = readFileSync(assemblyFile, 'utf8');
const functions = text
  .split('--- WebAssembly code ---')
  .slice(1)
  .map((body) => {
    const name = body.match(/^name: (.+)$/m)?.[1];
    const compiler = body.match(/^compiler: (.+)$/m)?.[1];
    const size = Number(body.match(/^Instructions \(size = (\d+)\)$/m)?.[1]);
    const instructionText = body.split(/^Source positions:$/m)[0];
    const instructions = [
      ...instructionText.matchAll(/^(0x[\da-f]+)\s+([\da-f]+)\s+([\da-f]+)\s+(.+)$/gm),
    ].map((m) => ({
      address: Number(m[1]),
      offset: parseInt(m[2], 16),
      bytes: m[3],
      operation: m[4],
    }));
    const sourceText =
      body.split(/^Source positions:$/m)[1]?.split(/^Safepoints|^RelocInfo/m)[0] || '';
    const sourcePositions = [
      ...sourceText.matchAll(/^[ \t]+([\da-f]+)[ \t]+(\d+)(?:[ \t]+(\w+))?[ \t]*$/gm),
    ].map((m) => ({
      machineOffset: parseInt(m[1], 16),
      wasmOffsetAsReported: Number(m[2]),
      ...(m[3] ? { kind: m[3] } : {}),
    }));
    return {
      name,
      compiler,
      start: instructions[0]?.address,
      size,
      instructions,
      sourcePositions,
      ticks: 0,
      positions: new Map(),
    };
  })
  .filter((f) => f.start !== undefined);
// Address-only attribution is valid only while these code ranges are unique.
// Refuse ambiguous dumps instead of assigning recycled addresses to old code.
const ordered = functions.toSorted((a, b) => a.start - b.start);
for (let i = 1; i < ordered.length; i++) {
  if (ordered[i].start < ordered[i - 1].start + ordered[i - 1].size)
    throw new Error('Overlapping code ranges require lifetime-aware attribution');
}
const log = readFileSync(logFile, 'utf8');
if (/^code-move,/m.test(log)) throw new Error('Code moves require lifetime-aware attribution');
const ticks = log.split('\n').filter((line) => line.startsWith('tick,'));
let mapped = 0;
for (const line of ticks) {
  const pc = Number(line.split(',')[1]);
  const fn = functions.find((f) => pc >= f.start && pc < f.start + f.size);
  if (!fn) continue;
  mapped++;
  fn.ticks++;
  let low = 0;
  let high = fn.instructions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (fn.instructions[middle].address <= pc) low = middle + 1;
    else high = middle;
  }
  const index = low - 1;
  fn.positions.set(index, (fn.positions.get(index) || 0) + 1);
}
const result = {
  interpretation: [
    'Only the primary program counter from each V8 tick is attributed; callers are not counted',
    'PC locations are statistical samples, not retired instructions or cache-miss counters',
    'Intervals use the printed machine-code instruction size; mapping requires log and disassembly from the same process',
    'Wasm source positions are copied from V8 disassembly and may refer to function-relative bytecode offsets',
  ],
  logFile,
  assemblyFile,
  totalTicks: ticks.length,
  mappedWasmTicks: mapped,
  functions: functions
    .map((fn) => ({
      name: fn.name,
      compiler: fn.compiler,
      start: `0x${fn.start.toString(16)}`,
      size: fn.size,
      ticks: fn.ticks,
      percentAllTicks: (100 * fn.ticks) / ticks.length,
      positions: [...fn.positions]
        .map(([index, count]) => {
          const instruction = fn.instructions[index];
          const source = fn.sourcePositions.findLast((p) => p.machineOffset <= instruction.offset);
          return {
            count,
            percentFunctionTicks: (100 * count) / fn.ticks,
            ...instruction,
            address: `0x${instruction.address.toString(16)}`,
            source,
            context: fn.instructions.slice(Math.max(0, index - 3), index + 4).map((i) => ({
              ...i,
              address: `0x${i.address.toString(16)}`,
            })),
          };
        })
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.ticks - a.ticks),
};
console.log(JSON.stringify(result, null, 2));
