import { readFileSync } from 'node:fs';

const profile = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const totals = new Map();
for (let i = 0; i < profile.samples.length; i++) {
  const node = nodes.get(profile.samples[i]);
  const frame = node.callFrame;
  const name = `${frame.functionName || '(anonymous)'} ${frame.url}:${frame.lineNumber + 1}`;
  totals.set(name, (totals.get(name) ?? 0) + profile.timeDeltas[i]);
}
const total = [...totals.values()].reduce((sum, n) => sum + n, 0);
for (const [name, microseconds] of [...totals].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(
    `${((100 * microseconds) / total).toFixed(1)}% ${(microseconds / 1000).toFixed(0)}ms ${name}`,
  );
}
