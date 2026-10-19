import { readFileSync } from 'node:fs';
import { consume } from '../lib/read.mjs';

let compiled;

export async function createKernel(chunkSize) {
  compiled ??= WebAssembly.compile(readFileSync(new URL('kernel.wasm', import.meta.url)));
  const api = new WebAssembly.Instance(await compiled).exports;
  const inputBase = api.input_base() >>> 0;
  const capacity = chunkSize + 256;
  const required = inputBase + capacity;
  if (required > api.memory.buffer.byteLength) {
    api.memory.grow(Math.ceil((required - api.memory.buffer.byteLength) / 65536));
  }
  // Grow before constructing views. All reads then write directly into Wasm
  // memory; neither the input buffer nor result view can be detached mid-file.
  const memory = api.memory.buffer;
  const view = new DataView(memory);
  let allocated = false;
  api.reset();
  return {
    api,
    memory,
    allocateBuffer(length) {
      if (length !== capacity || allocated) throw new Error('Invalid Wasm input allocation');
      allocated = true;
      return Buffer.from(memory, inputBase, capacity);
    },
    makeParser(buffer) {
      if (buffer.buffer !== memory) throw new Error('Input must alias Wasm memory');
      const base = buffer.byteOffset;
      return (start, end) => api.parse_chunk(base + start, base + end);
    },
    rows() {
      const base = api.stations_base() >>> 0;
      const keys = api.keys_base() >>> 0;
      return Array.from({ length: api.station_count() }, (_, id) => {
        const p = base + id * 40;
        const key = view.getUint32(p + 20, true);
        const name = Buffer.from(memory, keys + (key & 0xfffff), key >>> 20).toString('utf8');
        // One BigInt conversion per result station, never per measurement.
        // The challenge's maximum integer sum fits exactly in a JS Number.
        return [
          name,
          view.getInt16(p + 12, true),
          Number(view.getBigInt64(p, true)),
          view.getInt16(p + 14, true),
          view.getUint32(p + 8, true),
        ];
      });
    },
  };
}

export async function aggregate(config) {
  const kernel = await createKernel(config.chunkSize);
  consume(config, kernel.makeParser, kernel.allocateBuffer);
  return kernel.rows();
}
