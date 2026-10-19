import { parentPort, workerData } from 'node:worker_threads';
import { aggregate } from './engine.mjs';

parentPort.postMessage(await aggregate(workerData));
