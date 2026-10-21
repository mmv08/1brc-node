import { parentPort, workerData } from 'node:worker_threads';
import { aggregate } from './aggregate.mjs';

parentPort.postMessage(await aggregate(workerData));
