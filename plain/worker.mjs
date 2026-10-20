import { parentPort, workerData } from 'node:worker_threads';
import { aggregate } from './lib/aggregate.mjs';

parentPort.postMessage(await aggregate(workerData));
