import { aggregate as phasedAggregate } from '../lib/aggregate.mjs';

// Machine-specific experiment: with PIN_WORKERS mapping worker indexes to
// known P/E cores, select a different cursor count for each core. Each worker
// has its own environment copy; restore it for the single-thread API as well.
export async function aggregate(config) {
  const choices = (process.env.CORE_STREAMS ?? '2,2,2,2,3,3,3,3').split(',');
  if (choices.some((value) => ![1, 2, 3, 4].includes(Number(value)))) {
    throw new Error('CORE_STREAMS must contain cursor counts from 1 to 4');
  }
  const previous = process.env.STREAMS;
  process.env.STREAMS = choices[(config.workerIndex ?? 0) % choices.length];
  try {
    return await phasedAggregate(config);
  } finally {
    if (previous === undefined) delete process.env.STREAMS;
    else process.env.STREAMS = previous;
  }
}
