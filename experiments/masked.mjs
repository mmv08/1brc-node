import { aggregate as flatAggregate } from './flat.mjs';

export function aggregate(config) {
  return flatAggregate({ ...config, masked: true });
}
