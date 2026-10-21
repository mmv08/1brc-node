// Copied into an isolated diagnostic tree by profile-phases.mjs. Never imported
// by a production solver. CPU values cover this thread, not all worker threads.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isMainThread, threadId } from 'node:worker_threads';

const directory = process.env.PROFILE_PHASE_DIR;
if (!directory) throw new Error('PROFILE_PHASE_DIR is required');
if (!process.threadCpuUsage) throw new Error('This diagnostic needs process.threadCpuUsage');
const now = () => Number(process.hrtime.bigint()) / 1e6;
// Optional V8 diagnostic, requiring --allow-natives-syntax. This only observes
// attached code before/after a call; it cannot identify on-stack replacement
// within that call or measure background compiler CPU time.
const tierStatus =
  process.env.PROFILE_TIER === '1'
    ? new Function('fn', 'return %GetOptimizationStatus(fn);')
    : null;
const marks = [];
const phases = {};
const workers = [];

export function phaseMark(name) {
  const cpu = process.threadCpuUsage();
  marks.push({ name, atMs: now(), userUs: cpu.user, systemUs: cpu.system });
}

export function phaseStart(parser) {
  const tier = tierStatus && parser ? tierStatus(parser) : undefined;
  const cpu = process.threadCpuUsage();
  return { atMs: now(), userUs: cpu.user, systemUs: cpu.system, tier };
}

export function phaseEnd(name, start, bytes = 0, parser) {
  const cpu = process.threadCpuUsage();
  const end = now();
  phases[name] ??= {
    calls: 0,
    bytes: 0,
    wallMs: 0,
    userUs: 0,
    systemUs: 0,
    firstMs: start.atMs,
    lastMs: end,
  };
  const phase = phases[name];
  phase.calls++;
  phase.bytes += bytes;
  phase.wallMs += end - start.atMs;
  phase.userUs += cpu.user - start.userUs;
  phase.systemUs += cpu.system - start.systemUs;
  phase.lastMs = end;
  if (bytes) {
    phase.windows ??= {};
    const label =
      phase.calls <= 8
        ? '1-8'
        : phase.calls <= 32
          ? '9-32'
          : phase.calls <= 128
            ? '33-128'
            : phase.calls <= 512
              ? '129-512'
              : phase.calls <= 2048
                ? '513-2048'
                : '2049+';
    phase.windows[label] ??= { calls: 0, bytes: 0, wallMs: 0, userUs: 0, systemUs: 0 };
    const window = phase.windows[label];
    window.calls++;
    window.bytes += bytes;
    window.wallMs += end - start.atMs;
    window.userUs += cpu.user - start.userUs;
    window.systemUs += cpu.system - start.systemUs;
  }
  if (start.tier !== undefined) {
    const after = tierStatus(parser);
    phase.tiers ??= {};
    const label = `${start.tier}->${after}`;
    phase.tiers[label] ??= {
      calls: 0,
      bytes: 0,
      wallMs: 0,
      userUs: 0,
      systemUs: 0,
      firstMs: start.atMs,
      lastMs: end,
    };
    const tier = phase.tiers[label];
    tier.calls++;
    tier.bytes += bytes;
    tier.wallMs += end - start.atMs;
    tier.userUs += cpu.user - start.userUs;
    tier.systemUs += cpu.system - start.systemUs;
    tier.lastMs = end;
  }
}

export function phaseWorker(worker) {
  const id = worker.threadId;
  workers.push({ id, event: 'constructed', atMs: now() });
  for (const event of ['online', 'message', 'exit']) {
    worker.once(event, () => workers.push({ id, event, atMs: now() }));
  }
}

phaseMark('runtimeImported');
process.once('exit', () => {
  phaseMark('exit');
  writeFileSync(
    resolve(directory, `${process.pid}-${threadId}.json`),
    `${JSON.stringify({
      pid: process.pid,
      threadId,
      isMainThread,
      engine: process.env.ENGINE,
      requestedWorkers: Number(process.env.WORKERS),
      marks,
      phases,
      workers,
    })}\n`,
  );
});
