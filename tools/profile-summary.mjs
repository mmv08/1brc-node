// Read-only CPU-profile aggregation. These are sampled thread-time intervals,
// not CPU counters: blocking and descheduling can inflate timeDeltas.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const arguments_ = process.argv.slice(2);
if (!arguments_.length) throw new Error('Usage: node summarize.mjs FILE_OR_DIRECTORY ...');
const files = arguments_.flatMap((argument) => {
  const path = resolve(argument);
  return statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((name) => name.endsWith('.cpuprofile'))
        .map((name) => resolve(path, name))
    : [path];
});
if (!files.length) throw new Error('No CPU profiles found');
const self = new Map();
const inclusive = new Map();
const wasmPositions = new Map();
const sourcePositions = new Map();
const threads = [];
let allSamples = 0;
let allIntervalsUs = 0;

function frameKey(frame, positions = false) {
  return JSON.stringify([
    frame.functionName || '(anonymous)',
    frame.url || '',
    frame.lineNumber,
    positions ? frame.columnNumber : null,
  ]);
}
function add(map, key, interval) {
  const row = map.get(key) || { samples: 0, sampledIntervalUs: 0 };
  row.samples++;
  row.sampledIntervalUs += interval;
  map.set(key, row);
}
function describe(map, sampleTotal, intervalTotal, limit = 40) {
  return [...map]
    .map(([key, counts]) => {
      const [functionName, url, zeroBasedLine, zeroBasedColumn] = JSON.parse(key);
      return {
        functionName,
        url,
        zeroBasedLine,
        ...(zeroBasedColumn === null ? {} : { zeroBasedColumn }),
        ...counts,
        percentSamples: (100 * counts.samples) / sampleTotal,
        percentIntervals: (100 * counts.sampledIntervalUs) / intervalTotal,
      };
    })
    .sort((a, b) => b.samples - a.samples)
    .slice(0, limit);
}
for (const file of files) {
  const profile = JSON.parse(readFileSync(file, 'utf8'));
  const samples = profile.samples || [];
  const deltas = profile.timeDeltas || [];
  if (samples.length !== deltas.length) throw new Error(`${file}: sample/delta length mismatch`);
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) {
    for (const child of node.children || []) parents.set(child, node.id);
  }
  const localSelf = new Map();
  const localInclusive = new Map();
  const lineTicks = [];
  for (const node of profile.nodes) {
    if (node.positionTicks?.length) {
      lineTicks.push({ callFrame: node.callFrame, positionTicks: node.positionTicks });
      for (const position of node.positionTicks) {
        const key = JSON.stringify([
          node.callFrame.functionName || '(anonymous)',
          node.callFrame.url || '',
          position.line,
        ]);
        sourcePositions.set(key, (sourcePositions.get(key) || 0) + position.ticks);
      }
    }
  }
  let intervalTotal = 0;
  let largeIntervals = 0;
  let negativeIntervals = 0;
  let negativeIntervalSum = 0;
  const sorted = deltas.toSorted((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  for (let i = 0; i < samples.length; i++) {
    const interval = deltas[i];
    if (interval < 0) {
      negativeIntervals++;
      negativeIntervalSum += interval;
    }
    intervalTotal += interval;
    if (interval > Math.max(5 * median, 5000)) largeIntervals++;
    const node = nodes.get(samples[i]);
    if (!node) throw new Error(`${file}: missing sample node ${samples[i]}`);
    const key = frameKey(node.callFrame);
    add(self, key, interval);
    add(localSelf, key, interval);
    if (
      node.callFrame.url.startsWith('wasm:') ||
      node.callFrame.functionName.startsWith('wasm-function[')
    ) {
      add(wasmPositions, frameKey(node.callFrame, true), interval);
    }
    const seen = new Set();
    let id = node.id;
    while (id !== undefined) {
      const ancestor = nodes.get(id);
      const ancestorKey = frameKey(ancestor.callFrame);
      if (!seen.has(ancestorKey)) {
        add(inclusive, ancestorKey, interval);
        add(localInclusive, ancestorKey, interval);
        seen.add(ancestorKey);
      }
      id = parents.get(id);
    }
  }
  allSamples += samples.length;
  allIntervalsUs += intervalTotal;
  const tid = basename(file).match(/\.(\d+)\.\d+\.cpuprofile$/)?.[1];
  threads.push({
    file,
    ...(tid === undefined ? {} : { threadIdFromFilename: Number(tid) }),
    startTimeUs: profile.startTime,
    endTimeUs: profile.endTime,
    profileSpanUs: profile.endTime - profile.startTime,
    samples: samples.length,
    sampledIntervalUs: intervalTotal,
    medianIntervalUs: median,
    p99IntervalUs: sorted[Math.floor(sorted.length * 0.99)] || 0,
    maxIntervalUs: sorted.at(-1) || 0,
    intervalsOverFiveTimesMedianOr5ms: largeIntervals,
    negativeIntervals,
    negativeIntervalSumUs: negativeIntervalSum,
    self: describe(localSelf, samples.length, intervalTotal, 20),
    inclusive: describe(localInclusive, samples.length, intervalTotal, 20),
    positionTicks: lineTicks,
  });
}
console.log(
  JSON.stringify(
    {
      interpretation: [
        'samples are raw statistical samples; sampledIntervalUs weights them by observed timeDeltas',
        'summed worker intervals overlap and cannot be interpreted as process elapsed time',
        'timeDeltas include scheduling and profiler delays; interval sums are not CPU counters',
        'negative deltas, when supplied by V8, are retained as reported and counted per thread; prefer sample counts when intervals are irregular',
        'inclusive frame rows overlap with one another and must not be added',
        'Wasm callFrame columns are retained as reported; they may identify function entry rather than sampled instruction',
        'positionTicks are preserved separately if V8 supplied per-line samples',
      ],
      profiles: threads.length,
      samples: allSamples,
      sampledIntervalUs: allIntervalsUs,
      self: describe(self, allSamples, allIntervalsUs, 60),
      inclusive: describe(inclusive, allSamples, allIntervalsUs, 60),
      wasmPositions: describe(wasmPositions, allSamples, allIntervalsUs, 100),
      sourcePositions: [...sourcePositions]
        .map(([key, ticks]) => {
          const [functionName, url, lineOneBased] = JSON.parse(key);
          return {
            functionName,
            url,
            lineOneBased,
            ticks,
            percentSamples: (100 * ticks) / allSamples,
          };
        })
        .sort((a, b) => b.ticks - a.ticks)
        .slice(0, 100),
      threads,
    },
    null,
    2,
  ),
);
